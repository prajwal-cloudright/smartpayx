/**
 * Shopify Storefront API service.
 *
 * Token lifecycle is handled HERE, not by callers: a revoked/deleted token
 * ("Channel not found") triggers a one-time re-provision and retry inside
 * executeStorefront, so every storefront operation inherits the recovery
 * without repeating it.
 */
import type { Shop } from "@prisma/client";
import CART_QUERY from "../../graphql/queries/cart.details.gql";
import prisma from "../../db.server";
import { unauthenticated, apiVersion } from "../../shopify.server";
import { createStorefrontAccessToken } from "./admin.server";
import { ShopifyApiError } from "../errors.server";
import { logger, errorFields } from "../../utils/logger.server";

/** Callers pass the shop row — the token is resolved and refreshed internally. */
export interface StorefrontContext {
  shop: Shop;
}

interface GraphqlEnvelope<T> {
  data?: T;
  errors?: { message: string; extensions?: { code?: string } }[];
}

/**
 * Resolve a usable storefront token, provisioning one if absent.
 * `forceNew` discards the stored value first, which is how the retry path
 * replaces a revoked token (ensureStorefrontToken would otherwise short-circuit
 * on the stale value).
 */
async function resolveToken(shop: Shop, forceNew = false): Promise<string> {
  if (!forceNew && shop.storefrontToken) return shop.storefrontToken;

  const { admin } = await unauthenticated.admin(shop.shopDomain);
  const token = await createStorefrontAccessToken(
    admin,
    "SmartPayX cart reads",
  );

  await prisma.shop.update({
    where: { id: shop.id },
    data: { storefrontToken: token },
  });
  logger.info("shopify.storefront.token_provisioned", {
    shopDomain: shop.shopDomain,
    reason: forceNew ? "replaced_revoked" : "initial",
  });
  return token;
}

/** A revoked or deleted storefront token surfaces as this. */
function isTokenRevoked(status: number, body: string): boolean {
  return (
    status === 403 &&
    (body.includes("Channel not found") || body.includes("ACCESS_DENIED"))
  );
}

/**
 * Execute a Storefront GraphQL document.
 *
 * Retries EXACTLY ONCE on a revoked token, with a freshly provisioned one. A
 * second failure is a genuine error (permissions, wrong shop, Shopify outage),
 * not a stale-token case, so it propagates rather than looping.
 */
async function executeStorefront<T>(
  ctx: StorefrontContext,
  operation: string,
  document: string,
  variables?: Record<string, unknown>,
  isRetry = false,
): Promise<T> {
  const token = await resolveToken(ctx.shop, isRetry);
  const endpoint = `https://${ctx.shop.shopDomain}/api/${apiVersion}/graphql.json`;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Storefront-Access-Token": token,
      },
      body: JSON.stringify({ query: document, variables: variables ?? {} }),
    });
  } catch (error) {
    logger.error("shopify.storefront.transport_failed", {
      operation,
      ...errorFields(error),
    });
    throw new ShopifyApiError(
      operation,
      "Could not reach the Shopify Storefront API.",
      { cause: error },
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "<unreadable>");

    if (isTokenRevoked(response.status, body) && !isRetry) {
      logger.warn("shopify.storefront.token_revoked_retrying", {
        operation,
        shopDomain: ctx.shop.shopDomain,
      });
      // Re-read the shop so the retry sees the token we're about to replace,
      // not a stale in-memory copy from the caller.
      const fresh = await prisma.shop.findUnique({
        where: { id: ctx.shop.id },
      });
      return executeStorefront<T>(
        { shop: fresh ?? ctx.shop },
        operation,
        document,
        variables,
        true,
      );
    }

    logger.error("shopify.storefront.http_error", {
      operation,
      status: response.status,
      isRetry,
      body: body.slice(0, 500),
    });
    throw new ShopifyApiError(
      operation,
      `Storefront API returned ${response.status}.`,
      {
        status: response.status === 429 ? 429 : 502,
        detail: { httpStatus: response.status },
      },
    );
  }

  let envelope: GraphqlEnvelope<T>;
  try {
    envelope = (await response.json()) as GraphqlEnvelope<T>;
  } catch (error) {
    throw new ShopifyApiError(
      operation,
      "Storefront API returned a malformed response.",
      { cause: error },
    );
  }

  // Storefront sometimes returns 200 with an ACCESS_DENIED error body rather
  // than a 403, so the revoked-token check has to run here too.
  if (envelope.errors?.length) {
    const message = envelope.errors.map((e) => e.message).join("; ");
    const accessDenied = envelope.errors.some(
      (e) =>
        e.extensions?.code === "ACCESS_DENIED" ||
        e.message.includes("Channel not found"),
    );

    if (accessDenied && !isRetry) {
      logger.warn("shopify.storefront.token_revoked_in_body_retrying", {
        operation,
        shopDomain: ctx.shop.shopDomain,
      });
      const fresh = await prisma.shop.findUnique({
        where: { id: ctx.shop.id },
      });
      return executeStorefront<T>(
        { shop: fresh ?? ctx.shop },
        operation,
        document,
        variables,
        true,
      );
    }

    logger.error("shopify.storefront.graphql_errors", {
      operation,
      message,
      isRetry,
    });
    throw new ShopifyApiError(
      operation,
      `Storefront rejected the request: ${message}`,
    );
  }

  if (!envelope.data) {
    throw new ShopifyApiError(operation, "Storefront API returned no data.");
  }
  return envelope.data;
}

