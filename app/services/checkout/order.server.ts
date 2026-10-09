/**
 * Orchestrates CAPTURED → ORDER_CREATED (T8), with RECONCILING (T9/T10) and
 * FAILED_TERMINAL (T11) as the failure lane.
 *
 * The reconciling lane exists because after capture, money is real: an order
 * MUST eventually exist, or a human must refund. Nothing here may silently
 * give up, and nothing here may create a second order for one payment.
 *
 * Duplicate protection is three layers deep:
 *   1. An atomic DB claim, so concurrent callers (webhook + tick, or two tick
 *      instances) can't both enter the create path.
 *   2. An idempotency probe that BLOCKS on an inconclusive result rather than
 *      gambling on a create — a delayed order beats a duplicate one.
 *   3. Post-create verification that flags a duplicate for ops if one slips
 *      through anyway.
 */
import {
  AttemptStatus,
  RequestStatus,
  type CheckoutRequest,
} from "@prisma/client";
import prisma from "../../db.server";
import { unauthenticated } from "../../shopify.server";
import {
  createShopifyOrder,
  findExistingOrder,
  validateCustomerLink,
} from "../shopify/admin.server";
import { getShopSettings } from "../shops/shop.server";
import { logger, errorFields } from "../../utils/logger.server";
import type { CartSnapshot, PricingBreakdown } from "./cart.server";

const MAX_RECONCILE_ATTEMPTS = 10;
/** A fulfilment claim older than this is presumed dead (process crashed mid-create). */
const CLAIM_TTL_MS = 5 * 60 * 1000;

export type FulfillOutcome =
  "CREATED" | "RECONCILING" | "TERMINAL" | "NOOP" | "LOCKED";

/** Exponential backoff: 2m, 4m, 8m … capped at 60m. */
function nextRetryDelayMs(retryCount: number): number {
  return Math.min(60 * 60 * 1000, 60 * 1000 * Math.pow(2, retryCount));
}

/**
 * Create the Shopify order for a captured request.
 *
 * Safe to call from anywhere, repeatedly, concurrently. Callers should NOT
 * treat a non-CREATED result as an error — LOCKED and NOOP are normal.
 */
export async function fulfillCapturedRequest(
  requestId: string,
): Promise<FulfillOutcome> {
  // --- Layer 1: atomic claim -----------------------------------------------
  // Only one caller proceeds. A stale claim becomes reclaimable after
  // CLAIM_TTL_MS so a crashed process can't wedge the request forever, but
  // within that window concurrent callers back off instead of racing.
  const staleBefore = new Date(Date.now() - CLAIM_TTL_MS);
  const claimed = await prisma.checkoutRequest.updateMany({
    where: {
      id: requestId,
      shopifyOrderId: null, // already fulfilled → permanently excluded
      status: { in: [RequestStatus.CAPTURED, RequestStatus.RECONCILING] },
      OR: [
        { fulfillmentClaimedAt: null },
        { fulfillmentClaimedAt: { lt: staleBefore } },
      ],
    },
    data: { fulfillmentClaimedAt: new Date() },
  });

  if (claimed.count === 0) {
    // Already fulfilled, not in a fulfillable state, or another caller holds
    // the claim. All three are correct no-ops.
    return "LOCKED";
  }

  try {
    return await runFulfillment(requestId);
  } catch (error) {
    // runFulfillment handles its own failures; anything reaching here is a bug
    // in this module. Park it in reconciling so the tick retries rather than
    // leaving a captured request stranded.
    logger.error("order.fulfil_unhandled", {
      requestId,
      ...errorFields(error),
    });
    const request = await prisma.checkoutRequest.findUnique({
      where: { id: requestId },
    });
    if (request) return handleFailure(request, error);
    return "NOOP";
  } finally {
    // Release the claim only if we didn't succeed. On success shopifyOrderId is
    // set, and the `shopifyOrderId: null` guard above permanently blocks re-entry.
    await prisma.checkoutRequest
      .updateMany({
        where: { id: requestId, shopifyOrderId: null },
        data: { fulfillmentClaimedAt: null },
      })
      .catch((error) =>
        logger.warn("order.claim_release_failed", {
          requestId,
          ...errorFields(error),
        }),
      );
  }
}

