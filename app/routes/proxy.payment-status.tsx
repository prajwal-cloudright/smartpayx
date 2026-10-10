/**
 * GET /apps/smartpayx/payment-status?request_id=...
 *
 * Pure DB read — never calls the gateway. The resolver, callback, and sweeper
 * own all PG communication; this is what the widget polls while CONFIRMING.
 */
import type { LoaderFunctionArgs } from "react-router";
import { z } from "zod";
import { AttemptStatus, RequestStatus } from "@prisma/client";
import prisma from "../db.server";
import { apiLoader, getQueryParams } from "../services/http/route-utils.server";
import { apiOk, apiError } from "../services/http/responses.server";
import { authenticateProxy } from "../services/auth/proxy.server";
import { resolveAuthForCheckout } from "../services/checkout/session-auth.server";
import { getRequestById } from "../services/checkout/request.server";

const QuerySchema = z.object({ request_id: z.string().uuid() });

/** Terminal-success states where the widget should stop polling and move on. */
const DONE: RequestStatus[] = [RequestStatus.ORDER_CREATED];
/** Captured but order pending — the buyer can proceed to thank-you regardless. */
const PAID: RequestStatus[] = [
  RequestStatus.CAPTURED,
  RequestStatus.RECONCILING,
];

export const loader = apiLoader(
  async ({ request: httpRequest }: LoaderFunctionArgs) => {
    await authenticateProxy(httpRequest);
    const { request_id } = QuerySchema.parse(getQueryParams(httpRequest));

    const checkoutRequest = await getRequestById(request_id);

    // Status-aware auth: a token that expired during the gateway round trip must
    // still be able to read the result of the payment it started.
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
    if (
      checkoutRequest.customerId &&
      checkoutRequest.customerId !== authResult.auth.customer.id
    ) {
      return apiError(
        "FORBIDDEN",
        "This checkout does not belong to the current session.",
        403,
      );
    }

    const lastAttempt = await prisma.paymentAttempt.findFirst({
      where: { requestId: checkoutRequest.id },
      orderBy: { initiatedAt: "desc" },
    });

    const isPaid =
      PAID.includes(checkoutRequest.status) ||
      DONE.includes(checkoutRequest.status);

    return apiOk({
      status: checkoutRequest.status,
      // Capture is the point of no return — tell the widget to clear the storefront
      // cart as soon as money is confirmed, not after the Shopify order exists.
      // This closes the window where a buyer edits a cart tied to a paid request.
      should_clear_cart: isPaid,
      app_order_id: checkoutRequest.appOrderId,
      shopify_order_created: Boolean(checkoutRequest.shopifyOrderId),
      // Buyers proceed to thank-you on CAPTURED; the order may still be pending.
      can_proceed: isPaid,
      failure:
        lastAttempt && lastAttempt.status === AttemptStatus.FAILED
          ? {
              reason:
                lastAttempt.failureReason ?? "Payment could not be completed.",
              charged: lastAttempt.charged ?? false,
            }
          : null,
    });
  },
);
