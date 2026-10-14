/* eslint-disable react/prop-types */
import React, { useEffect, useState } from "react";
import { api, ApiError } from "../../shared/api";
import { Button, Icon, SecureStrip } from "../../shared/ui";
import { money } from "../../shared/money";
import CartSummary from "../components/CartSummary";

const PG_META = {
  RAZORPAY: {
    label: "Razorpay",
    hint: "UPI · Cards · Netbanking · Wallets",
  },
  PINELABS: {
    label: "Pine Labs",
    hint: "Cards · UPI · EMI · Netbanking",
  },
};

/*
 * DEMO ROUTING:
 * These are UI categories, not gateway IDs.
 * Each method is routed to one of the configured payment gateways.
 */
const PAYMENT_METHODS = [
  {
    id: "UPI",
    label: "UPI",
    description: "Pay using UPI and available offers",
    symbol: "↗",
    color: "upi",
    gateway: "RAZORPAY",
  },
  {
    id: "BANK_CARD_EMI",
    label: "Bank Card EMI",
    description: "Enjoy no-cost EMI on eligible bank cards",
    symbol: "◷",
    color: "emi",
    gateway: "PINELABS",
  },
  {
    id: "CARDLESS_EMI",
    label: "Cardless EMI",
    description: "Flexible payment plans",
    symbol: "◇",
    color: "cardless",
    gateway: "RAZORPAY",
  },
  {
    id: "CARDS",
    label: "Credit / Debit Cards",
    description: "Visa, Mastercard and other supported cards",
    symbol: "▰",
    color: "cards",
    gateway: "PINELABS",
  },
  {
    id: "NETBANKING",
    label: "NetBanking",
    description: "Pay directly from your bank account",
    symbol: "▦",
    color: "netbanking",
    gateway: "RAZORPAY",
  },
  {
    id: "WALLETS",
    label: "Wallets",
    description: "Pay using supported digital wallets",
    symbol: "▣",
    color: "wallets",
    gateway: "PINELABS",
  },
];

const DEMO_BANKS = [
  { id: "HDFC", label: "HDFC Bank", initials: "HB" },
  { id: "ICICI", label: "ICICI Bank", initials: "IB" },
  { id: "AXIS", label: "Axis Bank", initials: "AB" },
  { id: "OTHER", label: "Other bank", initials: "+" },
];