/** The actual fulfilment work. Runs only while holding the claim. */
async function runFulfillment(requestId: string): Promise<FulfillOutcome> {
  const request = await prisma.checkoutRequest.findUnique({
    where: { id: requestId },
    include: { shop: true, customer: true },
  });
  if (!request) return "NOOP";
  if (request.shopifyOrderId) return "NOOP"; // won the claim but another pass finished first

  const attempt = await prisma.paymentAttempt.findFirst({
    where: { requestId: request.id, status: AttemptStatus.CAPTURED },
    orderBy: { resolvedAt: "desc" },
  });
  if (!attempt) {
    // CAPTURED status with no captured attempt is a data-integrity problem, not
    // a transient failure — retrying won't help.
    logger.error("order.no_captured_attempt", { requestId });
    await markTerminal(request, "NO_CAPTURED_ATTEMPT");
    return "TERMINAL";
  }

  const snapshot = request.cartSnapshot as unknown as CartSnapshot | null;
  const pricing =
    request.pricingBreakdown as unknown as PricingBreakdown | null;
  const address = request.shippingAddress as any;

  if (!snapshot?.lines?.length || !address) {
    // Cannot construct an order at all — unrecoverable without human input.
    await markTerminal(request, "MISSING_SNAPSHOT");
    return "TERMINAL";
  }

  const capturedMinor = attempt.amountCapturedMinor ?? attempt.amountMinor;

  // Sanity check before creating: the money we're about to record must be a
  // positive amount we actually captured. A zero/negative here means corrupted
  // state, and creating a PAID order for it would be worse than stopping.
  if (capturedMinor <= 0n) {
    await markTerminal(request, `INVALID_CAPTURED_AMOUNT:${capturedMinor}`);
    return "TERMINAL";
  }

  try {
    const { admin } = await unauthenticated.admin(request.shop.shopDomain);
    const settings = getShopSettings(request.shop);

    let shopifyCustomerId = request.customer?.shopifyCustomerId ?? null;
    if (shopifyCustomerId) {
      const verdict = await validateCustomerLink(
        admin,
        shopifyCustomerId,
        request.customer?.email ?? null,
      );
      if (verdict.valid === false) {
        // Clear the bad link and fall back to upsert-by-email below.
        logger.info("customer.link_cleared", {
          customerId: request.customer?.id,
          shopifyCustomerId,
          reason: verdict.reason,
        });
        await prisma.customer.update({
          where: { id: request.customer!.id },
          data: { shopifyCustomerId: null },
        });
        shopifyCustomerId = null;
      }
      // verdict.valid === "UNKNOWN" → keep the link; a transient API failure
      // must not destroy a correct association.
    }

    // --- Layer 2: probe + create (createShopifyOrder throws on inconclusive) ---
    const order = await createShopifyOrder(admin, {
      requestId: request.id,
      appOrderId: request.appOrderId ?? request.id,
      pgPaymentId: attempt.pgPaymentId,
      pg: attempt.pg,
      email: request.customer?.email ?? "",
      phone: request.customer?.phone ?? address.phone,
      currency: attempt.currency,
      capturedMinor,
      expectedMinor: attempt.amountMinor,
      lines: snapshot.lines.map((l) => ({
        variantId: l.variantId,
        quantity: l.quantity,
      })),
      shippingAddress: address,
      shippingMinor: BigInt(pricing?.shippingMinor ?? "0"),
      shippingLabel:
        pricing?.shippingLabel ?? settings.shipping.label ?? "Shipping",
      cartToken: request.cartToken,
      oversold: request.oversold,
      shopifyCustomerId,
    });

    if (!order.adopted) {
      const verify = await findExistingOrder(admin, request.id);
      if (verify.outcome === "FOUND" && verify.order.id !== order.id) {
        logger.error("order.duplicate_detected", {
          requestId: request.id,
          created: order.id,
          existing: verify.order.id,
        });
        await prisma.paymentAttempt.updateMany({
          where: { requestId: request.id, status: AttemptStatus.CAPTURED },
          data: {
            refundStatus: "PENDING_MANUAL",
            failureCode: "DUPLICATE_ORDER",
          },
        });
      }
    }

    await prisma.checkoutRequest.update({
      where: { id: request.id },
      data: {
        status: RequestStatus.ORDER_CREATED,
        shopifyOrderId: order.id,
        shopifyOrderName: order.name,
        statusPageUrl: order.statusPageUrl,
        orderSnapshot: {
          appOrderId: request.appOrderId,
          orderName: order.name,
          totalAmount: order.totalAmount,
          currency: order.currency,
          capturedMinor: String(capturedMinor),
          lines: snapshot.lines,
          shippingAddress: address,
          pricing,
        } as unknown as object,
        nextRetryAt: null,
        lastError: null,
      },
    });

    if (
      order.customerId &&
      request.customer &&
      request.customer.shopifyCustomerId !== order.customerId
    ) {
      await prisma.customer
        .update({
          where: { id: request.customer.id },
          data: { shopifyCustomerId: order.customerId },
        })
        .catch((error) =>
          // Non-fatal: the order exists and is correctly associated on Shopify's
          // side. Worst case the next order upserts again and re-links.
          logger.warn("customer.link_persist_failed", {
            customerId: request.customer!.id,
            ...errorFields(error),
          }),
        );
    }

    logger.info("order.fulfilled", {
      requestId,
      orderName: order.name,
      adopted: order.adopted,
      capturedMinor: String(capturedMinor),
    });
    return "CREATED";
  } catch (error) {
    return handleFailure(request, error);
  }
}

