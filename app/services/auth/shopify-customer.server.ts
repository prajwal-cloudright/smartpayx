import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { Customer, Shop } from "@prisma/client";
import prisma from "../../db.server";
import { fetchShopifyCustomerContact } from "../shopify/admin.server";
import { AppError, ValidationError } from "../errors.server";
import {
  mintCustomerSessionTx,
  revokeCustomerSessionsTx,
} from "./token.server";
import type { CustomerAuth } from "./guards.server";
import { normalizeIndianPhone } from "../../utils/phone.server";
import { sha256Hex } from "../../utils/crypto.server";

export async function authenticateShopifyCustomer(params: {
  admin: AdminApiContext;
  shop: Shop;
  loggedInCustomerId: string;
  userAgent: string;
}): Promise<{ auth: CustomerAuth; token: string } | null> {
  const { admin, shop, loggedInCustomerId, userAgent } = params;
  if (!/^\d+$/.test(loggedInCustomerId)) return null;

  const shopifyCustomerId = `gid://shopify/Customer/${loggedInCustomerId}`;
  const linkedCustomer = await prisma.customer.findFirst({
    where: { shopId: shop.id, shopifyCustomerId },
  });

  const contact = linkedCustomer
    ? null
    : await fetchShopifyCustomerContact(admin, shopifyCustomerId);
  if (!linkedCustomer && (!contact || contact.id !== shopifyCustomerId)) {
    return null;
  }

  let phone: string | null = linkedCustomer?.phone ?? null;
  if (!phone && contact) {
    const phoneCandidates = [
      contact.phone,
      contact.lastOrderShippingPhone,
      contact.defaultAddressPhone,
    ];
    for (const candidate of phoneCandidates) {
      if (!candidate) continue;
      try {
        phone = normalizeIndianPhone(candidate).e164;
        break;
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
      }
    }
  }
  if (!phone) return null;

  const userAgentHash = sha256Hex(userAgent || "unknown");
  return prisma.$transaction(async (tx) => {
    let customer: Customer | null = await tx.customer.findFirst({
      where: { shopId: shop.id, shopifyCustomerId },
    });

    if (!customer) {
      const byPhone = await tx.customer.findUnique({
        where: { shopId_phone: { shopId: shop.id, phone } },
      });

      if (
        byPhone?.shopifyCustomerId &&
        byPhone.shopifyCustomerId !== shopifyCustomerId
      ) {
        return null;
      }

      customer = byPhone
        ? await tx.customer.update({
            where: { id: byPhone.id },
            data: {
              shopifyCustomerId,
              ...(contact?.email
                ? { email: contact.email, emailLocked: true }
                : {}),
            },
          })
        : await tx.customer.create({
            data: {
              shopId: shop.id,
              phone,
              shopifyCustomerId,
              email: contact?.email ?? null,
              emailLocked: Boolean(contact?.email),
            },
          });
    }

    await revokeCustomerSessionsTx(tx, customer.id);
    const minted = await mintCustomerSessionTx(tx, customer.id, userAgentHash);
    const session = await tx.authSession.findUnique({
      where: { id: minted.sessionId },
    });
    if (!session) {
      throw new AppError(
        "INTERNAL_ERROR",
        "Could not load the customer session.",
        500,
      );
    }

    return {
      auth: { customer, session },
      token: minted.token,
    };
  });
}