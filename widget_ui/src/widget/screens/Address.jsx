/**
 * Address step: saved-address picker for returning buyers, full form for new,
 * pincode → state/city autofill, email fixed when the server says so.
 */
import React, { useState } from "react";
import { api } from "../../shared/api";
import { Button, Field, Input, Icon, SecureStrip } from "../../shared/ui";
import CartSummary from "../components/CartSummary";

const EMPTY = {
  name: "",
  phone: "",
  address1: "",
  address2: "",
  landmark: "",
  city: "",
  state: "",
  pincode: "",
};

export default function Address(props) {
  return AddressScreen(props);
}

function AddressScreen({ session, onDone }) {
  const saved = session.addresses ?? [];
  const emailFixed = Boolean(session.customer?.email_locked);
  const [mode, setMode] = useState(saved.length ? "PICK" : "NEW");
  const [selectedId, setSelectedId] = useState(
    saved.find((a) => a.is_default)?.id ?? saved[0]?.id ?? null,
  );
  const [form, setForm] = useState({
    ...EMPTY,
    phone: (session.customer?.phone ?? "").replace(/^\+91/, ""),
  });
  const [email, setEmail] = useState(session.customer?.email ?? "");
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [apiError, setApiError] = useState(null);
  const [pinBusy, setPinBusy] = useState(false);
  const [pinNote, setPinNote] = useState(null);

  function set(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  }

  /** Autofill on the 6th digit. State stays editable — border pincodes are ambiguous. */
  async function onPincode(value) {
    const pin = value.replace(/\D/g, "").slice(0, 6);
    set("pincode", pin);
    setPinNote(null);
    if (pin.length !== 6) return;
    setPinBusy(true);
    try {
      const res = await api.pincode(pin);
      setForm((f) => ({
        ...f,
        state: res.state ?? f.state,
        city: f.city || (res.city ?? ""),
      }));
      if (res.requires_manual_state) setPinNote("Please select your state.");
    } catch {
      /* best-effort */
    } finally {
      setPinBusy(false);
    }
  }

  function validate() {
    const e = {};
    if (!emailFixed && !/^\S+@\S+\.\S+$/.test(email))
      e.email = "Enter a valid email address";
    if (mode === "NEW") {
      if (form.name.trim().length < 2) e.name = "Enter the full name";
      if (!/^[6-9]\d{9}$/.test(form.phone))
        e.phone = "Enter a valid 10-digit number";
      if (form.address1.trim().length < 5)
        e.address1 = "Enter house/flat and street";
      if (form.city.trim().length < 2) e.city = "Enter the city";
      if (!form.state.trim()) e.state = "Enter the state";
      if (!/^[1-9]\d{5}$/.test(form.pincode))
        e.pincode = "Enter a valid 6-digit pincode";
    } else if (!selectedId) e.pick = "Select a delivery address";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function submit() {
    if (!validate()) return;
    setBusy(true);
    setApiError(null);
    try {
      await api.shippingAddress({
        request_id: session.request_id,
        ...(emailFixed ? {} : { email }),
        ...(mode === "PICK"
          ? { address_id: selectedId }
          : { address: { ...form, country: "IN" }, save_address: true }),
      });
      onDone();
    } catch (e) {
      setApiError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="spx-screen">
        <CartSummary cart={session.cart} pricing={session.pricing} />

        <div className="spx-title" style={{ marginBottom: 4 }}>
          Delivery details
        </div>
        <div className="spx-sub" style={{ marginBottom: 18 }}>
          Where should we send your order?
        </div>

        <Field
          label="Email for order updates"
          error={errors.email}
          hint={emailFixed ? "Linked to your account" : undefined}
        >
          <Input
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            disabled={emailFixed}
            error={errors.email}
            onChange={(e) => {
              setEmail(e.target.value);
              setErrors((x) => ({ ...x, email: undefined }));
            }}
          />
        </Field>

        {mode === "PICK" ? (
          <>
            <div className="spx-eyebrow" style={{ margin: "20px 0 10px" }}>
              Deliver to
            </div>
            {saved.map((a) => (
              <button
                key={a.id}
                className={`spx-option ${selectedId === a.id ? "spx-on" : ""}`}
                onClick={() => setSelectedId(a.id)}
              >
                <span className="spx-radio" />
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 7,
                      marginBottom: 3,
                    }}
                  >
                    <span className="spx-title-sm">{a.name}</span>
                    {a.is_default && (
                      <span className="spx-badge spx-badge-neutral">
                        Default
                      </span>
                    )}
                  </span>
                  <span
                    className="spx-sub"
                    style={{ fontSize: 13, display: "block" }}
                  >
                    {a.address1}
                    {a.address2 ? `, ${a.address2}` : ""}, {a.city}
                  </span>
                  <span className="spx-sub" style={{ fontSize: 13 }}>
                    {a.state} — {a.pincode}
                  </span>
                </span>
              </button>
            ))}
            {errors.pick && (
              <div className="spx-err">
                <Icon.ErrorDot />
                {errors.pick}
              </div>
            )}
            <button
              className="spx-link"
              style={{ marginTop: 14 }}
              onClick={() => setMode("NEW")}
            >
              + Add a new address
            </button>
          </>
        ) : (
          <>
            {saved.length > 0 && (
              <button
                className="spx-link"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                  margin: "18px 0 14px",
                }}
                onClick={() => setMode("PICK")}
              >
                <Icon.Back /> Use a saved address
              </button>
            )}
            <div className="spx-eyebrow" style={{ margin: "20px 0 12px" }}>
              New address
            </div>

            <Field label="Full name" error={errors.name}>
              <Input
                autoComplete="name"
                placeholder="e.g. Priya Sharma"
                value={form.name}
                error={errors.name}
                onChange={(e) => set("name", e.target.value)}
              />
            </Field>

            <Field label="Mobile number" error={errors.phone}>
              <div className="spx-prefix-wrap">
                <span className="spx-prefix">+91</span>
                <Input
                  inputMode="numeric"
                  autoComplete="tel-national"
                  maxLength={10}
                  placeholder="00000 00000"
                  value={form.phone}
                  error={errors.phone}
                  onChange={(e) =>
                    set("phone", e.target.value.replace(/\D/g, "").slice(0, 10))
                  }
                />
              </div>
            </Field>

            <Field
              label="Flat / house no, building, street"
              error={errors.address1}
            >
              <Input
                autoComplete="address-line1"
                placeholder="e.g. 402, Sunrise Apartments, MG Road"
                value={form.address1}
                error={errors.address1}
                onChange={(e) => set("address1", e.target.value)}
              />
            </Field>

            <Field label="Area, colony (optional)">
              <Input
                autoComplete="address-line2"
                value={form.address2}
                onChange={(e) => set("address2", e.target.value)}
              />
            </Field>

            <div className="spx-row">
              <Field label="Pincode" error={errors.pincode}>
                <div className="spx-prefix-wrap">
                  <Input
                    inputMode="numeric"
                    autoComplete="postal-code"
                    maxLength={6}
                    placeholder="400001"
                    value={form.pincode}
                    error={errors.pincode}
                    onChange={(e) => onPincode(e.target.value)}
                  />
                  {pinBusy && (
                    <span className="spx-input-icon">
                      <span
                        className="spx-spin"
                        style={{ color: "var(--spx-ink-3)" }}
                      />
                    </span>
                  )}
                </div>
              </Field>
              <Field label="City" error={errors.city}>
                <Input
                  autoComplete="address-level2"
                  value={form.city}
                  error={errors.city}
                  onChange={(e) => set("city", e.target.value)}
                />
              </Field>
            </div>

            <Field label="State" error={errors.state} hint={pinNote}>
              <Input
                autoComplete="address-level1"
                placeholder="Auto-filled from pincode"
                value={form.state}
                error={errors.state}
                onChange={(e) => set("state", e.target.value)}
              />
            </Field>

            <Field label="Landmark (optional)">
              <div className="spx-prefix-wrap">
                <Input
                  placeholder="e.g. Near City Mall"
                  value={form.landmark}
                  onChange={(e) => set("landmark", e.target.value)}
                />
                <span
                  className="spx-input-icon"
                  style={{ color: "var(--spx-ink-3)" }}
                >
                  <Icon.Pin />
                </span>
              </div>
            </Field>
          </>
        )}

        {apiError && (
          <div
            className="spx-notice spx-notice-err"
            style={{ marginTop: 14, marginBottom: 0 }}
          >
            <Icon.Alert
              width="15"
              height="15"
              style={{ flexShrink: 0, marginTop: 1 }}
            />
            <span>{apiError}</span>
          </div>
        )}
      </div>
      <div className="spx-actions">
        <Button loading={busy} onClick={submit}>
          Continue to payment
        </Button>
        <SecureStrip>Your details are encrypted and never shared</SecureStrip>
      </div>
    </>
  );
}
