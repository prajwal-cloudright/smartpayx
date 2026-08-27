/**
 * Phone → OTP. Returns { body, actions } so the CTA sits in the sticky bar.
 * Per decisions: reauth renders this same plain prompt (no special copy).
 */
import React, { useEffect, useState } from "react";
import { api, auth, ApiError } from "../../shared/api";
import {
  Button,
  Field,
  Input,
  OtpInput,
  Icon,
  SecureStrip,
} from "../../shared/ui";
import CartSummary from "../components/CartSummary";

export default function Login({ session, onAuthed }) {
  return LoginScreen({ session, onAuthed });
}

function LoginScreen({ session, onAuthed }) {
  const [stage, setStage] = useState("PHONE");
  const [phone, setPhone] = useState("");
  const [challenge, setChallenge] = useState(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [cooldown, setCooldown] = useState(0);
  const [resendsLeft, setResendsLeft] = useState(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const validPhone = /^[6-9]\d{9}$/.test(phone);

  async function send(isResend = false) {
    setBusy(true);
    setError(null);
    try {
      const res = await api.sendOtp(phone, isResend ? challenge : undefined);
      setChallenge(res.challenge_id);
      setCooldown(res.resend_after_s ?? 30);
      setResendsLeft(res.resends_left);
      setStage("OTP");
      setCode("");
    } catch (e) {
      setError(e.message);
      if (e instanceof ApiError && e.code === "VALIDATION_ERROR")
        setStage("PHONE");
    } finally {
      setBusy(false);
    }
  }

  async function verify(full) {
    setBusy(true);
    setError(null);
    try {
      const res = await api.verifyOtp(challenge, phone, full);
      auth.set(res.token);
      onAuthed();
    } catch (e) {
      setError(e.message);
      setCode("");
      if (
        e instanceof ApiError &&
        (e.code === "OTP_LOCKED" || e.code === "VALIDATION_ERROR")
      ) {
        setStage("PHONE");
        setChallenge(null);
      }
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (code.length === 6 && !busy) void verify(code);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  return (
    <>
      <div className="spx-screen">
        <CartSummary cart={session.cart} pricing={session.pricing} />

        {stage === "PHONE" ? (
          <>
            <div className="spx-title" style={{ marginBottom: 5 }}>
              Enter your mobile number
            </div>
            <div className="spx-sub" style={{ marginBottom: 20 }}>
              We'll send a one-time code to verify it's you.
            </div>
            <Field error={error}>
              <div className="spx-prefix-wrap">
                <span className="spx-prefix">+91</span>
                <Input
                  inputMode="numeric"
                  autoComplete="tel-national"
                  maxLength={10}
                  placeholder="00000 00000"
                  value={phone}
                  error={error}
                  onChange={(e) => {
                    setPhone(e.target.value.replace(/\D/g, "").slice(0, 10));
                    setError(null);
                  }}
                  onKeyDown={(e) => e.key === "Enter" && validPhone && send()}
                  autoFocus
                />
              </div>
            </Field>
          </>
        ) : (
          <>
            <button
              className="spx-link"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                marginBottom: 14,
              }}
              onClick={() => {
                setStage("PHONE");
                setError(null);
                setCode("");
              }}
            >
              <Icon.Back /> Change number
            </button>
            <div className="spx-title" style={{ marginBottom: 5 }}>
              Verify your number
            </div>
            <div className="spx-sub" style={{ marginBottom: 20 }}>
              Enter the 6-digit code sent to{" "}
              <strong style={{ color: "var(--spx-ink)" }}>+91 {phone}</strong>
            </div>
            <Field error={error}>
              <OtpInput
                value={code}
                onChange={(v) => {
                  setCode(v);
                  setError(null);
                }}
                invalid={Boolean(error)}
                autoFocus
              />
            </Field>
            <div style={{ textAlign: "center", marginTop: 18 }}>
              <button
                className="spx-link"
                disabled={cooldown > 0 || resendsLeft === 0}
                onClick={() => send(true)}
              >
                {cooldown > 0
                  ? `Resend code in ${cooldown}s`
                  : resendsLeft === 0
                    ? "Resend limit reached"
                    : "Didn't get it? Resend code"}
              </button>
            </div>
          </>
        )}
      </div>
      <div className="spx-actions">
        {stage === "PHONE" ? (
          <Button loading={busy} disabled={!validPhone} onClick={() => send()}>
            Continue
          </Button>
        ) : (
          <Button
            loading={busy}
            disabled={code.length !== 6}
            onClick={() => verify(code)}
          >
            Verify & continue
          </Button>
        )}
        <SecureStrip />
      </div>
    </>
  );
}
