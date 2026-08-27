/**
 * SmartPayX API client. All calls go through the Shopify App Proxy
 * (/apps/smartpayx/*), same-origin to the storefront. The customer token
 * travels in X-SPX-Auth; the server is the sole authority on its validity.
 */
const BASE = "/apps/smartpayx";
const TOKEN_KEY = "spx_auth_token";

export const auth = {
  get: () => {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set: (t) => {
    try {
      localStorage.setItem(TOKEN_KEY, t);
    } catch {}
  },
  clear: () => {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {}
  },
};

export class ApiError extends Error {
  constructor(code, message, status, detail) {
    super(message);
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

async function call(method, path, body, query) {
  const url = new URL(BASE + path, location.origin);
  if (query)
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

  const headers = { "Content-Type": "application/json" };
  const token = auth.get();
  if (token) headers["X-SPX-Auth"] = token;

  let res;
  try {
    res = await fetch(url.toString(), {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(
      "NETWORK",
      "Couldn't connect. Check your internet and try again.",
      0,
    );
  }

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    /* empty body */
  }

  if (!res.ok) {
    const err = payload?.error ?? {};
    if (res.status === 401) auth.clear(); // server said the token is dead — drop it
    throw new ApiError(
      err.code ?? "UNKNOWN",
      err.message ?? "Something went wrong.",
      res.status,
      err,
    );
  }
  return payload;
}

export const api = {
  sendOtp: (phone, challengeId) =>
    call("POST", "/auth/otp/send", {
      phone,
      ...(challengeId ? { challenge_id: challengeId } : {}),
    }),
  verifyOtp: (challengeId, phone, code) =>
    call("POST", "/auth/otp/verify", {
      challenge_id: challengeId,
      phone,
      code,
    }),
  request: (cartToken) => call("POST", "/request", { cart_token: cartToken }),
  shippingAddress: (payload) => call("POST", "/shipping-address", payload),
  offers: (requestId) =>
    call("GET", "/offers", null, { request_id: requestId }),
  payment: (requestId, pg, returnPath) =>
    call("POST", "/payment", {
      request_id: requestId,
      pg,
      return_path: returnPath,
    }),
  paymentStatus: (requestId) =>
    call("GET", "/payment-status", null, { request_id: requestId }),
  order: (appOrderId) =>
    call("GET", `/order/${encodeURIComponent(appOrderId)}`),
  pincode: (pin) => call("GET", `/pincode/${encodeURIComponent(pin)}`),
  cancelRequest: (requestId) =>
    call("POST", "/cancel-request", { request_id: requestId }),
  cancelAttempt: (requestId) =>
    call("POST", "/cancel-attempt", { request_id: requestId }),
};

/** Storefront cart helpers (Shopify AJAX API, not ours). */
export const storefrontCart = {
  async token() {
    const res = await fetch("/cart.js", {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const cart = await res.json();
    return cart?.token ?? null;
  },
  async clear() {
    try {
      await fetch("/cart/clear.js", { method: "POST" });
    } catch {
      /* non-fatal */
    }
  },
};
