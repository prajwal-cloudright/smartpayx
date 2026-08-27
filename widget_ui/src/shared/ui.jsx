/** Shared UI primitives — used by both the widget and the thank-you block. */
import React from "react";

/* ---------------------------------------------------------------- icons ---- */
export const Icon = {
  Close: (p) => (<svg width="15" height="15" viewBox="0 0 16 16" fill="none" {...p}><path d="M2 2l12 12M14 2L2 14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>),
  Chevron: (p) => (<svg width="13" height="13" viewBox="0 0 14 14" fill="none" {...p}><path d="M3 5.5L7 9.5l4-4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" /></svg>),
  Back: (p) => (<svg width="16" height="16" viewBox="0 0 16 16" fill="none" {...p}><path d="M9.5 3L5 8l4.5 5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" /></svg>),
  Lock: (p) => (<svg width="12" height="12" viewBox="0 0 14 14" fill="none" {...p}><rect x="2.6" y="6" width="8.8" height="6.4" rx="1.8" stroke="currentColor" strokeWidth="1.4" /><path d="M4.7 6V4.4a2.3 2.3 0 014.6 0V6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>),
  Check: (p) => (<svg width="30" height="30" viewBox="0 0 24 24" fill="none" {...p}><path d="M5 12.5l4.4 4.4L19 7.5" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>),
  Alert: (p) => (<svg width="28" height="28" viewBox="0 0 24 24" fill="none" {...p}><circle cx="12" cy="12" r="9.3" stroke="currentColor" strokeWidth="1.9" /><path d="M12 7.4v5.2" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /><circle cx="12" cy="16.4" r="1.15" fill="currentColor" /></svg>),
  Clock: (p) => (<svg width="28" height="28" viewBox="0 0 24 24" fill="none" {...p}><circle cx="12" cy="12" r="9.3" stroke="currentColor" strokeWidth="1.9" /><path d="M12 6.8V12l3.4 2.1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>),
  Tag: (p) => (<svg width="11" height="11" viewBox="0 0 14 14" fill="none" {...p}><path d="M7.4 1.4H12a.6.6 0 01.6.6v4.6a1 1 0 01-.3.7l-5.2 5.2a1 1 0 01-1.4 0l-4.5-4.5a1 1 0 010-1.4l5.2-5.2a1 1 0 01.7-.3z" stroke="currentColor" strokeWidth="1.3" /><circle cx="9.6" cy="4.4" r="1" fill="currentColor" /></svg>),
  Pin: (p) => (<svg width="13" height="13" viewBox="0 0 14 14" fill="none" {...p}><path d="M7 12.4s4.2-3.6 4.2-6.6a4.2 4.2 0 10-8.4 0c0 3 4.2 6.6 4.2 6.6z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /><circle cx="7" cy="5.8" r="1.5" stroke="currentColor" strokeWidth="1.3" /></svg>),
  ErrorDot: (p) => (<svg width="13" height="13" viewBox="0 0 14 14" fill="none" {...p}><circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.3" /><path d="M7 4v3.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /><circle cx="7" cy="9.8" r="0.8" fill="currentColor" /></svg>),
};

/* --------------------------------------------------------------- brand ----- */
export function SpxLogo({ size = 20 }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <svg width={size * 1.35} height={size * 1.35} viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <rect width="32" height="32" rx="9" fill="var(--spx-accent)" />
        <path d="M18.4 7.5 11 16.8h4.3l-1.4 7.7 7.6-9.6h-4.3l1.2-7.4z" fill="var(--spx-accent-ink)" />
      </svg>
      <span style={{ fontWeight: 700, fontSize: size * 0.82, letterSpacing: "-0.03em" }}>
        SmartPay<span style={{ opacity: 0.55 }}>X</span>
      </span>
    </span>
  );
}

export function PoweredBy() {
  return (
    <div className="spx-footer">
      <span>Powered by</span>
      <svg width="13" height="13" viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <rect width="32" height="32" rx="9" fill="var(--spx-ink-2)" />
        <path d="M18.4 7.5 11 16.8h4.3l-1.4 7.7 7.6-9.6h-4.3l1.2-7.4z" fill="#fff" />
      </svg>
      <strong style={{ color: "var(--spx-ink-2)", fontWeight: 620 }}>SmartPayX</strong>
    </div>
  );
}

export function SecureStrip({ children = "Payments are encrypted and secure" }) {
  return (
    <div className="spx-secure">
      <Icon.Lock />
      <span>{children}</span>
    </div>
  );
}

/* ------------------------------------------------------------- controls ---- */
export function Button({ variant = "primary", loading, size, children, ...rest }) {
  return (
    <button
      className={`spx-btn spx-btn-${variant} ${size === "sm" ? "spx-btn-sm" : ""}`}
      disabled={loading || rest.disabled}
      {...rest}
    >
      {loading ? <span className="spx-spin" /> : children}
    </button>
  );
}

export function Field({ label, error, hint, children }) {
  return (
    <div className="spx-field">
      {label && <label className="spx-label">{label}</label>}
      {children}
      {error && <div className="spx-err"><Icon.ErrorDot />{error}</div>}
      {!error && hint && <div className="spx-hint">{hint}</div>}
    </div>
  );
}

export function Input({ error, ...rest }) {
  return <input className={`spx-input ${error ? "spx-invalid" : ""}`} {...rest} />;
}

export function Skeleton({ h = 16, w = "100%", r, style }) {
  return <div className="spx-skel" style={{ height: h, width: w, borderRadius: r, ...style }} />;
}

export function Dots() {
  return <span className="spx-dots"><i /><i /><i /></span>;
}

/** Six-box OTP with auto-advance, backspace-retreat, and paste support. */
export function OtpInput({ length = 6, value, onChange, autoFocus, invalid }) {
  const refs = React.useRef([]);
  const chars = Array.from({ length }, (_, i) => value[i] ?? "");

  function setAt(i, ch) {
    onChange((value.slice(0, i) + ch + value.slice(i + 1)).slice(0, length));
  }
  function handle(i, e) {
    const ch = e.target.value.replace(/\D/g, "").slice(-1);
    if (!ch) return;
    setAt(i, ch);
    refs.current[i + 1]?.focus();
  }
  function key(i, e) {
    if (e.key === "Backspace") {
      e.preventDefault();
      if (chars[i]) setAt(i, "");
      else { refs.current[i - 1]?.focus(); setAt(Math.max(0, i - 1), ""); }
    }
    if (e.key === "ArrowLeft") refs.current[i - 1]?.focus();
    if (e.key === "ArrowRight") refs.current[i + 1]?.focus();
  }
  function paste(e) {
    const digits = (e.clipboardData.getData("text") || "").replace(/\D/g, "").slice(0, length);
    if (!digits) return;
    e.preventDefault();
    onChange(digits);
    refs.current[Math.min(digits.length, length - 1)]?.focus();
  }

  return (
    <div className={`spx-otp ${invalid ? "spx-invalid" : ""}`} onPaste={paste}>
      {chars.map((c, i) => (
        <input
          key={i}
          ref={(el) => (refs.current[i] = el)}
          inputMode="numeric"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          value={c}
          autoFocus={autoFocus && i === 0}
          onChange={(e) => handle(i, e)}
          onKeyDown={(e) => key(i, e)}
          aria-label={`Digit ${i + 1}`}
        />
      ))}
    </div>
  );
}
