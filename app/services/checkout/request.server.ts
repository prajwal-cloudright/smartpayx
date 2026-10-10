/**
 * Checkout request lifecycle — dedup, resume, re-pricing, step resolution.
 *
 * The dedup invariant (spec §3): at most ONE non-terminal request per
 * (shop, cart_token), enforced by the partial unique index
 * `one_open_request_per_cart`. Terminal requests are invisible to lookup, which
 * is what makes the never-rotating cart token safe to key on.
 */
import {
  Prisma,
  RequestStatus,
  type CheckoutRequest,
  type Customer,
  type Shop,
} from "@prisma/client";
import prisma from "../../db.server";
import { AppError, NotFoundError } from "../errors.server";
import { logger, errorFields } from "../../utils/logger.server";
import type { CartSnapshot, PricingBreakdown } from "./cart.server";
import { computeItemsHash } from "./cart.server";

/** Statuses the dedup index treats as "open" — must match the SQL exactly. */
export const OPEN_STATUSES: RequestStatus[] = [
  RequestStatus.OPEN,
  RequestStatus.ADDRESS_SET,
  RequestStatus.AWAITING_PAYMENT,
  RequestStatus.ATTEMPT_INITIATED,
  RequestStatus.CAPTURED,
  RequestStatus.RECONCILING,
];

/** Statuses where cart/pricing may still change. Anything at or past CAPTURED is frozen. */
export const MUTABLE_STATUSES: RequestStatus[] = [
  RequestStatus.OPEN,
  RequestStatus.ADDRESS_SET,
  RequestStatus.AWAITING_PAYMENT,
];

export type CheckoutStep =
  "LOGIN" | "ADDRESS" | "PG_SELECTION" | "CONFIRMING" | "COMPLETED";

function requestTtl(): Date {
  return new Date(Date.now() + 30 * 60 * 1000); // 30 min, refreshed on activity
}

/**
 * Find the open request for this cart, or create one. Handles the index
 * conflict (concurrent tabs) by re-fetching rather than failing.
 */
export async function findOrCreateRequest(
  shop: Shop,
  cartToken: string,
  snapshot: CartSnapshot,
): Promise<CheckoutRequest> {
  const existing = await prisma.checkoutRequest.findFirst({
    where: { shopId: shop.id, cartToken, status: { in: OPEN_STATUSES } },
    orderBy: { createdAt: "desc" },
  });

  console.log("Existing request :: ", existing?.status, existing);

  if (existing) return existing;

  try {
    return await prisma.checkoutRequest.create({
      data: {
        shopId: shop.id,
        cartToken,
        itemsHash: computeItemsHash(snapshot.lines),
        cartSnapshot: snapshot as unknown as object,
        currency: snapshot.currency,
        status: RequestStatus.OPEN,
        expiresAt: requestTtl(),
      },
    });
  } catch (error) {
    // P2002 = the partial unique index fired: another tab won the race.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const raced = await prisma.checkoutRequest.findFirst({
        where: { shopId: shop.id, cartToken, status: { in: OPEN_STATUSES } },
        orderBy: { createdAt: "desc" },
      });
      if (raced) return raced;
    }
    logger.error("request.create_failed", {
      shopId: String(shop.id),
      ...errorFields(error),
    });
    throw new AppError("INTERNAL_ERROR", "Could not start checkout.", 500, {
      cause: error,
    });
  }
}

/**
 * Refresh the cart snapshot when contents changed.
 *
 * HARD RULE: never mutates a request at or past CAPTURED. The snapshot taken at
 * capture time IS the record of what the buyer paid for — overwriting it would
 * make the Shopify order disagree with the money actually collected.
 */
export async function syncCartOnRequest(
  request: CheckoutRequest,
  snapshot: CartSnapshot,
): Promise<{ request: CheckoutRequest; changed: boolean; frozen: boolean }> {
  if (!MUTABLE_STATUSES.includes(request.status)) {
    const drifted = request.itemsHash !== computeItemsHash(snapshot.lines);
    if (drifted) {
      logger.info("request.cart_drift_after_capture", {
        requestId: request.id,
        status: request.status,
      });
    }
    return { request, changed: false, frozen: true };
  }

  const nextHash = computeItemsHash(snapshot.lines);
  if (request.itemsHash === nextHash)
    return { request, changed: false, frozen: false };

  const updated = await prisma.checkoutRequest.update({
    where: { id: request.id },
    data: {
      itemsHash: nextHash,
      cartSnapshot: snapshot as unknown as object,
      currency: snapshot.currency,
      amountMinor: null,
      pricingBreakdown: Prisma.JsonNull,
      expiresAt: requestTtl(),
    },
  });
  logger.info("request.cart_changed", {
    requestId: request.id,
    status: request.status,
  });
  return { request: updated, changed: true, frozen: false };
}

/** Bind an unbound request to the authenticated customer (invariant I3). */
export async function bindCustomer(
  request: CheckoutRequest,
  customer: Customer,
): Promise<CheckoutRequest> {
  if (request.customerId === customer.id) return request;
  if (request.customerId && request.customerId !== customer.id) {
    throw new AppError(
      "FORBIDDEN",
      "This checkout belongs to a different account.",
      403,
    );
  }
  return prisma.checkoutRequest.update({
    where: { id: request.id },
    data: { customerId: customer.id, expiresAt: requestTtl() },
  });
}

export async function touchRequest(requestId: string): Promise<void> {
  await prisma.checkoutRequest
    .update({ where: { id: requestId }, data: { expiresAt: requestTtl() } })
    .catch((error) =>
      logger.warn("request.touch_failed", { requestId, ...errorFields(error) }),
    );
}

export async function getRequestById(
  requestId: string,
): Promise<CheckoutRequest> {
  const request = await prisma.checkoutRequest.findUnique({
    where: { id: requestId },
  });
  if (!request) throw new NotFoundError("Checkout session not found.");
  return request;
}

/** Which screen the widget should render for this request. */
export function resolveStep(
  request: CheckoutRequest,
  authenticated: boolean,
): CheckoutStep {
  if (
    request.status === RequestStatus.CAPTURED ||
    request.status === RequestStatus.RECONCILING ||
    request.status === RequestStatus.ORDER_CREATED
  ) {
    return request.status === RequestStatus.ORDER_CREATED
      ? "COMPLETED"
      : "CONFIRMING";
  }
  if (request.status === RequestStatus.ATTEMPT_INITIATED) return "CONFIRMING";
  if (!authenticated) return "LOGIN";
  if (!request.shippingAddress) return "ADDRESS";
  return "PG_SELECTION";
}

/** Persist pricing computed from the current snapshot (display only; /payment re-freezes). */
export async function updatePricing(
  requestId: string,
  pricing: PricingBreakdown,
): Promise<CheckoutRequest> {
  return prisma.checkoutRequest.update({
    where: { id: requestId },
    data: {
      pricingBreakdown: pricing as unknown as object,
      expiresAt: requestTtl(),
    },
  });
}
