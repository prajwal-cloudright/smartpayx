/**
 * Order confirmation, rendered from OUR order snapshot (/order/:appOrderId) —
 * Shopify's statusPageUrl is auth-gated for API-created orders, so it appears
 * only as a secondary "track order" link when present.
 *
 * Direct visits without a valid session get the same phone-OTP flow: ownership
 * is never relaxed, only re-proven.
 */
import React, { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../shared/api";
import { SpxLogo, PoweredBy, Skeleton, Icon } from "../shared/ui";
import { money } from "../shared/money";
import { InlineAuth } from "../widget/screens/Confirming";

const WRAP = { maxWidth: 620, margin: "0 auto", padding: "32px 16px 48px" };

export default function ThankYou({ appOrderId }) {
  const [state, setState] = useState({ view: "LOADING", data: null, error: null });

  const load = useCallback(async () => {
    if (!appOrderId) { setState({ view: "ERROR", error: "No order specified." }); return; }
    setState((s) => ({ ...s, view: "LOADING" }));
    try {
      setState({ view: "OK", data: await api.order(appOrderId) });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setState({ view: "AUTH" });
      else if (e instanceof ApiError && e.status === 403) setState({ view: "ERROR", error: "This order belongs to a different account." });
      else setState({ view: "ERROR", error: e.message });
    }
  }, [appOrderId]);

  useEffect(() => { void load(); }, [load]);

  if (state.view === "LOADING") {
    return (
      <div style={WRAP}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, marginBottom: 28 }}>
          <Skeleton h={72} w={72} r="50%" />
          <Skeleton h={22} w="58%" />
          <Skeleton h={14} w="38%" />
        </div>
        <div className="spx-card spx-card-pad">
          <Skeleton h={12} w="26%" style={{ marginBottom: 14 }} />
          <Skeleton h={58} style={{ marginBottom: 10 }} />
          <Skeleton h={58} />
        </div>
      </div>
    );
  }

  if (state.view === "AUTH") {
    return (
      <div style={WRAP}>
        <div style={{ textAlign: "center", marginBottom: 22 }}><SpxLogo size={24} /></div>
        <div className="spx-card spx-card-pad">
          <InlineAuth note="Verify the number you ordered with to view this order." onDone={load} />
        </div>
        <PoweredBy />
      </div>
    );
  }

  if (state.view === "ERROR") {
    return (
      <div style={WRAP}>
        <div className="spx-center">
          <div className="spx-status-icon spx-status-bad"><Icon.Alert /></div>
          <div className="spx-title">{state.error}</div>
          <a href="/" className="spx-link">Continue shopping</a>
        </div>
      </div>
    );
  }

  const d = state.data;

  if (d.status === "REFUND_PENDING") {
    return (
      <div style={WRAP}>
        <div className="spx-center">
          <div className="spx-status-icon spx-status-bad"><Icon.Alert /></div>
          <div className="spx-title">We hit a snag with your order</div>
          <div className="spx-sub" style={{ maxWidth: 380 }}>{d.message}</div>
          <div className="spx-badge spx-badge-neutral spx-mono" style={{ marginTop: 4 }}>{d.app_order_id}</div>
        </div>
        <PoweredBy />
      </div>
    );
  }

  const order = d.order ?? {};
  const pricing = order.pricing ?? null;
  const addr = order.shippingAddress ?? null;
  const currency = pricing?.currency ?? order.currency ?? "INR";
  const saved = pricing && pricing.subtotalMinor !== pricing.cartTotalMinor
    ? String(BigInt(pricing.subtotalMinor) - BigInt(pricing.cartTotalMinor)) : null;

  return (
    <div style={WRAP}>
      <div className="spx-center" style={{ padding: "4px 0 26px" }}>
        <div className="spx-status-icon spx-status-ok"><Icon.Check /></div>
        <div className="spx-title" style={{ fontSize: 24 }}>Order confirmed</div>
        <div className="spx-sub" style={{ maxWidth: 380 }}>
          Thanks{addr?.name ? `, ${addr.name.split(" ")[0]}` : ""}! We've sent the details to your email.
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "center", marginTop: 2 }}>
          <span className="spx-badge spx-badge-neutral spx-mono">
            {d.shopify_order_name ?? d.app_order_id}
          </span>
          {d.confirmation_pending && (
            <span className="spx-badge spx-badge-warn">Finalising — email on its way</span>
          )}
        </div>
      </div>

      <div className="spx-card" style={{ marginBottom: 12 }}>
        <div className="spx-card-pad" style={{ paddingBottom: 4 }}>
          <div className="spx-eyebrow">Your items</div>
        </div>
        <div style={{ padding: "0 16px 14px" }}>
          {(order.lines ?? []).map((l) => (
            <div className="spx-line-item" key={l.variantId}>
              <span className="spx-thumb-wrap">
                {l.imageUrl ? <img className="spx-thumb" src={l.imageUrl} alt="" /> : <span className="spx-thumb" />}
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
              <div className="spx-price-row spx-total">
                <span>Paid</span><span>{money(order.capturedMinor ?? pricing.totalMinor, currency)}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {addr && (
        <div className="spx-card spx-card-pad" style={{ marginBottom: 20 }}>
          <div className="spx-eyebrow" style={{ marginBottom: 6 }}>Delivery address</div>
          <div className="spx-title-sm" style={{ marginBottom: 3 }}>{addr.name}</div>
          <div className="spx-sub" style={{ fontSize: 13.5 }}>
            {addr.address1}{addr.address2 ? `, ${addr.address2}` : ""}
          </div>
          <div className="spx-sub" style={{ fontSize: 13.5 }}>
            {addr.city}, {addr.state} — {addr.pincode}
          </div>
          {addr.phone && <div className="spx-sub" style={{ fontSize: 13.5, marginTop: 4 }}>{addr.phone}</div>}
        </div>
      )}

      <div style={{ display: "grid", gap: 10 }}>
        {d.track_order_url && (
          <a href={d.track_order_url} target="_blank" rel="noreferrer" className="spx-btn spx-btn-secondary" style={{ textDecoration: "none" }}>
            Track your order
          </a>
        )}
        <a href="/" className="spx-btn spx-btn-primary" style={{ textDecoration: "none" }}>Continue shopping</a>
      </div>

      <PoweredBy />
    </div>
  );
}