/** T9/T10 — retryable failure. Backs off; escalates to T11 when exhausted. */
async function handleFailure(
  request: CheckoutRequest,
  error: unknown,
): Promise<"RECONCILING" | "TERMINAL"> {
  const retryCount = request.retryCount + 1;
  const message =
    error instanceof Error ? error.message.slice(0, 500) : String(error);

  if (retryCount >= MAX_RECONCILE_ATTEMPTS) {
    await markTerminal(request, message);
    logger.error("order.reconcile_exhausted", {
      requestId: request.id,
      retryCount,
      error: message,
    });
    return "TERMINAL";
  }

  await prisma.checkoutRequest.update({
    where: { id: request.id },
    data: {
      status: RequestStatus.RECONCILING,
      retryCount,
      nextRetryAt: new Date(Date.now() + nextRetryDelayMs(retryCount)),
      lastError: message,
    },
  });
  logger.warn("order.reconciling", {
    requestId: request.id,
    retryCount,
    nextRetryInMs: nextRetryDelayMs(retryCount),
    error: message,
  });
  return "RECONCILING";
}

/**
 * T11 — money captured, order impossible. Flags the captured attempt for the
 * ops Refund queue (no auto-refund in v1) and stops retrying. This is the one
 * state that always requires a human.
 */
async function markTerminal(
  request: CheckoutRequest,
  reason: string,
): Promise<void> {
  await prisma.$transaction([
    prisma.checkoutRequest.update({
      where: { id: request.id },
      data: {
        status: RequestStatus.FAILED_TERMINAL,
        lastError: reason,
        nextRetryAt: null,
        fulfillmentClaimedAt: null,
      },
    }),
    prisma.paymentAttempt.updateMany({
      where: { requestId: request.id, status: AttemptStatus.CAPTURED },
      data: {
        refundStatus: "PENDING_MANUAL",
        failureCode: "ORDER_CREATE_EXHAUSTED",
      },
    }),
  ]);
  logger.error("order.terminal_refund_required", {
    requestId: request.id,
    reason,
  });
}
