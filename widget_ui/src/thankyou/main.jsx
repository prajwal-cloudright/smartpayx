/**
 * thankyou.js — app block entry for /pages/spx-thank-you?o={app_order_id}.
 * Renders inline in the page section (not an overlay), reusing the same shadow
 * mount and design tokens.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { readBlockSettings, createShadowMount } from "../shared/mount";
import ThankYou from "./ThankYou";

function boot() {
  const anchor = document.getElementById("spx-thankyou-root");
  if (!anchor) return;

  const settings = readBlockSettings("spx-thankyou-settings");
  const outlet = createShadowMount(
    "spx-thankyou-root",
    { accent: settings.accent, "accent-ink": settings.accent_ink, bg: settings.bg, ink: settings.ink },
    { overlay: false },   // inline page content, not a viewport layer
  );

  const appOrderId = new URLSearchParams(location.search).get("o");
  createRoot(outlet).render(<ThankYou appOrderId={appOrderId} />);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
