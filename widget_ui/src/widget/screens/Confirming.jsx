/**
 * Post-payment polling. Runs both for the in-widget CONFIRMING step and for
 * redirect-resume (spx_resume) — in the resume case there is no session at
 * all, only a request_id, and this screen is the entire widget.
 *
 * Poll: 1.5s × 1.3 backoff, capped 5s, 90s ceiling → terminal "we're
 * confirming, check your email". On can_proceed: clear the cart once, then
 * redirect to /pages/spx-thank-you?o={app_order_id}.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { api, auth, storefrontCart, ApiError } from "../../shared/api";
import {
  Button,
  Field,
  Input,
  OtpInput,
  Icon,
  Dots,
  SecureStrip,
} from "../../shared/ui";

const CEILING_MS = 90_000;

export default function Confirming({ requestId, onRetryPayment }) {
  const [view, setView] = useState("POLLING");
  const [failure, setFailure] = useState(null);
  const cleared = useRef(false);
  const stopped = useRef(false);

  const poll = useCallback(() => {
    stopped.current = false;
    let delay = 1500;
    const startedAt = Date.now();

    async function tick() {
      if (stopped.current) return;
      try {
        const res = await api.paymentStatus(requestId);

        if (res.should_clear_cart && !cleared.current) {
          cleared.current = true;
          void storefrontCart.clear(); // capture is the point of no return
        }
        if (res.can_proceed && res.app_order_id) {
          location.assign(
            `/pages/spx-thank-you?o=${encodeURIComponent(res.app_order_id)}`,
          );
          return; // page unloads
        }
        if (res.status === "AWAITING_PAYMENT" || res.status === "ADDRESS_SET") {
          setFailure(res.failure);
          setView("FAILED");
          return;
        }
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          setView("AUTH");
          return;
        }
        /* transient — keep polling until the ceiling */
      }
      if (Date.now() - startedAt > CEILING_MS) {
        setView("TIMEOUT");
        return;
      }
      delay = Math.min(delay * 1.3, 5000);
      setTimeout(tick, delay);
    }
    void tick();
  }, [requestId]);

  useEffect(() => {
    poll();
    return () => {
      stopped.current = true;
    };
  }, [poll]);

  if (view === "AUTH") {
    return (
      <InlineAuth
        note="Verify your number to see your payment status."
        onDone={() => {
          setView("POLLING");
          poll();
        }}
      />
    );
  }

  if (view === "FAILED") {
    return (
      <div className="spx-screen">
        <div className="spx-center">
          <div className="spx-status-icon spx-status-bad">
            <Icon.Alert />
          </div>
          <div className="spx-title">Payment unsuccessful</div>
          <div className="spx-sub" style={{ maxWidth: 320 }}>
            {failure?.reason ?? "The payment could not be completed."}
            {failure?.charged === false && " You have not been charged."}
          </div>
          <Button
            onClick={onRetryPayment}
            style={{ maxWidth: 260, marginTop: 6 }}
          >
            Try another method
          </Button>
        </div>
      </div>
    );
  }

  if (view === "TIMEOUT") {
    return (
      <div className="spx-screen">
        <div className="spx-center">
          <div className="spx-status-icon spx-status-wait">
            <Icon.Clock />
          </div>
          <div className="spx-title">Still confirming your payment</div>
          <div className="spx-sub" style={{ maxWidth: 330 }}>
            This is taking longer than usual. If your payment went through, your
            order is safe — we'll email your confirmation shortly. It's fine to
            close this window.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="spx-screen">
      <div className="spx-center">
        <span className="spx-spin spx-spin-lg" />
        <div
          className="spx-title"
          style={{ display: "flex", alignItems: "center", gap: 8 }}
        >
          Confirming your payment <Dots />
        </div>
        <div className="spx-sub" style={{ maxWidth: 300 }}>
          Please don't refresh or press back — this only takes a moment.
        </div>
        <div style={{ marginTop: 8 }}>
          <SecureStrip>Verifying with your bank</SecureStrip>
        </div>
      </div>
    </div>
  );
}

/**
 * Minimal inline phone-OTP for when the session died during the PG round trip,
 * or on a thank-you page visit from a new device. Plain prompt, per the reauth
 * decision — ownership is never relaxed, only re-proven.
 */
export function InlineAuth({ onDone, note }) {
  const [stage, setStage] = useState("PHONE");
  const [phone, setPhone] = useState("");
  const [challenge, setChallenge] = useState(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.sendOtp(phone);
      setChallenge(r.challenge_id);
      setStage("OTP");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function verify(full) {
    setBusy(true);
    setError(null);
    try {
      const r = await api.verifyOtp(challenge, phone, full);
      auth.set(r.token);
      onDone();
    } catch (e) {
      setError(e.message);
      setCode("");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (code.length === 6 && !busy) void verify(code); /* eslint-disable-line */
  }, [code]);

  return (
    <div style={{ padding: "8px 0" }}>
      <div className="spx-title" style={{ marginBottom: 5 }}>
        Verify your number
      </div>
      <div className="spx-sub" style={{ marginBottom: 20 }}>
        {note}
      </div>
      {stage === "PHONE" ? (
        <>
          <Field error={error}>
            <div className="spx-prefix-wrap">
              <span className="spx-prefix">+91</span>
              <Input
                inputMode="numeric"
                maxLength={10}
                placeholder="00000 00000"
                value={phone}
                error={error}
                onChange={(e) => {
                  setPhone(e.target.value.replace(/\D/g, "").slice(0, 10));
                  setError(null);
                }}
                autoFocus
              />
            </div>
          </Field>
          <Button
            loading={busy}
            disabled={!/^[6-9]\d{9}$/.test(phone)}
            onClick={send}
          >
            Send code
          </Button>
        </>
      ) : (
        <>
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
          <Button
            loading={busy}
            disabled={code.length !== 6}
            onClick={() => verify(code)}
          >
            Verify
          </Button>
        </>
      )}
    </div>
  );
}
