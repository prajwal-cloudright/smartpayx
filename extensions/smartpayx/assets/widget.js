
const __vite__mapDeps = (
  i,
  m = __vite__mapDeps,
  d = (
    m.f ||
    (m.f = [
      "spx-app-DqalSMYm.js",
      "spx-Confirming-2ohXOwRm.js",
      "spx-mount-CBHaiMh3.js",
    ])
  ),
) => i.map((i) => d[i]);

import { r as v } from "./spx-mount-CBHaiMh3.js";

const E = "modulepreload";

const g = function (e) {
  return "/" + e;
};

const f = {};

const P = function (t, a, u) {
  let s = Promise.resolve();

  if (a && a.length > 0) {
    document.getElementsByTagName("link");

    const n = document.querySelector("meta[property=csp-nonce]");
    const o =
      (n == null ? void 0 : n.nonce) ||
      (n == null ? void 0 : n.getAttribute("nonce"));

    s = Promise.allSettled(
      a.map((r) => {
        if ((r = g(r)) in f) return;

        f[r] = !0;

        const l = r.endsWith(".css");
        const y = l ? '[rel="stylesheet"]' : "";

        if (document.querySelector(`link[href="${r}"]${y}`)) {
          return;
        }

        const c = document.createElement("link");

        c.rel = l ? "stylesheet" : E;

        if (!l) c.as = "script";

        c.crossOrigin = "";
        c.href = r;

        if (o) c.setAttribute("nonce", o);

        document.head.appendChild(c);

        if (l) {
          return new Promise((S, b) => {
            c.addEventListener("load", S);
            c.addEventListener("error", () =>
              b(new Error(`Unable to preload CSS for ${r}`)),
            );
          });
        }
      }),
    );
  }

  function i(n) {
    const o = new Event("vite:preloadError", {
      cancelable: !0,
    });

    o.payload = n;

    window.dispatchEvent(o);

    if (!o.defaultPrevented) throw n;
  }

  return s.then((n) => {
    for (const o of n || []) {
      if (o.status === "rejected") i(o.reason);
    }

    return t().catch(i);
  });
};

const w = "spx-embed-settings";
const d = v(w);

const _ = [
  'form[action*="/checkout"] [type="submit"]',
  'form[action*="/cart"] button[name="checkout"]',
  'input[name="checkout"]',
  'button[name="checkout"]',
  'a[href*="/checkout"]:not([href*="checkout.shopify"])',
  ".cart__checkout-button",
  "#CartDrawer-Checkout",
  '[data-testid="Checkout-button"]',
  d.custom_selector,
].filter(Boolean);

let m = null;

/**
 * Find the active Shopify cart drawer.
 */
function findCartDrawer() {
  const selectors = [
    "cart-drawer",
    "#CartDrawer",
    "#CartDrawer-Overlay",
    '[id="cart-drawer"]',
    '[role="dialog"][aria-label*="cart" i]',
  ];

  for (const selector of selectors) {
    const drawer = document.querySelector(selector);

    if (drawer) return drawer;
  }

  return null;
}

/**
 * Close only the Shopify cart drawer.
 * Do not hide the storefront or change page visibility.
 */
function closeShopifyCartDrawer() {
  const drawer = findCartDrawer();

  if (!drawer) {
    console.info("[SmartPayX] No Shopify cart drawer found");
    return;
  }

  const closeButton = drawer.querySelector(
    [
      'button[aria-label*="close" i]',
      'button[name="close"]',
      ".drawer__close",
      ".cart-drawer__close",
      "[data-cart-drawer-close]",
      ".modal__close-button",
    ].join(","),
  );

  if (closeButton) {
    closeButton.click();
    console.info("[SmartPayX] Shopify cart drawer close button clicked");
    return;
  }

  // Shopify Dawn themes commonly support this method.
  if (typeof drawer.close === "function") {
    drawer.close();
    console.info("[SmartPayX] Shopify cart drawer closed");
    return;
  }

  console.warn(
    "[SmartPayX] Cart drawer found, but its close control was not recognized",
    drawer,
  );
}

function L() {
  return (
    m ??
    (m = P(
      () => import("./spx-app-DqalSMYm.js"),
      __vite__mapDeps([0, 1, 2]),
    )),
    m
  );
}

async function k(e) {
  (await L()).open({ settings: d, ...e });
}

function C(e) {
  try {
    if (d.enabled !== !0) return;

    e.preventDefault();
    e.stopImmediatePropagation();

    // Close the cart drawer before opening SmartPayX.
    closeShopifyCartDrawer();

    k({
      returnPath: location.pathname + location.search,
    }).catch((t) => {
      console.warn(
        "[SmartPayX] open failed, falling back to native checkout",
        t,
      );

      m = null;
      location.assign("/checkout");
    });
  } catch (t) {
    console.warn(
      "[SmartPayX] intercept error, native checkout takes over",
      t,
    );
  }
}

function I(e) {
  if (!e || e.dataset.spxBound) return;

  e.dataset.spxBound = "1";
  e.addEventListener("click", C, true);
}

function h(e) {
  for (const t of _) {
    try {
      e.querySelectorAll(t).forEach(I);
    } catch {
      // Ignore invalid or theme-specific selectors.
    }
  }
}

function p() {
  h(document);

  new MutationObserver((u) => {
    for (const s of u) {
      for (const i of s.addedNodes) {
        if (i.nodeType === 1) h(i);
      }
    }
  }).observe(document.body, {
    childList: true,
    subtree: true,
  });

  const t = new URLSearchParams(location.search);
  const a = t.get("spx_resume");

  if (a && d.enabled === !0) {
    t.delete("spx_resume");
    t.delete("txn");

    const u =
      location.pathname +
      (t.toString() ? `?${t}` : "") +
      location.hash;

    history.replaceState(null, "", u);

    k({ resumeRequestId: a }).catch((s) =>
      console.warn("[SmartPayX] resume open failed", s),
    );
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", p, {
    once: true,
  });
} else {
  p();
}
