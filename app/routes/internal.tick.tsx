/**
 * POST /internal/tick — EventBridge calls this every minute (spec §8).
 *
 * Server-to-server: no CORS (a browser never calls this), guarded by a shared
 * secret. Every scan is idempotent and every row action is CAS-guarded, so
 * duplicated or overlapping ticks are harmless — exactly-once scheduling is
 * not required.
 */
import { AttemptStatus, RequestStatus } from "@prisma/client";
import prisma from "../db.server";
import {
  apiAction,
  requireInternalSecret,
} from "../services/http/route-utils.server";
import { apiOk } from "../services/http/responses.server";
import { resolveAttempt } from "../services/checkout/resolver.server";
import { fulfillCapturedRequest } from "../services/checkout/order.server";
import { logger, errorFields } from "../utils/logger.server";

/** A payment attempt older than this with no result is presumed abandoned. */
const ATTEMPT_SWEEP_AFTER_MS = 1 * 60 * 1000;
const BATCH = 25;

export const action = apiAction(async ({ request }) => {
  requireInternalSecret(request);
  const startedAt = Date.now();

  const summary = {
    swept: 0,
    reconciled: 0,
    expired: 0,
    webhooksRetried: 0,
    otpCleaned: 0,
  };

  // --- 1. Sweep stale payment attempts (T5 late-capture rescue / T7 abandon) ---
  const staleAttempts = await prisma.paymentAttempt.findMany({
    where: {
      status: AttemptStatus.INITIATED,
      initiatedAt: { lt: new Date(Date.now() - ATTEMPT_SWEEP_AFTER_MS) },
    },
    take: BATCH,
    orderBy: { initiatedAt: "asc" },
  });
  for (const attempt of staleAttempts) {
    try {
      const outcome = await resolveAttempt(attempt.id);
      summary.swept++;
      logger.info("tick.attempt_swept", { attemptId: attempt.id, outcome });
    } catch (error) {
      logger.error("tick.sweep_failed", {
        attemptId: attempt.id,
        ...errorFields(error),
      });
    }
  }

  // --- 2. Retry order creation for reconciling requests (T10/T11) ---
  const dueReconcile = await prisma.checkoutRequest.findMany({
    where: {
      status: { in: [RequestStatus.CAPTURED, RequestStatus.RECONCILING] },
      shopifyOrderId: null,
      OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: new Date() } }],
    },
    take: BATCH,
    orderBy: { updatedAt: "asc" },
  });
  for (const req of dueReconcile) {
    try {
      const outcome = await fulfillCapturedRequest(req.id);
      summary.reconciled++;
      logger.info("tick.reconciled", { requestId: req.id, outcome });
    } catch (error) {
      logger.error("tick.reconcile_failed", {
        requestId: req.id,
        ...errorFields(error),
      });
    }
  }

  // --- 3. Expire lapsed pre-payment requests (T12) ---
  const expired = await prisma.checkoutRequest.updateMany({
    where: {
      status: {
        in: [
          RequestStatus.OPEN,
          RequestStatus.ADDRESS_SET,
          RequestStatus.AWAITING_PAYMENT,
        ],
      },
      expiresAt: { lt: new Date() },
    },
    data: { status: RequestStatus.EXPIRED },
  });
  summary.expired = expired.count;

  // --- 4. Re-run webhook events that were stored but never processed ---
  const unprocessed = await prisma.webhookEvent.findMany({
    where: {
      processedAt: null,
      signatureValid: true,
      receivedAt: { lt: new Date(Date.now() - 2 * 60 * 1000) },
    },
    take: BATCH,
    orderBy: { receivedAt: "asc" },
  });
  for (const event of unprocessed) {
    if (!event.pgOrderId) continue;
    try {
      const attempt = await prisma.paymentAttempt.findUnique({
        where: { pg_pgOrderId: { pg: event.pg, pgOrderId: event.pgOrderId } },
      });
      if (attempt) await resolveAttempt(attempt.id);
      await prisma.webhookEvent.update({
        where: { id: event.id },
        data: { processedAt: new Date() },
      });
      summary.webhooksRetried++;
    } catch (error) {
      await prisma.webhookEvent
        .update({
          where: { id: event.id },
          data: {
            processingError:
              error instanceof Error
                ? error.message.slice(0, 500)
                : String(error),
          },
        })
        .catch(() => undefined);
      logger.error("tick.webhook_retry_failed", {
        eventId: event.id,
        ...errorFields(error),
      });
    }
  }

  // --- 5. Hourly housekeeping (gated so it runs once per hour, not per minute) ---
  if (new Date().getMinutes() === 0) {
    const cleaned = await prisma.otpChallenge.deleteMany({
      where: { createdAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    });
    summary.otpCleaned = cleaned.count;
    await prisma.authSession.deleteMany({
      where: {
        revokedAt: { lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      },
    });
  }

  logger.info("tick.completed", {
    ...summary,
    durationMs: Date.now() - startedAt,
  });
  return apiOk({ ok: true, ...summary });
});
