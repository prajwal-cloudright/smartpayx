/**
 * Shipping address validation, saved-address management, and attaching an
 * immutable address SNAPSHOT to a request (spec §3: the request stores JSONB,
 * deliberately not an FK, so the shipped-to address survives later edits).
 */
import {
  RequestStatus,
  type CheckoutRequest,
  type Customer,
  type CustomerAddress,
} from "@prisma/client";
import { z } from "zod";
import prisma from "../../db.server";
import { AppError, NotFoundError, ValidationError } from "../errors.server";
import { logger, errorFields } from "../../utils/logger.server";
import { normalizeIndianPhone } from "../../utils/phone.server";
import { INDIAN_STATE_NAMES } from "app/utils/address.server";

/** Disposable/test domains we reject outright. */
const BLOCKED_EMAIL_DOMAINS = new Set([
  "example.com",
  "example.org",
  "test.com",
  "mailinator.com",
  "yopmail.com",
  "10minutemail.com",
  "guerrillamail.com",
  "tempmail.com",
]);

export const AddressSchema = z.object({
  name: z.string().trim().min(2, "Enter the full name").max(100),
  phone: z.string().trim().min(1, "Phone is required"),
  address1: z
    .string()
    .trim()
    .min(5, "Enter the house/flat and street")
    .max(255),
  address2: z.string().trim().max(255).optional().or(z.literal("")),
  landmark: z.string().trim().max(255).optional().or(z.literal("")),
  city: z.string().trim().min(2, "Enter the city").max(100),
  state: z
    .string()
    .trim()
    .refine((v) => INDIAN_STATE_NAMES.includes(v), "Select a valid state"),
  pincode: z
    .string()
    .trim()
    .regex(/^[1-9]\d{5}$/, "Enter a valid 6-digit pincode"),
  country: z.string().trim().default("IN"),
});

export type AddressInput = z.infer<typeof AddressSchema>;

export interface AddressSnapshot {
  name: string;
  phone: string;
  address1: string;
  address2?: string;
  landmark?: string;
  city: string;
  state: string;
  pincode: string;
  country: string;
}

export function validateEmail(email: string): string {
  const value = (email ?? "").trim().toLowerCase();
  const parsed = z
    .string()
    .email("Enter a valid email address")
    .safeParse(value);
  if (!parsed.success)
    throw new ValidationError("Enter a valid email address.");
  const domain = value.split("@")[1] ?? "";
  if (BLOCKED_EMAIL_DOMAINS.has(domain)) {
    throw new ValidationError(
      "Please use a real email address so we can send your order confirmation.",
    );
  }
  return value;
}

/** Validate + normalize into a snapshot (phone forced to E.164). */
export function toSnapshot(input: AddressInput): AddressSnapshot {
  const parsed = AddressSchema.parse(input);
  const { e164 } = normalizeIndianPhone(parsed.phone);
  return {
    name: parsed.name,
    phone: e164,
    address1: parsed.address1,
    ...(parsed.address2 ? { address2: parsed.address2 } : {}),
    ...(parsed.landmark ? { landmark: parsed.landmark } : {}),
    city: parsed.city,
    state: parsed.state,
    pincode: parsed.pincode,
    country: parsed.country || "IN",
  };
}

export async function listAddresses(
  customerId: string,
): Promise<CustomerAddress[]> {
  return prisma.customerAddress.findMany({
    where: { customerId, deletedAt: null },
    orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }],
  });
}

export async function getOwnedAddress(
  customerId: string,
  addressId: string,
): Promise<CustomerAddress> {
  const address = await prisma.customerAddress.findFirst({
    where: { id: addressId, customerId, deletedAt: null },
  });
  if (!address)
    throw new NotFoundError("That saved address is no longer available.");
  return address;
}

export function addressRowToSnapshot(row: CustomerAddress): AddressSnapshot {
  return {
    name: row.name,
    phone: row.phone,
    address1: row.address1,
    ...(row.address2 ? { address2: row.address2 } : {}),
    ...(row.landmark ? { landmark: row.landmark } : {}),
    city: row.city,
    state: row.state,
    pincode: row.pincode,
    country: row.country,
  };
}

/** Save a new address for the customer, making it default if it's their first. */
export async function saveAddress(
  customerId: string,
  snapshot: AddressSnapshot,
): Promise<CustomerAddress> {
  try {
    const count = await prisma.customerAddress.count({
      where: { customerId, deletedAt: null },
    });
    return await prisma.customerAddress.create({
      data: { customerId, ...snapshot, isDefault: count === 0 },
    });
  } catch (error) {
    logger.error("address.save_failed", { customerId, ...errorFields(error) });
    throw new AppError("INTERNAL_ERROR", "Could not save the address.", 500, {
      cause: error,
    });
  }
}

/**
 * Attach the address snapshot to the request and advance OPEN → ADDRESS_SET.
 * Re-selecting a different address later is allowed while pre-payment; it
 * clears any frozen amount so /payment must re-price (shipping can differ).
 */
export async function attachAddressToRequest(params: {
  request: CheckoutRequest;
  snapshot: AddressSnapshot;
  addressId?: string;
  customer: Customer;
  email: string;
}): Promise<CheckoutRequest> {
  const { request, snapshot, addressId, customer, email } = params;

  const mutableStatuses: RequestStatus[] = [
    RequestStatus.OPEN,
    RequestStatus.ADDRESS_SET,
    RequestStatus.AWAITING_PAYMENT,
  ];
  if (!mutableStatuses.includes(request.status)) {
    throw new AppError(
      "CONFLICT",
      "This checkout can no longer be edited.",
      409,
      {
        detail: { status: request.status },
      },
    );
  }

  const emailIsFixed =
    customer.emailLocked || Boolean(customer.shopifyCustomerId);

  if (emailIsFixed && customer.email && email !== customer.email) {
    throw new ValidationError(
      "This email is linked to your account and can't be changed here.",
      { field: "email" },
    );
  }

  return prisma.$transaction(async (tx) => {
    // Lock the email on the customer at first successful address submission.
    if (!emailIsFixed) {
      await tx.customer.update({
        where: { id: customer.id },
        data: { email, emailLocked: true },
      });
    }

    return tx.checkoutRequest.update({
      where: { id: request.id },
      data: {
        shippingAddress: snapshot as unknown as object,
        shippingAddressId: addressId ?? null,
        status: RequestStatus.ADDRESS_SET,
        amountMinor: null, // address change can change shipping → re-price at /payment
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      },
    });
  });
}
