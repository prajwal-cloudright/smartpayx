/* eslint-disable react/prop-types */
/**
 * PG selection + pay. Offers come from /offers (the display source of truth);
 * the PG list comes from the session. Both gateways end in a redirect — the
 * DOM does not survive this step, so resume rehydrates from the server.
 */
import React, { useEffect, useState } from "react";
import { api, ApiError } from "../../shared/api";
import { Button, Skeleton, Icon, SecureStrip } from "../../shared/ui";
import { money } from "../../shared/money";
import CartSummary from "../components/CartSummary";

const PG_META = {
  RAZORPAY: { label: "Razorpay", hint: "UPI · Cards · Netbanking · Wallets" },
  PINELABS: { label: "Pine Labs", hint: "Cards · UPI · EMI · Netbanking" },
};

export default function Payment(props) {
  return PaymentScreen(props);
}

function PaymentScreen({
  session,
  returnPath,
  onCartChanged,
  onEditAddress,
  onAttemptReleased,
}) {
  const options = [...(session.pg_options ?? [])].sort(
    (a, b) => a.display_order - b.display_order,
  );
  const [pg, setPg] = useState(options[0]?.pg ?? null);
  const [offers, setOffers] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const addr = session.selected_address;

  useEffect(() => {
    let alive = true;
    api
      .offers(session.request_id)
      .then((r) => alive && setOffers(r.offers ?? []))
      .catch(() => alive && setOffers([])); // offers are decorative — never block payment
    return () => {
      alive = false;
    };
  }, [session.request_id]);

  const offerFor = (id) => offers?.find((o) => o.pg === id)?.text ?? null;

  async function pay() {
    if (!pg) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.payment(session.request_id, pg, returnPath);
      if (res.mode === "REDIRECT" && res.payment_url) {
        location.assign(res.payment_url);
        return;
      }
      if (res.mode === "EMBEDDED" && res.sdk) {
        const outcome = await openRazorpay(res.sdk);
        if (outcome === "DISMISSED") {
          // Release the live-attempt slot so another method can be chosen now,
          // rather than waiting ~5 min for the sweeper. The server re-checks
          // with Razorpay before releasing, so a payment that actually went
          // through is promoted instead of cancelled.
          setBusy(false);
          try {
            const r = await api.cancelAttempt(session.request_id);
            if (r.captured) return; // it did go through — resume flow takes over
          } catch {
            /* sweeper will handle it */
          }
          onAttemptReleased(); // re-sync → back to PG_SELECTION
        }
        return;
      }
      setError("This payment option is unavailable right now.");
      setBusy(false);
    } catch (e) {
      if (e instanceof ApiError && e.code === "CART_CHANGED") {
        onCartChanged();
        return;
      }
      setError(
        e instanceof ApiError && e.code === "OUT_OF_STOCK"
          ? "Some items just went out of stock. Please review your cart."
          : e instanceof ApiError && e.code === "ATTEMPT_IN_FLIGHT"
            ? "A payment is already in progress. Give it a moment, then try again."
            : e.message,
      );
      setBusy(false);
    }
  }

  return (
    <>
      <div className="spx-screen">
        <CartSummary
          cart={session.cart}
          pricing={session.pricing}
          defaultOpen
        />

        {addr && (
          <div
            className="spx-card spx-card-muted spx-card-pad"
            style={{
              marginBottom: 18,
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div className="spx-eyebrow" style={{ marginBottom: 4 }}>
                Delivering to
              </div>
              <div className="spx-title-sm" style={{ marginBottom: 2 }}>
                {addr.name}
              </div>
              <div className="spx-sub" style={{ fontSize: 13 }}>
                {addr.address1}, {addr.city}, {addr.state} — {addr.pincode}
              </div>
            </div>
            <button
              className="spx-link"
              onClick={onEditAddress}
              style={{ flexShrink: 0, alignSelf: "flex-start" }}
            >
              Change
            </button>
          </div>
        )}

        <div className="spx-title" style={{ marginBottom: 4 }}>
          Payment method
        </div>
        <div className="spx-sub" style={{ marginBottom: 16 }}>
          Choose how you'd like to pay.
        </div>

        {offers === null ? (
          <>
            <Skeleton h={78} r={16} style={{ marginBottom: 10 }} />
            <Skeleton h={78} r={16} />
          </>
        ) : (
          options.map((opt) => {
            const meta = PG_META[opt.pg] ?? { label: opt.pg, hint: "" };
            const offer = offerFor(opt.pg) ?? opt.offer_text;
            return (
              <button
                key={opt.pg}
                className={`spx-option ${pg === opt.pg ? "spx-on" : ""}`}
                onClick={() => setPg(opt.pg)}
              >
                <span className="spx-radio" />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span
                    className="spx-title-sm"
                    style={{ display: "block", marginBottom: 2 }}
                  >
                    {meta.label}
                  </span>
                  <span
                    className="spx-sub"
                    style={{ fontSize: 12.5, display: "block" }}
                  >
                    {meta.hint}
                  </span>
                  {offer && (
                    <span className="spx-badge" style={{ marginTop: 8 }}>
                      <Icon.Tag />
                      {offer}
                    </span>
                  )}
                </span>
              </button>
            );
          })
        )}

        {error && (
          <div
            className="spx-notice spx-notice-err"
            style={{ marginTop: 16, marginBottom: 0 }}
          >
            <Icon.Alert
              width="15"
              height="15"
              style={{ flexShrink: 0, marginTop: 1 }}
            />
            <span>{error}</span>
          </div>
        )}
      </div>
      <div className="spx-actions">
        <Button loading={busy} disabled={!pg} onClick={pay}>
          <span className="spx-btn-amount">
            <span>Pay</span>
            <b>
              {money(session.pricing?.totalMinor, session.pricing?.currency)}
            </b>
          </span>
        </Button>
        <SecureStrip>
          You&apos;ll be taken to a secure page to complete payment
        </SecureStrip>
      </div>
    </>
  );
}

/** Load checkout.js once, then open. redirect:true routes completion to
    /callbacks/razorpay — the same round trip as Pine Labs. */
/**
 * Razorpay Standard Checkout SDK.
 *
 * NOTE: `redirect: true` is NOT an SDK option — it belongs to Payment Links /
 * hosted checkout. The SDK always renders its own overlay, so we handle both
 * outcomes here rather than relying on a browser redirect:
 *   - success  → navigate to our callback route ourselves (server verifies + resolves)
 *   - dismiss  → tell the caller so it can release the attempt
 */
function openRazorpay(sdkOptions) {
  return new Promise((resolve, reject) => {
    function launch() {
      try {
        new window.Razorpay({
          ...sdkOptions,
          modal: {
            ondismiss: () => resolve("DISMISSED"),
            backdropclose: false,
          },
        }).open();
      } catch (e) {
        reject(e);
      }
    }
    if (window.Razorpay) return launch();
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.onload = launch;
    s.onerror = () => reject(new Error("Could not load the payment provider."));
    document.head.appendChild(s);
  });
}
