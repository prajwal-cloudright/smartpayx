/** Collapsible order summary — cart lines + full price breakdown. */
import React, { useState } from "react";
import { money } from "../../shared/money";
import { Icon } from "../../shared/ui";

export default function CartSummary({ cart, pricing, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  if (!cart) return null;

  const currency = pricing?.currency ?? cart.currency;
  const saved =
    pricing && pricing.subtotalMinor !== pricing.cartTotalMinor
      ? String(BigInt(pricing.subtotalMinor) - BigInt(pricing.cartTotalMinor))
      : null;

  return (
    <div className="spx-card" style={{ marginBottom: 16 }}>
      <button className="spx-summary-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          <span className="spx-eyebrow">Order summary</span>
          <span className="spx-sub" style={{ fontSize: 13 }}>
            {cart.totalQuantity} item{cart.totalQuantity === 1 ? "" : "s"}
            {saved && <span className="spx-save-note"> · You save {money(saved, currency)}</span>}
          </span>
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 680, fontSize: 16, letterSpacing: "-0.02em" }}>
          {money(pricing?.totalMinor ?? cart.cartTotalMinor, currency)}
          <Icon.Chevron className={`spx-chevron ${open ? "spx-open" : ""}`} />
        </span>
      </button>

      {open && (
        <div style={{ padding: "0 16px 15px", borderTop: "1px solid var(--spx-line)" }}>
          {cart.lines.map((l) => (
            <div className="spx-line-item" key={l.variantId}>
              <span className="spx-thumb-wrap">
                {l.imageUrl ? <img className="spx-thumb" src={l.imageUrl} alt="" loading="lazy" /> : <span className="spx-thumb" />}
                <span className="spx-qty-dot">{l.quantity}</span>
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span className="spx-item-title">{l.title}</span>
                {l.variantTitle && l.variantTitle !== "Default Title" && (
                  <span className="spx-sub" style={{ fontSize: 12.5, display: "block", marginTop: 2 }}>{l.variantTitle}</span>
                )}
              </span>
              <span style={{ fontSize: 13.5, fontWeight: 580 }}>
                {money(String(BigInt(l.unitMinor) * BigInt(l.quantity)), currency)}
              </span>
            </div>
          ))}

          {pricing && (
            <div style={{ marginTop: 10, paddingTop: 12, borderTop: "1px solid var(--spx-line)" }}>
              <div className="spx-price-row"><span>Subtotal</span><b>{money(pricing.subtotalMinor, currency)}</b></div>
              {saved && (
                <div className="spx-price-row">
                  <span style={{ display: "flex", alignItems: "center", gap: 5 }}><Icon.Tag />Discount</span>
                  <b className="spx-save-note">−{money(saved, currency)}</b>
                </div>
              )}
              <div className="spx-price-row">
                <span>{pricing.shippingLabel}</span>
                <b>{pricing.shippingMinor === "0" ? <span className="spx-save-note">Free</span> : money(pricing.shippingMinor, currency)}</b>
              </div>
              <div className="spx-price-row spx-total"><span>Total</span><span>{money(pricing.totalMinor, currency)}</span></div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
