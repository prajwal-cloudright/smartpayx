/**
 * POST /apps/smartpayx/request — the entry + resume endpoint.
 *
 * Order matters (spec §5):
 *  1. proxy auth + shop resolution
 *  2. find-or-create the request for this cart token (dedup)
 *  3. server-side cart read → snapshot + items hash (single source of truth)
 *  4. re-price if cart contents changed
 *  5. status-aware auth (resolveAuthForCheckout — NOT the strict guard)
 *  6. reconcile-before-render for live attempts   [payments slice]
 *  7. build the step response (zero PII when unauthenticated — invariant I2)
 */
import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";
import { AttemptStatus, RequestStatus } from "@prisma/client";
import { apiAction } from "../services/http/route-utils.server";
import { apiOk, apiError } from "../services/http/responses.server";
import { authenticateProxy } from "../services/auth/proxy.server";
import { resolveAuthForCheckout } from "../services/checkout/session-auth.server";
import {
  readCart,
  computePricing,
  CartSnapshot,
  PricingBreakdown,
  computeItemsHash,
} from "../services/checkout/cart.server";
import {
  findOrCreateRequest,
  syncCartOnRequest,
  bindCustomer,
  resolveStep,
  updatePricing,
  getRequestById,
} from "../services/checkout/request.server";
import { listAddresses } from "../services/checkout/address.server";
import { getEnabledPgConfigs } from "../services/shops/shop.server";
import prisma from "../db.server";
import { parseJsonBody } from "../utils/request.server";
import { resolveAttempt } from "../services/checkout/resolver.server";
import { errorFields, logger } from "../utils/logger.server";

const RequestSchema = z.object({ cart_token: z.string().trim().min(1) });

export const action = apiAction(
  async ({ request: httpRequest }: ActionFunctionArgs) => {
    const { shop } = await authenticateProxy(httpRequest);
    const body = RequestSchema.parse(await parseJsonBody(httpRequest));

    // 3. Server-side cart read — what the buyer sees and what we price.
    const snapshot = await readCart(shop, body.cart_token);
    if (!snapshot) {
      return apiError(
        "CART_EMPTY",
        "Your cart is empty or no longer available.",
        409,
      );
    }

    console.log("Cart snapshot :: ", snapshot);

    // 2 + 4. Dedup, then re-sync if contents changed since last visit.
    let checkoutRequest = await findOrCreateRequest(
      shop,
      body.cart_token,
      snapshot,
    );

    console.log(
      "Checkout request data :: ",
      checkoutRequest?.status,
      checkoutRequest,
    );

    const synced = await syncCartOnRequest(checkoutRequest, snapshot);
    checkoutRequest = synced.request;

    // 5. Status-aware auth: pre-capture near-expiry forces re-OTP; terminal-success
    //    accepts an expired-but-unrevoked token for reading its own status.
    const authResult = await resolveAuthForCheckout(
      httpRequest,
      checkoutRequest.status,
    );
    if (authResult.outcome === "FORCE_REVERIFY") {
      return apiOk({
        request_id: checkoutRequest.id,
        step: "LOGIN",
        reauth_required: true,
        cart: snapshot,
        pricing: computePricing(shop, snapshot),
      });
    }

    const auth = authResult.auth;

    // Bind an unbound request to the authenticated customer (I3).
    if (auth && !checkoutRequest.customerId) {
      checkoutRequest = await bindCustomer(checkoutRequest, auth.customer);
    } else if (auth && checkoutRequest.customerId !== auth.customer.id) {
      return apiError(
        "FORBIDDEN",
        "This checkout belongs to a different account.",
        403,
      );
    }

    // 6. Reconcile-before-render: never trust stored state for a live attempt.
    if (checkoutRequest.status === RequestStatus.ATTEMPT_INITIATED) {
      const liveAttempt = await prisma.paymentAttempt.findFirst({
        where: {
          requestId: checkoutRequest.id,
          status: AttemptStatus.INITIATED,
        },
      });
      if (liveAttempt) {
        const outcome = await resolveAttempt(liveAttempt.id).catch((error) => {
          logger.error("request.reconcile_failed", {
            requestId: checkoutRequest.id,
            ...errorFields(error),
          });
          return "PENDING" as const;
        });
        if (outcome !== "PENDING") {
          checkoutRequest = await getRequestById(checkoutRequest.id); // re-read post-transition
        }
      }
    }

    /**
     * Post-capture, render the FROZEN snapshot and pricing from the request —
     * not the live cart. The buyer must see what they paid for, even if they've
     * since added items to their storefront cart in another tab.
     */
    const isFrozen = synced.frozen;
    const displayCart = isFrozen
      ? ((checkoutRequest.cartSnapshot ?? snapshot) as unknown as CartSnapshot)
      : snapshot;
    const displayPricing = isFrozen
      ? ((checkoutRequest.pricingBreakdown ??
          computePricing(shop, displayCart)) as unknown as PricingBreakdown)
      : computePricing(shop, snapshot);

    // Only persist recomputed pricing while still mutable.
    if (!isFrozen && (checkoutRequest.status !== RequestStatus.OPEN || auth)) {
      checkoutRequest = await updatePricing(checkoutRequest.id, displayPricing);
    }

    const step = resolveStep(checkoutRequest, Boolean(auth));

    // 7. Unauthenticated → cart + totals only, ZERO PII (invariant I2).
    if (!auth) {
      return apiOk({
        request_id: checkoutRequest.id,
        step: "LOGIN",
        cart: displayCart,
        pricing: displayPricing,
        frozen: isFrozen,
        cart_drift:
          isFrozen &&
          checkoutRequest.itemsHash !== computeItemsHash(snapshot.lines),
      });
    }

    const [addresses, lastAttempt] = await Promise.all([
      listAddresses(auth.customer.id),
      prisma.paymentAttempt.findFirst({
        where: { requestId: checkoutRequest.id },
        orderBy: { initiatedAt: "desc" },
      }),
    ]);

    return apiOk({
      request_id: checkoutRequest.id,
      step,
      cart_changed: synced.changed,
      cart: displayCart,
      pricing: displayPricing,
      frozen: isFrozen,
      cart_drift:
        isFrozen &&
        checkoutRequest.itemsHash !== computeItemsHash(snapshot.lines),
      customer: {
        id: auth.customer.id,
        phone: auth.customer.phone,
        email: auth.customer.email ?? null,
        email_locked:
          auth.customer.emailLocked || Boolean(auth.customer.shopifyCustomerId),
      },
      addresses: addresses.map((a) => ({
        id: a.id,
        name: a.name,
        phone: a.phone,
        address1: a.address1,
        address2: a.address2,
        landmark: a.landmark,
        city: a.city,
        state: a.state,
        pincode: a.pincode,
        country: a.country,
        is_default: a.isDefault,
      })),
      selected_address: checkoutRequest.shippingAddress ?? null,
      pg_options: getEnabledPgConfigs(shop).map((c) => ({
        pg: c.pg,
        display_order: c.display_order,
        offer_text: c.offer_text ?? null,
      })),
      last_attempt: lastAttempt
        ? {
            status: lastAttempt.status,
            failure_reason: lastAttempt.failureReason,
            charged: lastAttempt.charged,
          }
        : null,
      order: checkoutRequest.appOrderId
        ? {
            app_order_id: checkoutRequest.appOrderId,
            shopify_order_created: Boolean(checkoutRequest.shopifyOrderId),
          }
        : null,
    });
  },
);
