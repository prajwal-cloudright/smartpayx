/**
 * POST /apps/smartpayx/shipping-address
 * Body: { request_id, email, address: {...} }  — new address
 *    OR { request_id, email, address_id }      — saved address
 */
import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";
import { apiAction } from "../services/http/route-utils.server";
import { apiOk, apiError } from "../services/http/responses.server";
import { authenticateProxy } from "../services/auth/proxy.server";
import {
  requireCustomerSession,
  assertRequestOwnership,
} from "../services/auth/guards.server";
import { getRequestById } from "../services/checkout/request.server";
import { readCart, computePricing } from "../services/checkout/cart.server";
import {
  AddressSchema,
  toSnapshot,
  saveAddress,
  getOwnedAddress,
  addressRowToSnapshot,
  attachAddressToRequest,
  validateEmail,
} from "../services/checkout/address.server";
import { parseJsonBody } from "../utils/request.server";

const BodySchema = z
  .object({
    request_id: z.uuid(),
    email: z.string().min(1).optional(),
    address: AddressSchema.optional(),
    address_id: z.string().uuid().optional(),
    save_address: z.boolean().optional().default(true),
  })
  .refine((v) => Boolean(v.address) !== Boolean(v.address_id), {
    message: "Provide either a new address or a saved address id, not both.",
  });

export const action = apiAction(
  async ({ request: httpRequest }: ActionFunctionArgs) => {
    const { shop } = await authenticateProxy(httpRequest);
    const auth = await requireCustomerSession(httpRequest);
    const body = BodySchema.parse(await parseJsonBody(httpRequest));

    const checkoutRequest = await getRequestById(body.request_id);
    assertRequestOwnership(checkoutRequest, auth);

    const emailIsFixed =
      auth.customer.emailLocked || Boolean(auth.customer.shopifyCustomerId);
    const email =
      emailIsFixed && auth.customer.email
        ? auth.customer.email
        : validateEmail(body.email ?? "");

    // Resolve the snapshot from either source.
    let snapshot;
    let addressId: string | undefined;
    if (body.address_id) {
      const row = await getOwnedAddress(auth.customer.id, body.address_id);
      snapshot = addressRowToSnapshot(row);
      addressId = row.id;
    } else {
      snapshot = toSnapshot(body.address!);
      if (body.save_address) {
        const saved = await saveAddress(auth.customer.id, snapshot);
        addressId = saved.id;
      }
    }

    const updated = await attachAddressToRequest({
      request: checkoutRequest,
      snapshot,
      addressId,
      customer: auth.customer,
      email,
    });

    // Re-price against the current cart — shipping can depend on the address.
    const cart = await readCart(shop, updated.cartToken);
    if (!cart) {
      return apiError("CART_EMPTY", "Your cart is no longer available.", 409);
    }
    const pricing = computePricing(shop, cart);

    return apiOk({
      request_id: updated.id,
      step: "PG_SELECTION",
      selected_address: snapshot,
      address_id: addressId ?? null,
      pricing,
    });
  },
);
