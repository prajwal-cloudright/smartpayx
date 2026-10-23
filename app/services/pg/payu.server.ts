/**
 * PayU India adapter — Hosted Checkout, REDIRECT mode.
 *
 * Flow:
 *   1. createSession builds the signed `_payment` form fields (SHA-512 request
 *      hash) and returns a URL on OUR server (/pay/payu?d=...). PayU's
 *      checkout only accepts a browser form POST, so that route renders an
 *      auto-submitting form. The fields carry no secret — the hash is a
 *      one-way SHA-512 that includes the salt — so they can ride in the URL.
 *   2. Buyer pays on PayU; PayU form-POSTs the result to surl/furl, which are
 *      both our /callbacks/payu URL (with attempt/origin/path params attached).
 *   3. verifyCallback checks PayU's REVERSE hash. That is a trigger only: the
 *      resolver then re-fetches authoritative status via fetchPayment.
 *   4. fetchPayment calls the `verify_payment` command of PayU's postservice
 *      API (server-to-server, hashed with key|command|var1|salt).
 *
 * Credentials: merchant_key, merchant_salt, environment ("live" | "test").
 *
 * HASH SCHEMES (easy to get wrong):
 *   request : sha512(key|txnid|amount|productinfo|firstname|email|udf1..udf5||||||SALT)
 *   response: sha512([additionalCharges|]SALT|status||||||udf5..udf1|email|firstname|productinfo|amount|txnid|key)
 *   api call: sha512(key|command|var1|SALT)
 * The empty segments are positional (udf6..udf10) — the pipe counts matter.
 *
 * txnid: PayU caps it at 25 chars, so it cannot be our UUID attempt id. We
 * mint a short random one (stored as payment_attempts.pg_order_id) and carry
 * the attempt id in udf1.
 */
import { PgProvider } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";
import type {
  PgAdapter,
  CreateSessionParams,
  CreateSessionResult,
  FetchedPayment,
  WebhookVerification,
} from "./types";
import { sha256Hex, timingSafeEqualStr } from "../../utils/crypto.server";
import { fromMinor, toMinor } from "../../utils/money.server";
import { AppError, ValidationError } from "../errors.server";
import { logger, errorFields } from "../../utils/logger.server";

export type PayuEnvironment = "live" | "test";

const ENDPOINTS: Record<PayuEnvironment, { pay: string; api: string }> = {
  live: {
    pay: "https://secure.payu.in/_payment",
    api: "https://info.payu.in/merchant/postservice.php?form=2",
  },
  test: {
    pay: "https://test.payu.in/_payment",
    api: "https://test.payu.in/merchant/postservice.php?form=2",
  },
};

/** Form fields our hosted-form route is allowed to submit to PayU. */
export const PAYU_FORM_FIELDS = [
  "key",
  "txnid",
  "amount",
  "productinfo",
  "firstname",
  "email",
  "phone",
  "surl",
  "furl",
  "hash",
  "udf1",
  "service_provider",
  "enforce_paymethod",              
] as const;

export function payuPaymentUrl(env: PayuEnvironment): string {
  return ENDPOINTS[env].pay;
}

