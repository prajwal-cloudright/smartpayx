/**
 * Status-aware auth resolution for the checkout-resume flow (spec §2, the
 * "one deliberate exception" to the fixed-TTL rule). Called from
 * `/proxy/request` ONLY — every other route uses the strict guard in
 * `services/auth/guards.server.ts`.
 *
 * Rationale: a fixed-TTL token can technically expire mid-payment-attempt
 * (buyer is away at the PG's hosted page). Two asymmetric rules close that
 * gap without reintroducing sliding expiry or silent rotation:
 *
 *   1. PRE-CAPTURE (OPEN/ADDRESS_SET/AWAITING_PAYMENT/ATTEMPT_INITIATED):
 *      if the token has <=30min left (or is already past expiry), force-
 *      revoke it NOW and require a real re-OTP. This means a payment
 *      attempt never STARTS on a token that could die before the buyer
 *      returns from the PG.
 *   2. TERMINAL-SUCCESS (CAPTURED/RECONCILING/ORDER_CREATED): accept a
 *      token past its expires_at, provided the hash still matches an
 *      UNREVOKED row. Identity is never relaxed — only the clock — and the
 *      leniency is scoped to reading that one request's own status.
 *
 * PRE-CAPTURE statuses that still have time left, and any status not listed
 * above, fall through to an ordinary strict check.
 */
import type { AuthSession, Customer, RequestStatus } from "@prisma/client";
import prisma from "../../db.server";
import { env } from "../../config/env.server";
import { hashAuthToken, revokeSession } from "../auth/token.server";
import type { CustomerAuth } from "../auth/guards.server";
import { errorFields, logger } from "../../utils/logger.server";
import { AppError } from "../errors.server";

const PRE_CAPTURE_STATUSES: RequestStatus[] = [
  "OPEN",
  "ADDRESS_SET",
  "AWAITING_PAYMENT",
  "ATTEMPT_INITIATED",
];
const TERMINAL_SUCCESS_STATUSES: RequestStatus[] = [
  "CAPTURED",
  "RECONCILING",
  "ORDER_CREATED",
];

export type CheckoutAuthResult =
  | { outcome: "AUTHORIZED"; auth: CustomerAuth | null } // null = no/absent token, request may still be pre-login (I2)
  | { outcome: "FORCE_REVERIFY" }; // caller must respond with step: LOGIN

/**
 * @param request            incoming Request (reads X-SPX-Auth)
 * @param requestStatus      the checkout_request's CURRENT status, already loaded by the caller
 */
export async function resolveAuthForCheckout(
  request: Request,
  requestStatus: RequestStatus,
): Promise<CheckoutAuthResult> {
  const rawToken = request.headers.get("X-SPX-Auth");
  if (!rawToken) return { outcome: "AUTHORIZED", auth: null }; // no token at all → LOGIN step is decided by the route, not here

  let session;
  try {
    session = await prisma.authSession.findUnique({
      where: { tokenHash: hashAuthToken(rawToken) },
      include: { customer: true },
    });
  } catch (error) {
    logger.error("checkout.session_lookup_failed", errorFields(error));
    throw new AppError("INTERNAL_ERROR", "Could not verify the session.", 500, {
      cause: error,
    });
  }

  if (!session || session.revokedAt)
    return { outcome: "AUTHORIZED", auth: null };

  // Hash mismatch or already revoked → identity is never relaxed, regardless of request status.
  if (!session || session.revokedAt)
    return { outcome: "AUTHORIZED", auth: null };

  const remainingMs = session.expiresAt.getTime() - Date.now();
  const graceMs = env.SESSION_NEAR_EXPIRY_GRACE_MIN * 60 * 1000;

  const asAuth = (): CustomerAuth => {
    const { customer, ...bare } = session as typeof session & {
      customer: Customer;
    };
    return { customer, session: bare as AuthSession };
  };

  if (PRE_CAPTURE_STATUSES.includes(requestStatus)) {
    if (remainingMs <= graceMs) {
      await revokeSession(session.id);
      return { outcome: "FORCE_REVERIFY" };
    }
    return { outcome: "AUTHORIZED", auth: asAuth() }; // plenty of time left — ordinary strict pass
  }

  if (TERMINAL_SUCCESS_STATUSES.includes(requestStatus)) {
    // Identity already confirmed (hash matched, not revoked) — clock is relaxed here on purpose.
    return { outcome: "AUTHORIZED", auth: asAuth() };
  }

  // Any other status (CANCELLED/EXPIRED/FAILED_TERMINAL): fall back to strict expiry.
  if (remainingMs <= 0) return { outcome: "AUTHORIZED", auth: null };
  return { outcome: "AUTHORIZED", auth: asAuth() };
}
