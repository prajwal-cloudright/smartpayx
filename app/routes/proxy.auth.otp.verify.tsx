/**
 * POST /apps/smartpayx/auth/otp/verify
 * Body: { challenge_id, phone, code }
 * On success: find-or-create customer, rotate sessions, mint token — all in one
 * transaction so a verified challenge never ends up without a session.
 */
import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";
import prisma from "../db.server";
import { apiAction } from "../services/http/route-utils.server";
import { apiOk, apiError } from "../services/http/responses.server";
import { authenticateProxy } from "../services/auth/proxy.server";
import { normalizeIndianPhone } from "../utils/phone.server";
import { verifyOtp } from "../services/auth/otp.server";
import { findOrCreateCustomerTx } from "../services/customers/customer.server";
import {
  mintCustomerSessionTx,
  revokeCustomerSessionsTx,
} from "../services/auth/token.server";
import { sha256Hex } from "../utils/crypto.server";
import { parseJsonBody } from "../utils/request.server";

const VerifySchema = z.object({
  challenge_id: z.uuid(),
  phone: z.string().min(1),
  code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code."),
});

export const action = apiAction(async ({ request }: ActionFunctionArgs) => {
  const { shop } = await authenticateProxy(request);
  const body = VerifySchema.parse(await parseJsonBody(request));
  const { e164 } = normalizeIndianPhone(body.phone);

  const verification = await verifyOtp({
    shopId: shop.id,
    challengeId: body.challenge_id,
    phoneE164: e164,
    code: body.code,
  });

  if (!verification.ok) {
    if (verification.locked) {
      return apiError(
        "OTP_LOCKED",
        "Too many incorrect attempts. Please request a new code.",
        423,
      );
    }
    return apiError("OTP_INVALID", "That code is incorrect.", 401, {
      attempts_left: verification.attemptsLeft,
    });
  }

  // Verified — mint the session atomically with customer find-or-create + rotation.
  const uaHash = sha256Hex(request.headers.get("user-agent") ?? "unknown");
  const { customer, minted } = await prisma.$transaction(async (tx) => {
    const customer = await findOrCreateCustomerTx(tx, shop.id, e164);
    await revokeCustomerSessionsTx(tx, customer.id);
    const minted = await mintCustomerSessionTx(tx, customer.id, uaHash);
    return { customer, minted };
  });

  return apiOk({
    token: minted.token,
    expires_at: minted.expiresAt.toISOString(),
    customer: {
      id: customer.id,
      phone: customer.phone,
      email: customer.email ?? null,
      email_locked: customer.emailLocked,
    },
  });
});
