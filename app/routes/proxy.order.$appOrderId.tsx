/**
 * GET /apps/smartpayx/order/:appOrderId — powers the hosted thank-you page.
 *
 * Renders from our own order snapshot, NOT Shopify's statusPageUrl (which is
 * auth-gated and redacted for API-created orders). statusPageUrl is surfaced
 * only as a secondary "track order" link once it exists.
 */
import type { LoaderFunctionArgs } from "react-router";
import { RequestStatus } from "@prisma/client";
import prisma from "../db.server";
import { apiLoader } from "../services/http/route-utils.server";
import { apiOk, apiError } from "../services/http/responses.server";
import { authenticateProxy } from "../services/auth/proxy.server";
import { resolveAuthForCheckout } from "../services/checkout/session-auth.server";

export const loader = apiLoader(
  async ({ request: httpRequest, params }: LoaderFunctionArgs) => {
    await authenticateProxy(httpRequest);

    const appOrderId = params.appOrderId;
    if (!appOrderId) return apiError("NOT_FOUND", "Order not found.", 404);

    const checkoutRequest = await prisma.checkoutRequest.findUnique({
      where: { appOrderId },
      include: { customer: true },
    });
    if (!checkoutRequest) return apiError("NOT_FOUND", "Order not found.", 404);

    // Ownership (I1/I3) — random ids are not authorization.
    const authResult = await resolveAuthForCheckout(
      httpRequest,
      checkoutRequest.status,
    );
    if (authResult.outcome === "FORCE_REVERIFY" || !authResult.auth) {
      return apiError(
        "UNAUTHENTICATED",
        "A valid customer session is required.",
        401,
      );
    }
    if (checkoutRequest.customerId !== authResult.auth.customer.id) {
      return apiError(
        "FORBIDDEN",
        "This order does not belong to the current session.",
        403,
      );
    }

    if (checkoutRequest.status === RequestStatus.FAILED_TERMINAL) {
      return apiOk({
        app_order_id: appOrderId,
        status: "REFUND_PENDING",
        message:
          "We received your payment but couldn't complete the order. Our team is processing your refund.",
      });
    }

    const paid: RequestStatus[] = [
      RequestStatus.CAPTURED,
      RequestStatus.RECONCILING,
      RequestStatus.ORDER_CREATED,
    ];

    if (!paid.includes(checkoutRequest.status)) {
      return apiError("NOT_CAPTURED", "This order hasn't been paid yet.", 409, {
        status: checkoutRequest.status,
      });
    }

    return apiOk({
      app_order_id: appOrderId,
      status: checkoutRequest.status,
      order: checkoutRequest.orderSnapshot ?? {
        // Pre-order-creation fallback so the thank-you page renders immediately
        // after capture, before Shopify has the order.
        lines: (checkoutRequest.cartSnapshot as any)?.lines ?? [],
        pricing: checkoutRequest.pricingBreakdown,
        shippingAddress: checkoutRequest.shippingAddress,
      },
      shopify_order_name: checkoutRequest.shopifyOrderName,
      // Only once it exists — Shopify's OSP is 404/redacted before then.
      track_order_url: checkoutRequest.statusPageUrl,
      confirmation_pending: !checkoutRequest.shopifyOrderId,
    });
  },
);