export default function Payment(props) {
  return <PaymentScreen {...props} />;
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

  const [selectedMethod, setSelectedMethod] = useState("UPI");
  const [selectedEmiType, setSelectedEmiType] = useState("CREDIT");
  const [selectedBank, setSelectedBank] = useState("HDFC");
  const [offers, setOffers] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const addr = session.selected_address;

  useEffect(() => {
    let alive = true;

    api
      .offers(session.request_id)
      .then((r) => alive && setOffers(r.offers ?? []))
      .catch(() => alive && setOffers([]));

    return () => {
      alive = false;
    };
  }, [session.request_id]);

  const currentMethod =
    PAYMENT_METHODS.find((method) => method.id === selectedMethod) ??
    PAYMENT_METHODS[0];

  /*
   * Use the method's preferred gateway if it is configured in this
   * checkout session. Otherwise, use the first available gateway.
   *
   * The payment API continues to receive the gateway ID, just as before.
   */
  const availableGateway =
    options.find((opt) => opt.pg === currentMethod.gateway) ?? options[0];

  const offerFor = (gatewayId) =>
    offers?.find((offer) => offer.pg === gatewayId)?.text ??
    options.find((opt) => opt.pg === gatewayId)?.offer_text ??
    null;

  async function pay() {
    if (!availableGateway || busy) return;

    setBusy(true);
    setError(null);

    try {
      const res = await api.payment(
        session.request_id,
        availableGateway.pg,
        returnPath,
      );

      if (res.mode === "REDIRECT" && res.payment_url) {
        location.assign(res.payment_url);
        return;
      }

      if (res.mode === "EMBEDDED" && res.sdk) {
        const outcome = await openRazorpay(res.sdk);

        if (outcome === "DISMISSED") {
          setBusy(false);

          try {
            const result = await api.cancelAttempt(session.request_id);

            if (result.captured) return;
          } catch {
            // The server-side sweeper will handle the attempt.
          }

          onAttemptReleased();
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

        <div className="spx-payment-heading">
          <div className="spx-title" style={{ marginBottom: 4 }}>
            Select payment method
          </div>

          <div className="spx-sub" style={{ marginBottom: 16 }}>
            Choose how you'd like to pay.
          </div>
        </div>

        <div className="spx-method-list" role="radiogroup" aria-label="Payment method">
          {PAYMENT_METHODS.map((method) => {
            const isSelected = selectedMethod === method.id;
            const gateway =
              options.find((opt) => opt.pg === method.gateway) ?? options[0];
            const offer = gateway ? offerFor(gateway.pg) : null;

            return (
              <div
                key={method.id}
                className={`spx-method-card ${isSelected ? "spx-method-selected" : ""}`}
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  className="spx-method-row"
                  onClick={() => {
                    setSelectedMethod(method.id);
                    setError(null);
                  }}
                >
                  <span
                    className={`spx-method-radio ${isSelected ? "is-checked" : ""}`}
                    aria-hidden="true"
                  >
                    {isSelected && <span />}
                  </span>

                  <span className={`spx-method-icon spx-icon-${method.color}`}>
                    {method.symbol}
                  </span>

                  <span className="spx-method-copy">
                    <span className="spx-method-name">{method.label}</span>
                    <span className="spx-method-description">
                      {method.description}
                    </span>

                    {offer && (
                      <span className="spx-method-offer">
                        <Icon.Tag />
                        {offer}
                      </span>
                    )}
                  </span>

                  <span
                    className={`spx-method-chevron ${isSelected ? "is-open" : ""}`}
                    aria-hidden="true"
                  >
                    ›
                  </span>
                </button>

                {isSelected && method.id === "BANK_CARD_EMI" && (
                  <div className="spx-method-details">
                    <div
                      className="spx-emi-tabs"
                      role="group"
                      aria-label="EMI card type"
                    >
                      <button
                        type="button"
                        className={
                          selectedEmiType === "CREDIT" ? "is-active" : ""
                        }
                        onClick={() => setSelectedEmiType("CREDIT")}
                      >
                        Credit card EMI
                      </button>

                      <button
                        type="button"
                        className={
                          selectedEmiType === "DEBIT" ? "is-active" : ""
                        }
                        onClick={() => setSelectedEmiType("DEBIT")}
                      >
                        Debit card EMI
                      </button>
                    </div>

                    <div className="spx-bank-heading">Select bank</div>

                    <div className="spx-bank-grid">
                      {DEMO_BANKS.map((bank) => (
                        <button
                          type="button"
                          key={bank.id}
                          className={`spx-bank-option ${
                            selectedBank === bank.id ? "is-active" : ""
                          }`}
                          onClick={() => setSelectedBank(bank.id)}
                        >
                          <span className="spx-bank-initials">
                            {bank.initials}
                          </span>
                          <span>{bank.label}</span>
                          <span className="spx-bank-arrow">›</span>
                        </button>
                      ))}
                    </div>

                    <div className="spx-emi-note">
                      Demo selection: {selectedEmiType === "CREDIT"
                        ? "Credit card EMI"
                        : "Debit card EMI"}{" "}
                      · {DEMO_BANKS.find((bank) => bank.id === selectedBank)?.label}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

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
        <Button
          loading={busy}
          disabled={!availableGateway || busy}
          onClick={pay}
        >
          <span className="spx-btn-amount">
            <span>Pay</span>
            <b>
              {money(session.pricing?.totalMinor, session.pricing?.currency)}
            </b>
          </span>
        </Button>

        <SecureStrip>
          You'll be taken to a secure page to complete payment
        </SecureStrip>
      </div>
    </>
  );
}

/**
 * Load Razorpay checkout.js once, then open the existing SDK configuration.
 * The server remains responsible for payment verification and resolution.
 */
function openRazorpay(sdkOptions) {
  return new Promise((resolve, reject) => {
    function launch() {
      try {
        new window.Razorpay({
          ...sdkOptions,
          modal: {
            ...(sdkOptions.modal ?? {}),
            ondismiss: () => resolve("DISMISSED"),
            backdropclose: false,
          },
        }).open();
      } catch (e) {
        reject(e);
      }
    }

    if (window.Razorpay) return launch();

    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.onload = launch;
    script.onerror = () =>
      reject(new Error("Could not load the payment provider."));

    document.head.appendChild(script);
  });
}