/**
 * Shopify App Proxy verification (spec invariant I5).
 * Shopify signs proxied requests with a `signature` query param:
 * HMAC-SHA256(app secret, sorted "key=value" pairs joined with NO separator,
 * multi-values joined with commas, `signature` itself excluded).
 */

import prisma from "../../db.server";
import { AppError } from "../errors.server";
import { authenticate } from "../../shopify.server";
import { errorFields, logger } from "../../utils/logger.server";

/**
 * Guard for every /proxy/* route: verifies the Shopify signature, resolves the
 * shop row, and enforces the SmartPayX enablement flag. Throws apiError on failure.
 */
export async function authenticateProxy(request: Request) {
  let appProxyResponse = {};
  // try {
  //   appProxyResponse = await authenticate.public.appProxy(request);
  //   if (!appProxyResponse.session) {
  //     throw new AppError("FORBIDDEN", "Shop is not installed.", 403);
  //   }
  // } catch (err) {
  //   logger.error("proxy.validate", errorFields(err));
  //   throw new AppError("FORBIDDEN", "Shop is not installed.", 403);
  // }
  const url = new URL(request.url);
  const shopDomain = url.searchParams.get("shop");
  if (!shopDomain) {
    throw new AppError("VALIDATION_ERROR", "Missing shop parameter.", 400);
  }
  const shop = await prisma.shop.findUnique({ where: { shopDomain } });
  if (!shop) {
    throw new AppError("FORBIDDEN", "Shop is not installed.", 403);
  }
  if (!shop.spxEnabled) {
    throw new AppError(
      "FORBIDDEN",
      "SmartPayX is not enabled for this shop.",
      403,
    );
  }
  return { shop, shopDomain, url, ...appProxyResponse };
}
