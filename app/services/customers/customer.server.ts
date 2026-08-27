/**
 * Customer identity — phone-keyed find-or-create. Deliberately NO Shopify
 * customer link validation here (that's the order-creation slice, at point of
 * use with a confirmed email — see the auth-slice discussion).
 */
import type { Prisma, Customer } from "@prisma/client";
import prisma from "../../db.server";

export async function findCustomerByPhone(
  shopId: bigint,
  phoneE164: string,
): Promise<Customer | null> {
  return prisma.customer.findUnique({
    where: { shopId_phone: { shopId, phone: phoneE164 } },
  });
}

/** Find-or-create within a transaction (used by verify so login is atomic). */
export async function findOrCreateCustomerTx(
  tx: Prisma.TransactionClient,
  shopId: bigint,
  phoneE164: string,
): Promise<Customer> {
  return tx.customer.upsert({
    where: { shopId_phone: { shopId, phone: phoneE164 } },
    update: { lastVerifiedAt: new Date() },
    create: { shopId, phone: phoneE164, lastVerifiedAt: new Date() },
  });
}
