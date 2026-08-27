/**
 * Pine Labs (Plural) adapter — Hosted Checkout, REDIRECT mode.
 *
 * Flow (per Pine Labs hosted-checkout docs):
 *   1. POST /api/auth/v1/token           → bearer token (cached per access code)
 *   2. POST /api/checkout/v1/orders      → { order_id, redirect_url }
 *   3. Buyer redirected to redirect_url
 *   4. Pine Labs POSTs to callback_url   → { order_id, status, signature }
 *   5. GET  /api/pay/v1/orders/{id}      → authoritative status
 *
 * Credential mapping (confirmed with the merchant):
 *   merchant_access_code → client_id
 *   secret_key           → client_secret AND the signature key
 *
 * SIGNATURE SCHEME (easy to get wrong — see verifyCallbackParams):
 *   - secret_key is a HEX STRING that must be decoded to raw bytes for the HMAC key
 *   - message = callback params as `key=value`, sorted lexicographically by key,
 *     joined with `&`, EXCLUDING the signature field itself
 *   - HMAC-SHA256 hex digest, UPPERCASED
 */
import { PgProvider } from "@prisma/client";
import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import type {
  PgAdapter,
  CreateSessionParams,
  CreateSessionResult,
  FetchedPayment,
  WebhookVerification,
} from "./types";
import { sha256Hex } from "../../utils/crypto.server";
import { assertMinorInt } from "../../utils/money.server";
import { AppError } from "../errors.server";
import { logger, errorFields } from "../../utils/logger.server";

const BASE = "https://pluraluat.v2.pinepg.in";

// ---------------------------------------------------------------------------
// Auth — token cached per access code (Plural tokens are short-lived)
// ---------------------------------------------------------------------------
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

function plHeaders(token?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    accept: "application/json",
    "Request-ID": randomUUID(),
    "Request-Timestamp": new Date().toISOString(),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function getAccessToken(creds: Record<string, string>): Promise<string> {
  const cacheKey = creds.merchant_access_code;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;

  let response: Response;
  try {
    response = await fetch(`${BASE}/api/auth/v1/token`, {
      method: "POST",
      headers: plHeaders(),
      body: JSON.stringify({
        client_id: creds.merchant_access_code,
        client_secret: creds.secret_key,
        grant_type: "client_credentials",
      }),
    });
  } catch (error) {
    logger.error("pg.pinelabs.auth_transport_failed", errorFields(error));
    throw new AppError("PG_ERROR", "Could not reach Pine Labs.", 500, {
      cause: error,
    });
  }

  const payload: any = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.access_token) {
    logger.error("pg.pinelabs.auth_failed", {
      status: response.status,
      payload,
    });
    throw new AppError("PG_ERROR", "Pine Labs authentication failed.", 500);
  }

  const ttlMs = (Number(payload.expires_in) || 300) * 1000;
  tokenCache.set(cacheKey, {
    token: payload.access_token,
    expiresAt: Date.now() + ttlMs,
  });
  return payload.access_token;
}

async function plFetch<T>(
  path: string,
  creds: Record<string, string>,
  init?: RequestInit,
): Promise<T> {
  const token = await getAccessToken(creds);

  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      headers: plHeaders(token),
    });
  } catch (error) {
    logger.error("pg.pinelabs.transport_failed", {
      path,
      ...errorFields(error),
    });
    throw new AppError("PG_ERROR", "Could not reach Pine Labs.", 500, {
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
      "Pine Labs returned a malformed response.",
      500,
    );
  }

  if (!response.ok) {
    const message =
      payload?.error_message ?? payload?.message ?? `HTTP ${response.status}`;
    logger.error("pg.pinelabs.api_error", {
      path,
      status: response.status,
      message,
      payload,
    });
    throw new AppError("PG_ERROR", `Pine Labs: ${message}`, 500, {
      detail: { code: payload?.error_code },
    });
  }
  return payload as T;
}

// ---------------------------------------------------------------------------
// Signature — hex-decoded key, sorted key=value&..., uppercase hex digest
// ---------------------------------------------------------------------------

function hexKeyToBytes(hexKey: string): { bytes: Buffer; wasHex: boolean } {
  const clean = hexKey.trim();
  const isHex = /^[0-9a-fA-F]+$/.test(clean) && clean.length % 2 === 0;
  if (!isHex) {
    logger.warn("pg.pinelabs.sig.secret_key_not_hex_falling_back_to_utf8", {
      keyLength: clean.length,
      keyPreview: `${clean.slice(0, 4)}...${clean.slice(-4)}`,
    });
    return { bytes: Buffer.from(clean, "utf8"), wasHex: false };
  }
  return { bytes: Buffer.from(clean, "hex"), wasHex: true };
}

