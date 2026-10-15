/**
 * SmartPayX API client. All calls go through the Shopify App Proxy
 * (/apps/smartpayx/*), same-origin to the storefront. The customer token
 * travels in X-SPX-Auth; the server is the sole authority on its validity.
 */
const BASE = "/apps/smartpayx";
const TOKEN_KEY = "spx_auth_token";
const HORIZON_CART_LINES_UPDATE = "shopify:cart:lines-update";

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

  if (query) {
    for (const [k, v] of Object.entries(query)) {
      url.searchParams.set(k, v);
    }
  }

  const headers = { "Content-Type": "application/json" };
  const token = auth.get();

  if (token) {
    headers["X-SPX-Auth"] = token;
  }

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
    /* Empty or non-JSON response. */
  }

  if (!res.ok) {
    const err = payload?.error ?? {};

    if (res.status === 401) {
      auth.clear();
    }

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

  request: (cartToken) =>
    call("POST", "/request", { cart_token: cartToken }),

  shippingAddress: (payload) =>
    call("POST", "/shipping-address", payload),

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

  pincode: (pin) =>
    call("GET", `/pincode/${encodeURIComponent(pin)}`),

  cancelRequest: (requestId) =>
    call("POST", "/cancel-request", { request_id: requestId }),

  cancelAttempt: (requestId) =>
    call("POST", "/cancel-attempt", { request_id: requestId }),
};

/**
 * Convert Shopify's AJAX cart response into the shape expected by
 * Horizon's cart icon event handler.
 */
function toHorizonCart(cart) {
  if (!cart) return null;

  const currencyCode = cart.currency || "INR";

  return {
    id: cart.token || "smartpayx-cart",
    totalQuantity: Number(cart.item_count ?? 0),
    cost: {
      totalAmount: {
        amount: (Number(cart.total_price ?? 0) / 100).toFixed(2),
        currencyCode,
      },
    },
    lines: (Array.isArray(cart.items) ? cart.items : []).map((item) => ({
      id: String(item.key || item.id),
      quantity: Number(item.quantity ?? 0),
      cost: {
        totalAmount: {
          amount: (Number(item.final_line_price ?? 0) / 100).toFixed(2),
          currencyCode,
        },
      },
    })),
    discountCodes: (Array.isArray(cart.discount_codes)
      ? cart.discount_codes
      : []
    ).map((discount) => ({
      code: discount.code,
      applicable: Boolean(discount.applicable),
    })),
  };
}

/**
 * Save the latest confirmed cart count for Horizon's header.
 * This also helps the header on the next page load, after checkout redirects.
 */
function saveHorizonCartCount(itemCount) {
  try {
    sessionStorage.setItem(
      "cart-count",
      JSON.stringify({
        value: String(itemCount),
        timestamp: Date.now(),
      }),
    );
  } catch {
    // Storage may be unavailable; cart completion should still continue.
  }
}

/**
 * Dispatch Horizon's standard cart-lines-update event.
 *
 * Horizon's cart icon listens for this event and updates its bubble
 * when event.promise resolves with { cart, detail }.
 */
function notifyHorizonCartUpdate(cart) {
  const itemCount = Number(cart?.item_count ?? 0);

  // Save before navigation so Horizon can correct the count on the next page.
  saveHorizonCartCount(itemCount);

  const event = new CustomEvent(HORIZON_CART_LINES_UPDATE, {
    bubbles: true,
    detail: {
      source: "smartpayx",
      itemCount,
    },
  });

  // Horizon reads event.promise, so provide a promise with the expected result.
  event.promise = Promise.resolve({
    cart: toHorizonCart(cart),
    detail: {
      itemCount,
      source: "smartpayx",
    },
  });

  document.dispatchEvent(event);
}

/** Storefront cart helpers (Shopify AJAX API, not ours). */
export const storefrontCart = {
  async token() {
    try {
      const res = await fetch("/cart.js", {
        headers: { accept: "application/json" },
      });

      if (!res.ok) return null;

      const cart = await res.json();
      return cart?.token ?? null;
    } catch {
      return null;
    }
  },

  async clear() {
    try {
      const clearResponse = await fetch("/cart/clear.js", {
        method: "POST",
        headers: {
          accept: "application/json",
        },
      });

      if (!clearResponse.ok) {
        return false;
      }

      // Fetch the real cart state after Shopify clears it.
      const cartResponse = await fetch("/cart.js", {
        headers: {
          accept: "application/json",
        },
      });

      if (!cartResponse.ok) {
        return false;
      }

      const cart = await cartResponse.json();

      // Update Horizon only with Shopify's confirmed cart state.
      notifyHorizonCartUpdate(cart);

      return Number(cart.item_count ?? 0) === 0;
    } catch {
      // Cart clearing must not break payment/order completion.
      return false;
    }
  },
};