function environmentOf(creds: Record<string, string>): PayuEnvironment {
  return (creds.environment ?? "").trim().toLowerCase() === "test"
    ? "test"
    : "live";
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------
function sha512Hex(input: string): string {
  return createHash("sha512").update(input, "utf8").digest("hex");
}

export function computeRequestHash(
  f: {
    key: string;
    txnid: string;
    amount: string;
    productinfo: string;
    firstname: string;
    email: string;
    udf1?: string;
    udf2?: string;
    udf3?: string;
    udf4?: string;
    udf5?: string;
  },
  salt: string,
): string {
  return sha512Hex(
    [
      f.key,
      f.txnid,
      f.amount,
      f.productinfo,
      f.firstname,
      f.email,
      f.udf1 ?? "",
      f.udf2 ?? "",
      f.udf3 ?? "",
      f.udf4 ?? "",
      f.udf5 ?? "",
      "", // udf6..udf10 are unused but positional
      "",
      "",
      "",
      "",
      salt,
    ].join("|"),
  );
}

export function computeResponseHash(
  p: Record<string, string>,
  salt: string,
): string {
  const g = (k: string) => p[k] ?? "";
  const parts = [
    salt,
    g("status"),
    "",
    "",
    "",
    "",
    "",
    g("udf5"),
    g("udf4"),
    g("udf3"),
    g("udf2"),
    g("udf1"),
    g("email"),
    g("firstname"),
    g("productinfo"),
    g("amount"),
    g("txnid"),
    g("key"),
  ];
  // PayU prepends additionalCharges to the sequence when it charged any.
  if (p.additionalCharges) parts.unshift(p.additionalCharges);
  return sha512Hex(parts.join("|"));
}

function verifyResponseHash(
  params: Record<string, string>,
  creds: Record<string, string>,
): boolean {
  const received = (params.hash ?? "").toLowerCase();
  if (!received || !creds.merchant_salt) return false;
  // A response for someone else's merchant key is never ours.
  if (params.key && params.key !== creds.merchant_key) return false;
  const expected = computeResponseHash(params, creds.merchant_salt);
  return timingSafeEqualStr(expected, received);
}

// ---------------------------------------------------------------------------
// Server-to-server API
// ---------------------------------------------------------------------------
async function payuApi<T>(
  command: string,
  var1: string,
  creds: Record<string, string>,
): Promise<T> {
  const hash = sha512Hex(
    [creds.merchant_key, command, var1, creds.merchant_salt].join("|"),
  );
  let response: Response;
  try {
    response = await fetch(ENDPOINTS[environmentOf(creds)].api, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        key: creds.merchant_key,
        command,
        var1,
        hash,
      }).toString(),
    });
  } catch (error) {
    logger.error("pg.payu.transport_failed", {
      command,
      ...errorFields(error),
    });
    throw new AppError("PG_ERROR", "Could not reach PayU.", 500, {
      cause: error,
    });
  }

  const text = await response.text();
  let payload: any;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    logger.error("pg.payu.malformed_response", {
      command,
      status: response.status,
    });
    throw new AppError("PG_ERROR", "PayU returned a malformed response.", 500);
  }

  if (!response.ok) {
    logger.error("pg.payu.api_error", {
      command,
      status: response.status,
      msg: payload?.msg,
    });
    throw new AppError(
      "PG_ERROR",
      `PayU: ${payload?.msg ?? `HTTP ${response.status}`}`,
      500,
    );
  }
  return payload as T;
}

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------
function mapStatus(status: string, unmapped: string): FetchedPayment["status"] {
  const s = status.toLowerCase();
  const u = unmapped.toLowerCase();

  if (s === "success" && (u === "captured" || u === "")) return "CAPTURED";
  // "auth" = authorised but not captured yet: money isn't settled.
  if (u === "auth" || u === "pending" || s === "pending") return "PENDING";
  if (
    s === "failure" ||
    s === "failed" ||
    ["failed", "usercancelled", "bounced", "dropped", "timeout"].includes(u)
  )
    return "FAILED";
  if (s === "not found" || u === "initiated" || s === "") {
    return "NOT_ATTEMPTED";
  }
  return "PENDING";
}

function toMinorSafe(value: unknown): bigint | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return toMinor(n.toFixed(2));
}

/** Short alphanumeric txnid — PayU allows max 25 chars. */
function mintTxnId(): string {
  return `SPX${randomBytes(10).toString("hex")}`; // 3 + 20 = 23 chars
}

function cleanName(name: string): string {
  return (
    name
      .replace(/[^A-Za-z0-9 ]/g, "")
      .trim()
      .slice(0, 60) || "Customer"
  );
}

function b64urlEncode(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

/** Decode the `d` param of /pay/payu. Returns null on anything malformed. */
export function decodePayuFormToken(
  token: string,
): { env: PayuEnvironment; fields: Record<string, string> } | null {
  try {
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    const env = parsed?.e;
    if (env !== "live" && env !== "test") return null;
    const fields: Record<string, string> = {};
    for (const key of PAYU_FORM_FIELDS) {
      const value = parsed?.f?.[key];
      if (typeof value === "string" && value.length <= 2048)
        fields[key] = value;
    }
    for (const required of ["key", "txnid", "amount", "hash", "surl", "furl"]) {
      if (!fields[required]) return null;
    }
    return { env, fields };
  } catch {
    return null;
  }
}

/**
 * PayU webhooks arrive form-encoded by default but can be configured as JSON.
 * Accept both and flatten to string params.
 */
export function parsePayuBody(rawBody: string): Record<string, string> {
  const out: Record<string, string> = {};
  const trimmed = rawBody.trim();
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed);
    for (const [k, v] of Object.entries(parsed?.data ?? parsed ?? {})) {
      if (typeof v === "string" || typeof v === "number") out[k] = String(v);
    }
    return out;
  }
  for (const [k, v] of new URLSearchParams(trimmed)) out[k] = v;
  return out;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------
