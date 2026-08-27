/**
 * THE single path to CAPTURED (spec §6 / transition T5).
 *
 * Called by: the PG webhook, the browser callback-hint, /request's
 * reconcile-before-render, and the sweeper. All four run identical logic; the
 * status CAS makes concurrent/duplicate invocation harmless.
 *
 * Authority order (never reordered):
 *   1. server-side re-fetch from the PG   (the webhook is only a trigger)
 *   2. currency must match exactly
 *   3. amount must match, OR be lower WITH verified offer evidence + floor
 *   4. atomic CAS ATTEMPT_INITIATED -> CAPTURED (loser no-ops)
 */
import {
  AttemptStatus,
  RequestStatus,
  type PaymentAttempt,
} from "@prisma/client";
import prisma from "../../db.server";
import { getAdapter } from "../pg/index.server";
import { getPgCredentials, getShopSettings } from "../shops/shop.server";
import { errorFields, logger } from "../../utils/logger.server";
import { randomToken } from "../../utils/crypto.server";
import { fulfillCapturedRequest } from "./order.server";

export type ResolveOutcome =
  | "CAPTURED"
  | "FAILED"
  | "PENDING"
  | "ABANDONED"
  | "DUPLICATE_CAPTURE"
  | "AMOUNT_MISMATCH"
  | "NOOP";

function mintAppOrderId(): string {
  return `SPX-${randomToken(8)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 10)}`;
}

export async function resolveAttempt(
  attemptId: string,
): Promise<ResolveOutcome> {
  const attempt = await prisma.paymentAttempt.findUnique({
    where: { id: attemptId },
    include: { request: { include: { shop: true } } },
  });
  if (!attempt) return "NOOP";
  if (attempt.status !== AttemptStatus.INITIATED) return "NOOP"; // already resolved

  const { request } = attempt;
  const shop = request.shop;
  const credentials = await getPgCredentials(shop.id, attempt.pg);
  const adapter = getAdapter(attempt.pg);

  const payment = await adapter.fetchPayment(attempt.pgOrderId, credentials);

  // --- Not captured paths -------------------------------------------------
  if (payment.status === "PENDING") return "PENDING";

  if (payment.status === "NOT_ATTEMPTED") {
    await markAttemptTerminal(attempt, AttemptStatus.ABANDONED, payment);
    await releaseRequestToAwaiting(request.id);
    return "ABANDONED";
  }

  if (payment.status === "FAILED") {
    await markAttemptTerminal(attempt, AttemptStatus.FAILED, payment);
    await releaseRequestToAwaiting(request.id);
    return "FAILED";
  }

  // --- CAPTURED: validate before promoting --------------------------------
  if (payment.currency && payment.currency !== attempt.currency) {
    logger.error("resolver.currency_mismatch", {
      attemptId,
      expected: attempt.currency,
      got: payment.currency,
    });
    await flagForManualReview(attempt, "CURRENCY_MISMATCH", payment);
    return "AMOUNT_MISMATCH";
  }

  const capturedMinor = payment.amountMinor ?? 0n;
  const expectedMinor = attempt.amountMinor;
  const settings = getShopSettings(shop);
  const floorMinor =
    (expectedMinor * BigInt(Math.round(settings.min_capture_pct))) / 100n;

  const exact = capturedMinor === expectedMinor;
  const legitimateOffer =
    capturedMinor < expectedMinor &&
    payment.offerApplied &&
    capturedMinor >= floorMinor;

  if (!exact && !legitimateOffer) {
    logger.error("resolver.amount_mismatch", {
      attemptId,
      expected: String(expectedMinor),
      captured: String(capturedMinor),
      offerApplied: payment.offerApplied,
    });
    await flagForManualReview(attempt, "AMOUNT_MISMATCH", payment);
    return "AMOUNT_MISMATCH";
  }

  // --- Atomic CAS: only one caller promotes -------------------------------
  const appOrderId = mintAppOrderId();
  const won = await prisma.checkoutRequest.updateMany({
    where: { id: request.id, status: RequestStatus.ATTEMPT_INITIATED },
    data: { status: RequestStatus.CAPTURED, appOrderId },
  });

  if (won.count === 0) {
    // Another attempt already captured this request → late capture on an
    // abandoned attempt. Money is real but must not create a second order.
    logger.warn("resolver.duplicate_capture", {
      attemptId,
      requestId: request.id,
    });
    await prisma.paymentAttempt.update({
      where: { id: attempt.id },
      data: {
        status: AttemptStatus.CAPTURED,
        pgPaymentId: payment.pgPaymentId,
        amountCapturedMinor: capturedMinor,
        refundStatus: "PENDING_MANUAL",
        failureCode: "DUPLICATE_CAPTURE",
        resolvedAt: new Date(),
      },
    });
    return "DUPLICATE_CAPTURE";
  }

  await prisma.paymentAttempt.update({
    where: { id: attempt.id },
    data: {
      status: AttemptStatus.CAPTURED,
      pgPaymentId: payment.pgPaymentId,
      amountCapturedMinor: capturedMinor,
      resolvedAt: new Date(),
    },
  });

  logger.info("resolver.captured", {
    attemptId,
    requestId: request.id,
    appOrderId,
    capturedMinor: String(capturedMinor),
    offerApplied: payment.offerApplied,
  });

  // T8/T9 — create the Shopify order. Failure parks the request in RECONCILING
  // and the tick retries; it never throws back to the caller, because the
  // capture itself already succeeded and must not be reported as a failure.
  await fulfillCapturedRequest(request.id).catch((error) =>
    logger.error("resolver.fulfil_failed", {
      requestId: request.id,
      ...errorFields(error),
    }),
  );

  return "CAPTURED";
}

