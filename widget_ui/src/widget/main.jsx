/**
 * widget.js — SmartPayX checkout loader.
 * Intercepts checkout clicks, closes the Shopify cart drawer,
 * and opens the SmartPayX checkout panel.
 */
import { readBlockSettings } from "../shared/mount";

const SETTINGS_ID = "spx-embed-settings";
const settings = readBlockSettings(SETTINGS_ID);

const SELECTORS = [
  'form[action*="/checkout"] [type="submit"]',
  'form[action*="/cart"] button[name="checkout"]',
  'input[name="checkout"]',
  'button[name="checkout"]',
  'a[href*="/checkout"]:not([href*="checkout.shopify"])',
  ".cart__checkout-button",
  "#CartDrawer-Checkout",
  '[data-testid="Checkout-button"]',
  settings.custom_selector,
].filter(Boolean);

let appPromise = null;
let savedDrawerStyles = new Map();
let savedBackdropStyles = new Map();

function loadApp() {
  appPromise ??= import("./app.jsx");
  return appPromise;
}

function saveInlineStyles(element, properties, store) {
  if (store.has(element)) return;

  store.set(
    element,
    properties.map((property) => ({
      property,
      value: element.style.getPropertyValue(property),
      priority: element.style.getPropertyPriority(property),
    })),
  );
}

function restoreStyles(store) {
  for (const [element, styles] of store) {
    if (!element.isConnected) continue;

    for (const { property, value, priority } of styles) {
      if (value) {
        element.style.setProperty(property, value, priority);
      } else {
        element.style.removeProperty(property);
      }
    }
  }

  store.clear();
}

/**
 * Close the Shopify cart drawer without permanently changing its styles.
 */
function closeShopifyCartDrawer() {
  const host = document.getElementById("spx-widget-host");

  const drawerSelectors = [
    "cart-drawer",
    "#CartDrawer",
    ".cart-drawer",
    ".drawer",
    '[id*="CartDrawer"]',
    '[class*="cart-drawer"]',
    "[data-cart-drawer]",
    '[role="dialog"][aria-label*="cart" i]',
  ];

  const closeSelectors = [
    "button.drawer__close",
    ".cart-drawer__close",
    "[data-cart-drawer-close]",
    'button[aria-label*="close" i]',
    'button[title*="close" i]',
    'button[name="close"]',
    ".drawer__close-button",
  ];

  const found = new Set();

  for (const selector of drawerSelectors) {
    try {
      document.querySelectorAll(selector).forEach((el) => {
        if (
          el !== host &&
          !(host && el.contains(host))
        ) {
          found.add(el);
        }
      });
    } catch {
      // Ignore unsupported selectors.
    }
  }

  for (const drawer of found) {
    try {
      const style = getComputedStyle(drawer);
      const rect = drawer.getBoundingClientRect();
      const visible =
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0;

      if (!visible) continue;

      // Remember the original styles before changing anything.
      saveInlineStyles(
        drawer,
        ["visibility", "pointer-events"],
        savedDrawerStyles,
      );

      // Prefer the theme's own close controls.
      for (const selector of closeSelectors) {
        const buttons = drawer.querySelectorAll(selector);

        for (const button of buttons) {
          if (
            button instanceof HTMLElement &&
            !button.disabled &&
            button.getClientRects().length > 0
          ) {
            button.click();
          }
        }
      }

      // Use the drawer's native close method when available.
      if (typeof drawer.close === "function") {
        drawer.close();
      }

      // Do not remove the drawer's attributes or classes.
      // Those may be required by the Shopify theme to reopen it.
      drawer.style.setProperty("visibility", "hidden", "important");
      drawer.style.setProperty("pointer-events", "none", "important");
    } catch (err) {
      console.warn("[SmartPayX] Could not close cart drawer", err);
    }
  }

  // Temporarily hide backdrops and remember their original styles.
  const backdropSelectors = [
    ".cart-drawer__overlay",
    ".drawer__overlay",
    ".drawer-overlay",
    "[data-cart-overlay]",
    ".modal-overlay",
  ];

  for (const selector of backdropSelectors) {
    try {
      document.querySelectorAll(selector).forEach((el) => {
        saveInlineStyles(
          el,
          ["visibility", "opacity", "pointer-events"],
          savedBackdropStyles,
        );

        el.style.setProperty("visibility", "hidden", "important");
        el.style.setProperty("opacity", "0", "important");
        el.style.setProperty("pointer-events", "none", "important");
      });
    } catch {
      // Ignore unsupported selectors.
    }
  }
}

/**
 * Restore Shopify drawer and backdrop styles when SmartPayX closes.
 */
function restoreShopifyCartDrawerStyles() {
  restoreStyles(savedDrawerStyles);
  restoreStyles(savedBackdropStyles);
}

async function openWidget(opts) {
  const mod = await loadApp();
  mod.open({ settings, ...opts });
}

function onIntercept(e) {
  try {
    if (settings.enabled !== true) return;

    e.preventDefault();
    e.stopImmediatePropagation();

    closeShopifyCartDrawer();

    openWidget({
      returnPath: location.pathname + location.search,
    }).catch((err) => {
      console.warn(
        "[SmartPayX] open failed, falling back to native checkout",
        err,
      );

      restoreShopifyCartDrawerStyles();
      appPromise = null;
      location.assign("/checkout");
    });
  } catch (err) {
    console.warn(
      "[SmartPayX] intercept error, native checkout takes over",
      err,
    );

    restoreShopifyCartDrawerStyles();
  }
}

function bind(el) {
  if (!el || el.dataset.spxBound) return;

  el.dataset.spxBound = "1";
  el.addEventListener("click", onIntercept, true);
}

function scan(rootEl) {
  for (const selector of SELECTORS) {
    try {
      rootEl.querySelectorAll(selector).forEach(bind);
    } catch {
      // Ignore invalid custom selectors.
    }
  }
}

function start() {
  scan(document);

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === 1) scan(node);
      }
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  const params = new URLSearchParams(location.search);
  const resumeId = params.get("spx_resume");

  if (resumeId && settings.enabled === true) {
    params.delete("spx_resume");
    params.delete("txn");

    const clean =
      location.pathname +
      (params.toString() ? `?${params}` : "") +
      location.hash;

    history.replaceState(null, "", clean);

    closeShopifyCartDrawer();

    openWidget({ resumeRequestId: resumeId }).catch((err) =>
      console.warn("[SmartPayX] resume open failed", err),
    );
  }
}

// Listen for SmartPayX closing without modifying the checkout app.
window.addEventListener("spx:checkout-closed", restoreShopifyCartDrawerStyles);

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}
