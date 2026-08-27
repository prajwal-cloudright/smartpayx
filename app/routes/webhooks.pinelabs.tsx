import type { ActionFunctionArgs } from "react-router";
import { PgProvider, Prisma } from "@prisma/client";
import prisma from "../db.server";
import { getAdapter } from "../services/pg/index.server";
import { getPgCredentials } from "../services/shops/shop.server";
import { resolveByPgOrderId } from "../services/checkout/resolver.server";
import { logger, errorFields } from "../utils/logger.server";

export async function action({ request }: ActionFunctionArgs) {
  const rawBody = await request.text();

  let pgOrderId: string | null = null;
  try {
    const parsed = JSON.parse(rawBody);
    pgOrderId = parsed?.data?.order_id ?? parsed?.order_id ?? null;
  } catch {
    return new Response("bad body", { status: 400 });
  }
  if (!pgOrderId) return new Response("no order id", { status: 400 });

  const attempt = await prisma.paymentAttempt.findUnique({
    where: { pg_pgOrderId: { pg: PgProvider.PINELABS, pgOrderId } },
    include: { request: true },
  });
  if (!attempt) {
    logger.warn("webhook.pinelabs.unknown_order", { pgOrderId });
    return new Response("ok", { status: 200 });
  }

  const credentials = await getPgCredentials(
    attempt.request.shopId,
    PgProvider.PINELABS,
  );
  const verification = getAdapter(PgProvider.PINELABS).verifyWebhook(
    rawBody,
    request.headers,
    credentials,
  );

  try {
    await prisma.webhookEvent.create({
      data: {
        pg: PgProvider.PINELABS,
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
      return new Response("ok", { status: 200 });
    }
    throw error;
  }

  if (!verification.valid) {
    logger.error("webhook.pinelabs.invalid_signature", { pgOrderId });
    return new Response("invalid signature", { status: 400 });
  }

  queueMicrotask(() => {
    resolveByPgOrderId(PgProvider.PINELABS, pgOrderId!)
      .then((outcome) =>
        prisma.webhookEvent
          .updateMany({
            where: { pg: PgProvider.PINELABS, eventId: verification.eventId },
            data: { processedAt: new Date() },
          })
          .then(() =>
            logger.info("webhook.pinelabs.resolved", { pgOrderId, outcome }),
          ),
      )
      .catch((error) =>
        logger.error("webhook.pinelabs.resolve_failed", {
          pgOrderId,
          ...errorFields(error),
        }),
      );
  });

  return new Response("ok", { status: 200 });
}
