import type { ActionFunctionArgs } from "react-router";
import { RequestStatus } from "@prisma/client";
import { z } from "zod";
import { apiAction } from "../services/http/route-utils.server";
import { apiError, apiOk } from "../services/http/responses.server";
import { authenticateProxy } from "../services/auth/proxy.server";
import {
  assertRequestOwnership,
  requireCustomerSession,
} from "../services/auth/guards.server";
import { computePricing, readCart } from "../services/checkout/cart.server";
import {
  getRequestById,
  updatePricing,
} from "../services/checkout/request.server";
import { updateCartDiscountCodes } from "../services/shopify/storefront.server";
import { parseJsonBody } from "../utils/request.server";

const BodySchema = z.object({
  request_id: z.uuid(),
  action: z.enum(["APPLY", "REMOVE"]).default("APPLY"),
  discount_code: z.string().trim().min(1).max(255),
});

export const action = apiAction(async ({ request }: ActionFunctionArgs) => {
  const { shop } = await authenticateProxy(request);
  const auth = await requireCustomerSession(request);
  const body = BodySchema.parse(await parseJsonBody(request));
  const checkoutRequest = await getRequestById(body.request_id);
  assertRequestOwnership(checkoutRequest, auth);

  if (checkoutRequest.shopId !== shop.id) {
    return apiError(
      "FORBIDDEN",
      "This checkout belongs to another store.",
      403,
    );
  }

  if (
    checkoutRequest.status !== RequestStatus.ADDRESS_SET &&
    checkoutRequest.status !== RequestStatus.AWAITING_PAYMENT
  ) {
    return apiError(
      "INVALID_STATE",
      "A coupon can't be changed while this checkout is being processed.",
      409,
    );
  }

  const currentCart = await readCart(shop, checkoutRequest.cartToken);
  if (!currentCart) {
    return apiError("CART_EMPTY", "Your cart is no longer available.", 409);
  }

  const discountCodes =
    body.action === "REMOVE"
      ? currentCart.discountCodes.filter(
          (code) => code.toLowerCase() !== body.discount_code.toLowerCase(),
        )
      : [
          ...new Map(
            [...currentCart.discountCodes, body.discount_code].map(
              (code) => [code.toLowerCase(), code] as const,
            ),
          ).values(),
        ];
  const update = await updateCartDiscountCodes(
    { shop },
    checkoutRequest.cartToken,
    discountCodes,
  );

  if (update.userErrors.length) {
    return apiError(
      "DISCOUNT_CODE_ERROR",
      update.userErrors.map((error) => error.message).join(" "),
      422,
    );
  }

  const cart = await readCart(shop, checkoutRequest.cartToken);
  if (!cart) {
    return apiError("CART_EMPTY", "Your cart is no longer available.", 409);
  }
  const pricing = computePricing(shop, cart);
  await updatePricing(checkoutRequest.id, pricing);

  const applied = update.discountCodes.some(
    (discount) =>
      discount.code.toLowerCase() === body.discount_code.toLowerCase() &&
      discount.applicable,
  );

  return apiOk({
    cart,
    pricing,
    applied,
    message:
      body.action === "REMOVE"
        ? "Coupon removed."
        : applied
          ? "Coupon applied."
          : "This coupon isn't valid for the items in your cart.",
  });
});
