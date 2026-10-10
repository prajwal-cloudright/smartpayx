import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { logger, errorFields } from "../utils/logger.server";

export async function action({ request }: ActionFunctionArgs) {
  const { shop, session, topic } = await authenticate.webhook(request);
  logger.info("webhook.shopify", { topic, shop });

  try {
    // Stop serving checkout immediately — every proxy route checks this.
    await prisma.shop.updateMany({
      where: { shopDomain: shop },
      data: { spxEnabled: false, storefrontToken: null },
    });

    // Revoke customer sessions for this shop so stale tokens can't be reused
    // if the app is reinstalled later.
    await prisma.authSession.updateMany({
      where: { customer: { shop: { shopDomain: shop } }, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    // The template clears its own session rows; do the same for safety.
    if (session) {
      await prisma.session.deleteMany({ where: { shop } });
    }

    logger.info("shop.uninstalled", { shop });
  } catch (error) {
    logger.error("webhook.uninstall_failed", { shop, ...errorFields(error) });
  }

  // Always 200 — Shopify retries otherwise, and there's nothing to recover.
  return new Response(null, { status: 200 });
}
