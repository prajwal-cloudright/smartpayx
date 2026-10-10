/**
 * POST /apps/smartpayx/auth/otp/send
 * Body: { phone, challenge_id? }  (challenge_id present = resend)
 */
import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";
import { apiAction, getClientIp } from "../services/http/route-utils.server";
import { apiOk } from "../services/http/responses.server";
import { authenticateProxy } from "../services/auth/proxy.server";
import { normalizeIndianPhone } from "../utils/phone.server";
import { sendOtp } from "../services/auth/otp.server";
import { parseJsonBody } from "../utils/request.server";

const SendSchema = z.object({
  phone: z.string().min(1),
  challenge_id: z.string().uuid().optional(),
});

export const action = apiAction(async ({ request }: ActionFunctionArgs) => {
  const { shop } = await authenticateProxy(request);
  const body = SendSchema.parse(await parseJsonBody(request));
  const { e164, local10 } = normalizeIndianPhone(body.phone);

  const result = await sendOtp({
    shopId: shop.id,
    phoneE164: e164,
    mobile10: local10,
    challengeId: body.challenge_id,
    clientIp: getClientIp(request),
  });

  return apiOk({
    challenge_id: result.challengeId,
    resend_after_s: result.resendAfterSec,
    resends_left: result.resendsLeft,
  });
});
