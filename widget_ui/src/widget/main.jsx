/**
 * widget.js — the TINY loader. This is all that runs on every page view:
 * interception + resume detection. The React app is a dynamic import() that
 * Rollup splits into its own chunk, downloaded only when checkout actually
 * opens. Keep this file dependency-free (no React) so it stays small.
 *
 * PRIME DIRECTIVE: any failure falls through to native checkout. A broken
 * widget must degrade to a working Shopify checkout, never a dead button.
 */
import { readBlockSettings } from "../shared/mount";

const SETTINGS_ID = "spx-embed-settings";
const settings = readBlockSettings(SETTINGS_ID);

/* Theme-independent selectors + merchant-configured extra from block settings. */
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
function loadApp() {
  // Single-flight dynamic import — this is the lazy-loaded chunk.
  appPromise ??= import("./app.jsx");
  return appPromise;
}

async function openWidget(opts) {
  const mod = await loadApp();
  mod.open({ settings, ...opts });
}

function onIntercept(e) {
  try {
    if (settings.enabled !== true) return; // metafield said off — native proceeds
    e.preventDefault();
    e.stopImmediatePropagation();
    openWidget({ returnPath: location.pathname + location.search }).catch((err) => {
      console.warn("[SmartPayX] open failed, falling back to native checkout", err);
      // Re-dispatch nothing — the buyer clicks again and this handler's failure
      // path won't preventDefault a second time because appPromise is poisoned.
      appPromise = null;
      location.assign("/checkout");
    });
  } catch (err) {
    console.warn("[SmartPayX] intercept error, native checkout takes over", err);
  }
}

function bind(el) {
  if (!el || el.dataset.spxBound) return;
  el.dataset.spxBound = "1";
  el.addEventListener("click", onIntercept, true); // capture: run before theme handlers
}

function scan(rootEl) {
  for (const sel of SELECTORS) {
    try { rootEl.querySelectorAll(sel).forEach(bind); } catch { /* bad custom selector */ }
  }
}

function start() {
  scan(document);
  // Drawers, quick-views and infinite scroll inject buttons after load.
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const node of m.addedNodes) {
        if (node.nodeType === 1) { scan(node); }
      }
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });

  // Resume: returning from the PG via /callbacks/:pg lands here with params.
  const params = new URLSearchParams(location.search);
  const resumeId = params.get("spx_resume");
  if (resumeId && settings.enabled === true) {
    params.delete("spx_resume");
    params.delete("txn");
    const clean = location.pathname + (params.toString() ? `?${params}` : "") + location.hash;
    history.replaceState(null, "", clean);
    openWidget({ resumeRequestId: resumeId }).catch((err) =>
      console.warn("[SmartPayX] resume open failed", err),
    );
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}