export const payuAdapter: PgAdapter = {
  pg: PgProvider.PAYU,

  async createSession(
    params: CreateSessionParams,
  ): Promise<CreateSessionResult> {
    if (params.currency !== "INR") {
      throw new ValidationError(
        `PayU supports INR only; got ${params.currency}.`,
        { currency: params.currency },
      );
    }
    const creds = params.credentials;
    const env = environmentOf(creds);

    const txnid = mintTxnId();
    const amount = fromMinor(params.amountMinor);
    const productinfo = "SmartPayX Order";
    const firstname = cleanName(params.customer.name);
    const email = params.customer.email;
    const udf1 = params.attemptId; // full UUID — too long for txnid

    const hash = computeRequestHash(
      { key: creds.merchant_key, txnid, amount, productinfo, firstname, email, udf1 },
      creds.merchant_salt,
    );
    const cleanCallback = new URL(params.callbackUrl);
    cleanCallback.search = "";
    const fields: Record<string, string> = {
      key: creds.merchant_key,
      txnid,
      amount,
      productinfo,
      firstname,
      email,
      phone: params.customer.phone.replace(/\D/g, "").slice(-10),
      // surl: params.callbackUrl,
      // furl: params.callbackUrl,
      // surl: cleanCallback.toString(),
      // furl: cleanCallback.toString(),
      surl: "https://smartpayx.cloudright.in/callbacks/payu",
      furl: "https://smartpayx.cloudright.in/callbacks/payu",
      udf1,
      service_provider: "payu_paisa",
      hash,
    };
        if (params.paymentMethod === "NETBANKING") {
      fields.enforce_paymethod = "netbanking";
    }
    const origin = new URL(params.callbackUrl).origin;
    const paymentUrl = `${origin}/pay/payu?d=${b64urlEncode({ e: env, f: fields })}`;

    return { pgOrderId: txnid, mode: "REDIRECT", paymentUrl };
  },

  async fetchPayment(
    pgOrderId: string,
    credentials: Record<string, string>,
  ): Promise<FetchedPayment> {
    const payload: any = await payuApi(
      "verify_payment",
      pgOrderId,
      credentials,
    );

    let detail: any = payload?.transaction_details?.[pgOrderId];
    // Several attempts on one txnid may come back as a list — prefer success.
    if (Array.isArray(detail)) {
      detail =
        detail.find((d) => String(d?.status).toLowerCase() === "success") ??
        detail[detail.length - 1];
    }

    if (!detail || typeof detail !== "object") {
      return {
        status: "NOT_ATTEMPTED",
        pgPaymentId: null,
        amountMinor: null,
        currency: null,
        offerApplied: false,
        raw: payload,
      };
    }

    const status = mapStatus(
      String(detail.status ?? ""),
      String(detail.unmappedstatus ?? ""),
    );

    const requested = toMinorSafe(detail.amt ?? detail.transaction_amount);
    // net_amount_debit is what the buyer actually paid after any PayU offer.
    const debited = toMinorSafe(detail.net_amount_debit) ?? requested;
    const discount = toMinorSafe(detail.disc) ?? 0n;
    const offerApplied =
      discount > 0n ||
      (requested !== null && debited !== null && debited < requested);

    const failed = status === "FAILED";
    const errorCode = detail.error_code ? String(detail.error_code) : null;

    return {
      status,
      pgPaymentId:
        detail.mihpayid && detail.mihpayid !== "Not Found"
          ? String(detail.mihpayid)
          : null,
      amountMinor: status === "CAPTURED" ? debited : requested,
      currency: "INR",
      offerApplied,
      failureCode: failed && errorCode !== "E000" ? errorCode : null,
      failureReason: failed
        ? (detail.error_Message ?? detail.field9 ?? null)
        : null,
      // A failed/cancelled/bounced PayU txn was not settled to the merchant.
      charged: failed ? false : null,
      raw: detail,
    };
  },

  verifyWebhook(
    rawBody: string,
    _headers: Headers,
    credentials: Record<string, string>,
  ): WebhookVerification {
    let params: Record<string, string> = {};
    try {
      params = parsePayuBody(rawBody);
    } catch (error) {
      logger.warn("pg.payu.webhook.parse_failed", errorFields(error));
    }

    const valid = verifyResponseHash(params, credentials);
    const eventType = params.status ?? "";
    const pgOrderId = params.txnid ?? null;
    const eventId = sha256Hex(
      `payu:${params.mihpayid ?? ""}:${pgOrderId ?? ""}:${eventType}:${params.unmappedstatus ?? ""}`,
    );

    return { valid, eventId, eventType, pgOrderId };
  },

  verifyCallback(
    params: Record<string, string>,
    credentials: Record<string, string>,
  ): boolean {
    return verifyResponseHash(params, credentials);
  },
};
