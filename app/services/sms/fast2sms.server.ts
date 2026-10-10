/**
 * fast2sms delivery adapter. We own OTP generation, hashing, expiry, attempts
 * and lockout ourselves (otp.server.ts) — fast2sms is ONLY the delivery pipe.
 * We never use its /otp/verify endpoint; that would move security-critical
 * logic out of our control.
 */
import { env } from "../../config/env.server";
import { AppError } from "../errors.server";
import { logger, errorFields } from "../../utils/logger.server";

const FAST2SMS_ENDPOINT = "https://www.fast2sms.com/dev/bulkV2";

interface Fast2smsResponse {
  return: boolean;
  request_id?: string;
  message?: string[] | string;
}

export async function sendOtpSms(
  mobile10: string,
  code: string,
  username: string = "Customer",
): Promise<string | null> {
  const body = {
    route: "dlt",
    sender_id: env.FAST2SMS_SENDER_ID,
    message: "205969",
    variables_values: [username, code].join("|"),
    numbers: mobile10,
  };

  let response: Response;
  try {
    response = await fetch(FAST2SMS_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: env.FAST2SMS_API_KEY,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    logger.error("sms.transport_failed", {
      mobile: mobile10,
      ...errorFields(error),
    });
    throw new AppError(
      "INTERNAL_ERROR",
      "Could not send the verification code. Please try again.",
      500,
      { cause: error },
    );
  }

  let otpResponse: Fast2smsResponse;
  try {
    otpResponse = (await response.json()) as Fast2smsResponse;
  } catch (error) {
    throw new AppError(
      "INTERNAL_ERROR",
      "SMS provider returned an unexpected response.",
      500,
      { cause: error },
    );
  }

  if (!response.ok || !otpResponse.return) {
    const providerMsg = Array.isArray(otpResponse.message)
      ? otpResponse.message.join("; ")
      : otpResponse.message;
    logger.error("sms.delivery_failed", {
      mobile: mobile10,
      status: response.status,
      providerMsg,
    });
    throw new AppError(
      "INTERNAL_ERROR",
      "Could not send the verification code. Please try again.",
      500,
      {
        detail: { providerMsg },
      },
    );
  }

  logger.info("sms.otp_sent", {
    mobile: mobile10,
    requestId: otpResponse.request_id,
  });
  return otpResponse.request_id ?? null;
}