/**
 * Build the canonical message per Pine Labs docs:
 * key=value pairs, SORTED LEXICOGRAPHICALLY by key, joined with &.
 * The `signature` field itself is excluded.
 * Only string/number values are included — null/undefined/object are skipped.
 */
function buildCanonicalMessage(params: Record<string, string>): string {
  const entries = Object.entries(params)
    .filter(
      ([k, v]) =>
        k !== "signature" && v !== undefined && v !== null && v !== "",
    )
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`);
  return entries.join("&");
}

function computePinelabsSignature(
  params: Record<string, string>,
  secretKey: string,
): { signature: string; canonical: string; keyWasHex: boolean } {
  const canonical = buildCanonicalMessage(params);
  const { bytes, wasHex } = hexKeyToBytes(secretKey);
  const signature = createHmac("sha256", bytes)
    .update(canonical, "utf8")
    .digest("hex")
    .toUpperCase();
  return { signature, canonical, keyWasHex: wasHex };
}

/**
 * Exported for the callback route. Logs every step so signature mismatches
 * can be debugged without code changes.
 */
export function verifyPinelabsCallback(
  params: Record<string, string>,
  credentials: Record<string, string>,
): boolean {
  const received = (params.signature ?? "").toUpperCase();

  if (!received) {
    logger.warn("pg.pinelabs.sig.no_signature_in_params", {
      paramKeys: Object.keys(params),
    });
    return false;
  }

  const {
    signature: expected,
    canonical,
    keyWasHex,
  } = computePinelabsSignature(params, credentials.secret_key);

  const match = expected === received;

  // Always log — this is the one place where "it worked" is as valuable as
  // "it failed" because it confirms the exact canonical form that succeeded.
  logger.info("pg.pinelabs.sig.verify", {
    match,
    canonical, // exact string we signed
    expected,
    received,
    paramKeys: Object.keys(params).sort(), // which fields were present
    signingParamKeys: Object.keys(params) // which we actually signed
      .filter(
        (k) => k !== "signature" && params[k] !== undefined && params[k] !== "",
      )
      .sort(),
    secretKeyLength: credentials.secret_key?.length,
    secretKeyWasHex: keyWasHex,
    secretKeyPreview: credentials.secret_key
      ? `${credentials.secret_key.slice(0, 4)}...${credentials.secret_key.slice(-4)}`
      : "MISSING",
  });

  return match;
}

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a.toUpperCase(), "utf8");
  const bufB = Buffer.from(b.toUpperCase(), "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------
function mapOrderStatus(raw: string): FetchedPayment["status"] {
  switch (raw.toUpperCase()) {
    case "PROCESSED":
    case "CAPTURED":
    case "PAID":
      return "CAPTURED";
    case "AUTHORIZED":
      // pre_auth is false for us, so AUTHORIZED shouldn't occur; treat as
      // pending rather than captured — money is not settled.
      return "PENDING";
    case "FAILED":
    case "CANCELLED":
    case "EXPIRED":
      return "FAILED";
    case "CREATED":
    case "":
      return "NOT_ATTEMPTED";
    default:
      return "PENDING";
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------
export const pinelabsAdapter: PgAdapter = {
  pg: PgProvider.PINELABS,

  async createSession(
    params: CreateSessionParams,
  ): Promise<CreateSessionResult> {
    const address = params.shippingAddress;

    const cartItems = params.lines.map((line, index) => ({
      item_id: line.variantId || `item_${index + 1}`,
      item_name: line.title,
      item_quantity: line.quantity,
      // Pine Labs takes minor units, same as order_amount.
      item_original_unit_price: Number(line.unitMinor),
      item_discounted_unit_price: Number(line.unitMinor),
      item_currency: params.currency,
      ...(line.imageUrl ? { item_image_url: line.imageUrl } : {}),
    }));

    const shippingAddress = address
      ? {
          address1: address.address1,
          ...(address.address2 ? { address2: address.address2 } : {}),
          pincode: address.pincode,
          city: address.city,
          state: address.state,
          country: address.country || "IN",
          full_name: address.name,
          address_category: "shipping",
        }
      : undefined;

    const payload: any = await plFetch(
      "/api/checkout/v1/orders",
      params.credentials,
      {
        method: "POST",
        body: JSON.stringify({
          // OUR attempt id — echoed back so we can correlate webhooks.
          merchant_order_reference: params.attemptId,
          order_amount: {
            value: Number(params.amountMinor),
            currency: params.currency,
          },
          integration_mode: "REDIRECT",
          pre_auth: false,
          allowed_payment_methods: ["CARD", "UPI", "NETBANKING", "WALLET"],
          notes: params.requestId,
          callback_url: params.callbackUrl,
          failure_callback_url: params.callbackUrl,
          purchase_details: {
            customer: {
              email_id: params.customer.email,
              first_name: params.customer.name,
              mobile_number: params.customer.phone.replace(/^\+91/, ""),
              country_code: "91",
              ...(shippingAddress ? { shipping_address: shippingAddress } : {}),
            },
            merchant_metadata: {
              spx_attempt_id: params.attemptId,
              spx_request_id: params.requestId,
            },
            cart_details: { cart_items: cartItems },
          },
        }),
      },
    );

    const data = payload?.data ?? payload;
    const pgOrderId = data?.order_id;
    const paymentUrl = data?.redirect_url;

    if (!pgOrderId || !paymentUrl) {
      logger.error("pg.pinelabs.unexpected_checkout_response", { payload });
      throw new AppError(
        "PG_ERROR",
        "Pine Labs did not return a checkout link.",
        500,
      );
    }

    return { pgOrderId, mode: "REDIRECT", paymentUrl };
  },

  async fetchPayment(
    pgOrderId: string,
    credentials: Record<string, string>,
  ): Promise<FetchedPayment> {
    const payload: any = await plFetch(
      `/api/pay/v1/orders/${pgOrderId}`,
      credentials,
    );
    const data = payload?.data ?? payload;

    const status = mapOrderStatus(
      String(data?.order_status ?? data?.status ?? ""),
    );

    const payments = Array.isArray(data?.payments) ? data.payments : [];
    const payment = payments.length
      ? payments[payments.length - 1]
      : (data?.payment ?? null);

    const amountRaw =
      payment?.payment_amount?.value ?? data?.order_amount?.value ?? null;

    return {
      status,
      pgPaymentId: payment?.payment_id ?? data?.payment_id ?? null,
      amountMinor:
        amountRaw != null ? assertMinorInt(amountRaw, "pinelabs.amount") : null,
      currency:
        payment?.payment_amount?.currency ??
        data?.order_amount?.currency ??
        null,
      // Pine Labs surfaces offers under offer_details when one was applied.
      //   offerApplied: Boolean(data?.offer_details ?? payment?.offer_details),
      offerApplied: true, // TODO - We will update the offer applied logic once we have the complete details on how offer works in pinelabs
      failureCode: payment?.error_code ?? data?.error_code ?? null,
      failureReason: payment?.error_message ?? data?.error_message ?? null,
      charged: status === "FAILED" ? false : null,
      raw: data,
    };
  },

  verifyWebhook(
    rawBody: string,
    headers: Headers,
    credentials: Record<string, string>,
  ): WebhookVerification {
    let eventType = "";
    let pgOrderId: string | null = null;
    let eventId = headers.get("x-pinelabs-event-id") ?? "";
    let valid = false;

    try {
      const body = JSON.parse(rawBody);
      const data = body?.data ?? body;

      eventType = body?.event ?? body?.event_type ?? "";
      pgOrderId = data?.order_id ?? null;

      // Log the raw payload first — this shows us exactly what Pine Labs sent.
      logger.info("pg.pinelabs.webhook.raw", {
        eventType,
        pgOrderId,
        dataKeys: Object.keys(data ?? {}),
        headerKeys: [...headers.keys()],
      });

      if (data?.signature) {
        // Flatten any string/number fields for signature verification.
        const flatParams: Record<string, string> = {};
        for (const [k, v] of Object.entries(data)) {
          if (typeof v === "string" || typeof v === "number") {
            flatParams[k] = String(v);
          }
        }
        logger.info("pg.pinelabs.webhook.sig_params", { flatParams });
        valid = verifyPinelabsCallback(flatParams, credentials);
      } else {
        // Try header-based HMAC over raw body as a fallback.
        const headerSig =
          headers.get("x-pinelabs-signature") ??
          headers.get("x-plural-signature") ??
          headers.get("signature") ??
          "";

        logger.info("pg.pinelabs.webhook.no_body_signature_trying_header", {
          headerSigPresent: Boolean(headerSig),
          headerSigPreview: headerSig ? `${headerSig.slice(0, 8)}...` : "NONE",
        });

        if (headerSig) {
          const { bytes } = hexKeyToBytes(credentials.secret_key);
          const expected = createHmac("sha256", bytes)
            .update(rawBody, "utf8")
            .digest("hex")
            .toUpperCase();
          valid = expected === headerSig.toUpperCase();
          logger.info("pg.pinelabs.webhook.header_sig_verify", {
            match: valid,
            expected: `${expected.slice(0, 8)}...`,
            received: `${headerSig.slice(0, 8)}...`,
          });
        }
      }

      if (!eventId) {
        eventId = sha256Hex(
          `${eventType}:${pgOrderId}:${data?.payment_id ?? ""}`,
        );
      }
    } catch (error) {
      logger.warn("pg.pinelabs.webhook.parse_failed", errorFields(error));
    }

    return { valid, eventId, eventType, pgOrderId };
  },

  verifyCallback(
    params: Record<string, string>,
    credentials: Record<string, string>,
  ): boolean {
    return verifyPinelabsCallback(params, credentials);
  },
};
