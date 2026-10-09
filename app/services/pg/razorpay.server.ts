/**
 * Razorpay adapter — EMBEDDED mode (Standard Checkout SDK overlay).
 * Signature schemes:
 *   callback: HMAC-SHA256(order_id + "|" + payment_id, key_secret)
 *   webhook:  HMAC-SHA256(raw body, webhook_secret)   [different secret!]
 */
import { PgProvider } from "@prisma/client";
import type {
  PgAdapter,
  CreateSessionParams,
  CreateSessionResult,
  FetchedPayment,
  WebhookVerification,
} from "./types";
import { hmacSha256Hex, timingSafeEqualStr } from "../../utils/crypto.server";
import { assertMinorInt } from "../../utils/money.server";
import { AppError } from "../errors.server";
import { logger, errorFields } from "../../utils/logger.server";

const RZP_API = "https://api.razorpay.com/v1";

function authHeader(creds: Record<string, string>): string {
  return `Basic ${Buffer.from(`${creds.key_id}:${creds.key_secret}`).toString("base64")}`;
}

async function rzpFetch<T>(
  path: string,
  creds: Record<string, string>,
  init?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${RZP_API}${path}`, {
      ...init,
      headers: {
        Authorization: authHeader(creds),
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
  } catch (error) {
    logger.error("pg.razorpay.transport_failed", {
      path,
      ...errorFields(error),
    });
    throw new AppError("PG_ERROR", "Could not reach Razorpay.", 500, {
      cause: error,
    });
  }

  const text = await response.text();
  let payload: any;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new AppError(
      "PG_ERROR",
      "Razorpay returned a malformed response.",
      500,
    );
  }

  if (!response.ok) {
    const msg = payload?.error?.description ?? `HTTP ${response.status}`;
    logger.error("pg.razorpay.api_error", {
      path,
      status: response.status,
      msg,
    });
    throw new AppError("PG_ERROR", `Razorpay: ${msg}`, 500, {
      detail: { code: payload?.error?.code },
    });
  }
  return payload as T;
}

export const razorpayAdapter: PgAdapter = {
  pg: PgProvider.RAZORPAY,

  async createSession(
    params: CreateSessionParams,
  ): Promise<CreateSessionResult> {
    const order = await rzpFetch<{ id: string }>(
      "/orders",
      params.credentials,
      {
        method: "POST",
        body: JSON.stringify({
          amount: Number(params.amountMinor), // Razorpay takes minor units as integer
          currency: params.currency,
          receipt: params.attemptId,
          notes: {
            spx_request_id: params.requestId,
            spx_attempt_id: params.attemptId,
          },
        }),
      },
    );

    return {
      pgOrderId: order.id,
      mode: "EMBEDDED",
      sdkOptions: {
        key: params.credentials.key_id,
        order_id: order.id,
        amount: Number(params.amountMinor),
        currency: params.currency,
        name: "Checkout",
        // Form-POST the result to our callback route instead of relying solely
        // on the SDK handler, which dies with the tab on mobile UPI intent.
        callback_url: params.callbackUrl,
        redirect: true,
        prefill: {
          name: params.customer.name,
          email: params.customer.email,
          contact: params.customer.phone,
        },
        notes: { spx_attempt_id: params.attemptId },
      },
    };
  },

  /**
   * Fetch payments on the order — the order itself doesn't carry capture state
   * reliably, the payment entity does. We take the most relevant payment.
   */
  async fetchPayment(
    pgOrderId: string,
    credentials: Record<string, string>,
  ): Promise<FetchedPayment> {
    const result = await rzpFetch<{ items: any[] }>(
      `/orders/${pgOrderId}/payments`,
      credentials,
    );
    const payments = result.items ?? [];

    if (payments.length === 0) {
      return {
        status: "NOT_ATTEMPTED",
        pgPaymentId: null,
        amountMinor: null,
        currency: null,
        offerApplied: false,
      };
    }

    // Prefer a captured payment; else the latest attempt.
    const captured = payments.find((p) => p.status === "captured");
    const payment = captured ?? payments[payments.length - 1];

    const status: FetchedPayment["status"] =
      payment.status === "captured"
        ? "CAPTURED"
        : payment.status === "failed"
          ? "FAILED"
          : "PENDING"; // created / authorized / pending

    return {
      status,
      pgPaymentId: payment.id ?? null,
      amountMinor:
        payment.amount != null
          ? assertMinorInt(payment.amount, "razorpay.amount")
          : null,
      currency: payment.currency ?? null,
      // Razorpay exposes offer_id on the payment when an offer was applied.
      //   offerApplied: Boolean(payment.offer_id),
      offerApplied: true, // TODO - We will update this offerApplied logic when we have the complete understanding of offers on razorpay
      failureCode: payment.error_code ?? null,
      failureReason: payment.error_description ?? null,
      // A failed payment that never reached the bank was not debited.
      charged: payment.status === "failed" ? false : null,
      raw: payment,
    };
  },

  verifyWebhook(
    rawBody: string,
    headers: Headers,
    credentials: Record<string, string>,
  ): WebhookVerification {
    const provided = headers.get("x-razorpay-signature") ?? "";
    const expected = hmacSha256Hex(
      credentials.webhook_secret ?? credentials.key_secret,
      rawBody,
    );
    const valid = Boolean(provided) && timingSafeEqualStr(expected, provided);

    let eventId = headers.get("x-razorpay-event-id") ?? "";
    let eventType = "";
    let pgOrderId: string | null = null;
    try {
      const body = JSON.parse(rawBody);
      eventType = body.event ?? "";
      pgOrderId =
        body?.payload?.payment?.entity?.order_id ??
        body?.payload?.order?.entity?.id ??
        null;
      if (!eventId)
        eventId = `${eventType}:${body?.payload?.payment?.entity?.id ?? Date.now()}`;
    } catch {
      // malformed body — valid stays as computed; caller stores and 400s
    }
    return { valid, eventId, eventType, pgOrderId };
  },

  /**
   * Razorpay callback scheme: HMAC-SHA256 over `order_id|payment_id` using the
   * KEY SECRET — a different message and secret from the webhook (raw body +
   * webhook secret). Conflating the two is the classic Razorpay bug.
   */
  verifyCallback(
    params: Record<string, string>,
    credentials: Record<string, string>,
  ): boolean {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } =
      params;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
      return false;
    const expected = hmacSha256Hex(
      credentials.key_secret,
      `${razorpay_order_id}|${razorpay_payment_id}`,
    );
    return timingSafeEqualStr(expected, razorpay_signature);
  },
};
