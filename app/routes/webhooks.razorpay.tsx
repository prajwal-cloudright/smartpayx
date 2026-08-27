/**
 * POST /webhooks/razorpay — server-to-server, NOT via app proxy.
 * ACK first, resolve asynchronously; the tick re-runs anything unprocessed.
 * Raw body is required for signature verification — never let the framework
 * pre-parse JSON on this route.
 */
import type { ActionFunctionArgs } from "react-router";
import { PgProvider, Prisma } from "@prisma/client";
import prisma from "../db.server";
import { getAdapter } from "../services/pg/index.server";
import { getPgCredentials } from "../services/shops/shop.server";
import { resolveByPgOrderId } from "../services/checkout/resolver.server";
import { logger, errorFields } from "../utils/logger.server";

export async function action({ request }: ActionFunctionArgs) {
  const rawBody = await request.text();

  // The shop is resolved via the attempt → request → shop chain, since the
  // webhook itself carries no shop identity. Parse first to find the order id.
  let pgOrderId: string | null = null;
  try {
    const parsed = JSON.parse(rawBody);
    pgOrderId =
      parsed?.payload?.payment?.entity?.order_id ??
      parsed?.payload?.order?.entity?.id ??
      null;
  } catch {
    return new Response("bad body", { status: 400 });
  }
  if (!pgOrderId) return new Response("no order id", { status: 400 });

  const attempt = await prisma.paymentAttempt.findUnique({
    where: { pg_pgOrderId: { pg: PgProvider.RAZORPAY, pgOrderId } },
    include: { request: true },
  });
  if (!attempt) {
    logger.warn("webhook.razorpay.unknown_order", { pgOrderId });
    return new Response("ok", { status: 200 }); // ack — nothing to do
  }

  const credentials = await getPgCredentials(
    attempt.request.shopId,
    PgProvider.RAZORPAY,
  );
  const verification = getAdapter(PgProvider.RAZORPAY).verifyWebhook(
    rawBody,
    request.headers,
    credentials,
  );

  // Store the event (dedup on (pg, event_id)) regardless of validity.
  try {
    await prisma.webhookEvent.create({
      data: {
        pg: PgProvider.RAZORPAY,
        eventId: verification.eventId,
        eventType: verification.eventType,
        pgOrderId,
        payload: JSON.parse(rawBody),
        signatureValid: verification.valid,
      },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return new Response("ok", { status: 200 }); // already processed
    }
    throw error;
  }

  if (!verification.valid) {
    logger.error("webhook.razorpay.invalid_signature", { pgOrderId });
    return new Response("invalid signature", { status: 400 });
  }

  // ACK immediately, resolve after the response (tick re-runs on crash).
  queueMicrotask(() => {
    resolveByPgOrderId(PgProvider.RAZORPAY, pgOrderId!)
      .then((outcome) =>
        prisma.webhookEvent
          .updateMany({
            where: { pg: PgProvider.RAZORPAY, eventId: verification.eventId },
            data: { processedAt: new Date() },
          })
          .then(() =>
            logger.info("webhook.razorpay.resolved", { pgOrderId, outcome }),
          ),
      )
      .catch((error) =>
        logger.error("webhook.razorpay.resolve_failed", {
          pgOrderId,
          ...errorFields(error),
        }),
      );
  });

  return new Response("ok", { status: 200 });
}