async function markAttemptTerminal(
  attempt: PaymentAttempt,
  status: AttemptStatus,
  payment: {
    failureCode?: string | null;
    failureReason?: string | null;
    charged?: boolean | null;
    pgPaymentId: string | null;
  },
): Promise<void> {
  await prisma.paymentAttempt.update({
    where: { id: attempt.id },
    data: {
      status,
      pgPaymentId: payment.pgPaymentId,
      failureCode: payment.failureCode ?? null,
      failureReason: payment.failureReason ?? null,
      charged: payment.charged ?? null,
      resolvedAt: new Date(),
    },
  });
}

/** T6/T7: a dead attempt returns the request to PG selection for retry. */
async function releaseRequestToAwaiting(requestId: string): Promise<void> {
  await prisma.checkoutRequest.updateMany({
    where: { id: requestId, status: RequestStatus.ATTEMPT_INITIATED },
    data: { status: RequestStatus.AWAITING_PAYMENT },
  });
}

async function flagForManualReview(
  attempt: PaymentAttempt,
  code: string,
  payment: { pgPaymentId: string | null; amountMinor: bigint | null },
): Promise<void> {
  await prisma.paymentAttempt.update({
    where: { id: attempt.id },
    data: {
      status: AttemptStatus.CAPTURED,
      pgPaymentId: payment.pgPaymentId,
      amountCapturedMinor: payment.amountMinor,
      failureCode: code,
      refundStatus: "PENDING_MANUAL",
      resolvedAt: new Date(),
    },
  });
}

/** Resolve by PG order id — the entry point webhooks use. */
export async function resolveByPgOrderId(
  pg: PaymentAttempt["pg"],
  pgOrderId: string,
): Promise<ResolveOutcome> {
  const attempt = await prisma.paymentAttempt.findUnique({
    where: { pg_pgOrderId: { pg, pgOrderId } },
  });
  if (!attempt) {
    logger.warn("resolver.unknown_pg_order", { pg, pgOrderId });
    return "NOOP";
  }
  return resolveAttempt(attempt.id);
}
