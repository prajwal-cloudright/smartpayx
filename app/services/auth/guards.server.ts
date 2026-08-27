/**
 * Generic customer auth guard — STRICT fixed-TTL check only. Use this for
 * every route that isn't the checkout-resume flow (e.g. profile reads,
 * address book management). It does not know about checkout_request status
 * and therefore never applies the terminal-success expiry leniency — that
 * lives in session-auth.server.ts and is deliberately scoped to /proxy/request.
 */
import type { AuthSession, Customer } from "@prisma/client";
import prisma from "../../db.server";
import { hashAuthToken } from "./token.server";
import { errorFields, logger } from "../../utils/logger.server";
import { AppError } from "../errors.server";

export const AUTH_HEADER = "X-SPX-Auth";

export interface CustomerAuth {
  customer: Customer;
  session: AuthSession;
}

/**
 * Resolve the customer session strictly: hash match, not revoked, not past
 * the fixed expires_at. No side effects (no bump — there is nothing to bump).
 * Missing/invalid/expired/revoked all resolve to null; callers decide whether
 * that's fatal.
 */
export async function resolveCustomerSession(
  request: Request,
): Promise<CustomerAuth | null> {
  const rawToken = request.headers.get(AUTH_HEADER);
  if (!rawToken) return null;

  let session;
  try {
    session = await prisma.authSession.findUnique({
      where: { tokenHash: hashAuthToken(rawToken) },
      include: { customer: true },
    });
  } catch (error) {
    logger.error("auth.session_lookup_failed", errorFields(error));
    throw new AppError("INTERNAL_ERROR", "Could not verify the session.", 500, {
      cause: error,
    });
  }

  if (!session || session.revokedAt) return null;
  if (session.expiresAt.getTime() <= Date.now()) return null;

  const { customer, ...bare } = session;
  return { customer, session: bare as AuthSession };
}

/** Hard guard — throws 401 apiError when no valid session. */
export async function requireCustomerSession(
  request: Request,
): Promise<CustomerAuth> {
  const auth = await resolveCustomerSession(request);
  if (!auth) {
    throw new AppError(
      "UNAUTHENTICATED",
      "A valid customer session is required.",
      401,
    );
  }
  return auth;
}

/**
 * Invariant I3: a request bound to a customer may only be touched by that
 * customer's sessions. Unbound (pre-login) requests pass.
 */
export function assertRequestOwnership(
  checkoutRequest: { customerId: string | null },
  auth: CustomerAuth | null,
): void {
  if (checkoutRequest.customerId === null) return;
  if (!auth || auth.customer.id !== checkoutRequest.customerId) {
    throw new AppError(
      "FORBIDDEN",
      "This checkout does not belong to the current session.",
      403,
    );
  }
}