export interface StorefrontCartLine {
  variantId: string;
  productId: string;
  title: string;
  variantTitle: string;
  sku: string;
  quantity: number;
  unitAmount: string;
  currencyCode: string;
  imageUrl: string | null;
}

export interface StorefrontCart {
  cartId: string;
  totalQuantity: number;
  subtotalAmount: string;
  totalAmount: string;
  currencyCode: string;
  lines: StorefrontCartLine[];
  discountCodes: string[];
}

/**
 * Read a cart by its token. Pass the token VERBATIM including any `?key=`
 * suffix — modern cart tokens carry it and stripping it breaks the lookup.
 * Returns null when the cart does not exist (expired/invalid token) rather
 * than throwing, since that is an expected condition, not a failure.
 */
export async function fetchCart(
  ctx: StorefrontContext,
  cartToken: string,
): Promise<StorefrontCart | null> {
  const cartId = cartToken.startsWith("gid://")
    ? cartToken
    : `gid://shopify/Cart/${cartToken}`;
  const data = await executeStorefront<{ cart: any | null }>(
    ctx,
    "fetchCart",
    CART_QUERY,
    { cartId },
  );

  if (!data.cart) return null;

  try {
    const cart = data.cart;
    return {
      cartId: cart.id,
      totalQuantity: cart.totalQuantity ?? 0,
      subtotalAmount: cart.cost?.subtotalAmount?.amount ?? "0.00",
      totalAmount: cart.cost?.totalAmount?.amount ?? "0.00",
      currencyCode: cart.cost?.totalAmount?.currencyCode ?? "INR",
      lines: (cart.lines?.nodes ?? []).map((node: any): StorefrontCartLine => ({
        variantId: node.merchandise?.id,
        productId: node.merchandise?.product?.id,
        title: node.merchandise?.product?.title ?? "",
        variantTitle: node.merchandise?.title ?? "",
        sku: node.merchandise?.sky ?? "",
        quantity: node.quantity ?? 0,
        unitAmount: node.merchandise?.price?.amount ?? "0.00",
        currencyCode: node.merchandise?.price?.currencyCode ?? "INR",
        imageUrl: node.merchandise?.image?.url ?? null,
      })),
      discountCodes: (cart.discountCodes ?? [])
        .filter((d: any) => d.applicable)
        .map((d: any) => d.code),
    };
  } catch (error) {
    throw new ShopifyApiError(
      "fetchCart",
      "Cart response had an unexpected shape.",
      { cause: error },
    );
  }
}
