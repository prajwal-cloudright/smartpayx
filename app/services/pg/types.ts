/**
 * The contract every PG adapter implements. The resolver and /payment talk
 * ONLY to this interface — no PG-specific logic leaks past it.
 */
import type { PgProvider } from "@prisma/client";

export type PaymentMode = "EMBEDDED" | "REDIRECT";

export interface CreateSessionParams {
  attemptId: string;
  requestId: string;
  amountMinor: bigint;
  currency: string;
  callbackUrl: string;
  customer: { name: string; email: string; phone: string };
  shippingAddress?: {
    name: string;
    phone: string;
    address1: string;
    address2?: string;
    city: string;
    state: string;
    pincode: string;
    country: string;
  };
  lines: {
    variantId: string;
    title: string;
    quantity: number;
    unitMinor: bigint;
    imageUrl?: string | null;
  }[];
  shippingMinor: bigint;
  credentials: Record<string, string>;
}

export interface CreateSessionResult {
  /** The PG's order/session id — stored as payment_attempts.pg_order_id. */
  pgOrderId: string;
  mode: PaymentMode;
  /** REDIRECT: URL to send the top window to. */
  paymentUrl?: string;
  /** EMBEDDED: options the widget hands to the PG's JS SDK. */
  sdkOptions?: Record<string, unknown>;
}

export type FetchedPaymentStatus =
  "CAPTURED" | "FAILED" | "PENDING" | "NOT_ATTEMPTED";

export interface FetchedPayment {
  status: FetchedPaymentStatus;
  pgPaymentId: string | null;
  /** Actual captured amount — may be < requested when a PG offer applied. */
  amountMinor: bigint | null;
  currency: string | null;
  /** True when the PG's payment data confirms an offer/instant discount. */
  offerApplied: boolean;
  failureCode?: string | null;
  failureReason?: string | null;
  /** On failure: was the customer actually debited? Drives UX copy. */
  charged?: boolean | null;
  raw?: unknown;
}

export interface WebhookVerification {
  valid: boolean;
  eventId: string;
  eventType: string;
  pgOrderId: string | null;
}

export interface PgAdapter {
  pg: PgProvider;
  createSession(params: CreateSessionParams): Promise<CreateSessionResult>;
  fetchPayment(
    pgOrderId: string,
    credentials: Record<string, string>,
  ): Promise<FetchedPayment>;
  verifyWebhook(
    rawBody: string,
    headers: Headers,
    credentials: Record<string, string>,
  ): WebhookVerification;
  verifyCallback(
    params: Record<string, string>,
    credentials: Record<string, string>,
  ): boolean;
}
