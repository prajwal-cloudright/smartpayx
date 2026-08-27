/**
 * Shadow-root mounting shared by both entries.
 *
 * Two hard-won constraints encoded here:
 *  1. The host is a CUSTOM ELEMENT, not a <div>. Themes commonly ship
 *     `div:empty { display: none }`, and shadow-DOM children do NOT satisfy
 *     :empty — a div host would count as empty forever and stay hidden.
 *  2. Layout-critical properties are set INLINE with !important, because the
 *     host lives in the light DOM where theme CSS can reach it. `:host` rules
 *     lose to page stylesheets; inline !important does not.
 *
 * CSS is injected INTO the shadow root (?inline import) — Vite's default
 * head-injection would put styles outside the boundary where they do nothing.
 */
import cssText from "./theme.css?inline";

export function createShadowMount(id, palette, { overlay = true } = {}) {
  let host = document.getElementById(id);
  if (!host) {
    host = document.createElement("spx-checkout-root");
    host.id = id;
    document.body.appendChild(host);
  }

  const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  if (!root.querySelector("style[data-spx]")) {
    const style = document.createElement("style");
    style.dataset.spx = "1";
    style.textContent = cssText;
    root.appendChild(style);
  }

  if (overlay) {
    // The host IS the viewport layer: no dependence on a theme ancestor's
    // positioning context, and immune to a transform/filter containing block.
    host.style.setProperty("display", "block", "important");
    host.style.setProperty("position", "fixed", "important");
    host.style.setProperty("inset", "0", "important");
    host.style.setProperty("z-index", "2147483000", "important");
    host.style.setProperty("visibility", "visible", "important");
    host.style.setProperty("opacity", "1", "important");
    host.style.setProperty("pointer-events", "auto", "important");
  } else {
    host.style.setProperty("display", "block", "important");
    host.style.setProperty("position", "static", "important");
  }

  for (const [k, v] of Object.entries(palette ?? {})) {
    if (v) host.style.setProperty(`--spx-${k}`, v);
  }

  let outlet = root.querySelector("[data-spx-outlet]");
  if (!outlet) {
    outlet = document.createElement("div");
    outlet.dataset.spxOutlet = "1";
    root.appendChild(outlet);
  }
  return outlet;
}

/** Read the settings JSON the liquid block drops on the page. */
export function readBlockSettings(scriptId) {
  try {
    const el = document.getElementById(scriptId);
    return el ? JSON.parse(el.textContent) : {};
  } catch { return {}; }
}
