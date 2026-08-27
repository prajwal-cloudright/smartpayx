/* eslint-disable react/prop-types */
/**
 * The lazily-loaded checkout app. `open()` is the only export the loader uses.
 *
 * State discipline: the server's /request response IS the state. `step` is
 * never derived locally — every screen renders what the server last said, and
 * every mutation re-syncs. This is what makes redirect-resume and hard-refresh
 * land on the correct screen with zero preserved DOM.
 */
import React, { useEffect, useReducer, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import { api, storefrontCart, ApiError } from "../shared/api";
import { createShadowMount } from "../shared/mount";
import { SpxLogo, PoweredBy, Icon, Skeleton } from "../shared/ui";
import Login from "./screens/Login";
import Address from "./screens/Address";
import Payment from "./screens/Payment";
import Confirming from "./screens/Confirming";
import ExitSheet from "./components/ExitSheet";

const DEBUG = true;
const log = (...a) =>
  DEBUG && console.log("%c[SPX:app]", "color:#0e7a5f;font-weight:700", ...a);

const initial = {
  phase: "LOADING", // LOADING | READY | RESUME | FATAL
  session: null, // last /request response — the source of truth
  step: null, // server-declared step
  resumeRequestId: null,
  returnPath: "/",
  exitAsk: false,
  notice: null,
};

function reducer(state, a) {
  switch (a.type) {
    case "SESSION":
      return {
        ...state,
        phase: "READY",
        session: a.session,
        step: a.session.step,
        notice: a.notice ?? null,
      };
    case "STEP":
      return { ...state, step: a.step };
    case "NOTICE":
      return { ...state, notice: a.notice };
    case "EXIT":
      return { ...state, exitAsk: a.value };
    case "FATAL":
      return {
        ...state,
        phase: "FATAL",
        notice: { tone: "err", text: a.message },
      };
    default:
      return state;
  }
}

let mounted = null;

export function open({ settings, returnPath = "/", resumeRequestId = null }) {
  log("open()", { returnPath, resumeRequestId });
  try {
    const outlet = createShadowMount("spx-widget-host", {
      accent: settings.accent,
      "accent-ink": settings.accent_ink,
      bg: settings.bg,
      ink: settings.ink,
    });
    if (mounted) mounted.unmount();
    mounted = createRoot(outlet);
    mounted.render(
      <ErrorBoundary>
        <Widget
          returnPath={returnPath}
          resumeRequestId={resumeRequestId}
          onClose={close}
        />
      </ErrorBoundary>,
    );
    document.documentElement.style.overflow = "hidden";
    log("render dispatched");
  } catch (e) {
    console.error("[SPX:app] open() threw", e);
    throw e;
  }
}

function close() {
  if (mounted) {
    mounted.unmount();
    mounted = null;
  }
  const host = document.getElementById("spx-widget-host");
  if (host) host.style.setProperty("display", "none", "important"); // stop swallowing clicks
  document.documentElement.style.overflow = "";
}

function Widget({ returnPath, resumeRequestId, onClose }) {
  const [state, dispatch] = useReducer(reducer, {
    ...initial,
    returnPath,
    ...(resumeRequestId ? { phase: "RESUME", resumeRequestId } : {}),
  });
  const cartTokenRef = useRef(null);

  /** (Re)load the checkout session — the only state authority. */
  const sync = useCallback(async (notice) => {
    try {
      cartTokenRef.current ??= await storefrontCart.token();
      if (!cartTokenRef.current) {
        dispatch({
          type: "FATAL",
          message: "We couldn't read your cart. Please refresh and try again.",
        });
        return null;
      }
      const session = await api.request(cartTokenRef.current);
      dispatch({ type: "SESSION", session, notice });
      return session;
    } catch (e) {
      dispatch({
        type: "FATAL",
        message:
          e instanceof ApiError && e.code === "CART_EMPTY"
            ? "Your cart is empty."
            : (e.message ?? "Something went wrong."),
      });
      return null;
    }
  }, []);

  useEffect(() => {
    if (!resumeRequestId) void sync();
  }, [resumeRequestId, sync]);

  // Escape closes via the confirmation, never directly.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape" && !state.exitAsk)
        dispatch({ type: "EXIT", value: true });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.exitAsk]);

  const requestId = state.session?.request_id ?? state.resumeRequestId;
  const paying = state.step === "CONFIRMING" || state.phase === "RESUME";

  /**
   * Screens are REAL components rendered as JSX — never called as functions.
   * Calling them directly attaches their hooks to Widget's hook list, which
   * changes length as `step` changes and throws React error #310.
   * Each screen renders its own <div className="spx-actions"> as its last child.
   */
  function renderScreen() {
    if (state.phase === "FATAL") {
      return (
        <>
          <div className="spx-screen">
            <div className="spx-center">
              <div className="spx-status-icon spx-status-bad">
                <Icon.Alert />
              </div>
              <div className="spx-title">{state.notice?.text}</div>
            </div>
          </div>
          <div className="spx-actions">
            <button className="spx-btn spx-btn-secondary" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      );
    }

    if (
      state.phase === "RESUME" ||
      state.step === "CONFIRMING" ||
      state.step === "COMPLETED"
    ) {
      return (
        <Confirming
          requestId={requestId}
          onRetryPayment={() =>
            void sync({
              tone: "err",
              text: "Payment didn't go through. Please try again.",
            })
          }
        />
      );
    }

    if (state.phase === "LOADING" || !state.session) return <BootSkeleton />;

    switch (state.step) {
      case "LOGIN":
        return <Login session={state.session} onAuthed={() => void sync()} />;
      case "ADDRESS":
        return <Address session={state.session} onDone={() => void sync()} />;
      case "PG_SELECTION":
        return (
          <Payment
            session={state.session}
            returnPath={state.returnPath}
            onCartChanged={() =>
              void sync({
                tone: "warn",
                text: "Your cart changed — please review the updated total.",
              })
            }
            onAttemptReleased={() => void sync()}
            onEditAddress={() => dispatch({ type: "STEP", step: "ADDRESS" })}
          />
        );
      default:
        return <BootSkeleton />;
    }
  }

  return (
    <div
      className="spx-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Checkout"
    >
      <div className="spx-sheet">
        <header className="spx-header">
          <SpxLogo />
          <button
            className="spx-close"
            aria-label="Close checkout"
            onClick={() => dispatch({ type: "EXIT", value: true })}
          >
            <Icon.Close />
          </button>
        </header>

        <div className="spx-body">
          {state.notice && (
            <div className={`spx-notice spx-notice-${state.notice.tone}`}>
              <Icon.Alert
                width="15"
                height="15"
                style={{ flexShrink: 0, marginTop: 1 }}
              />
              <span>{state.notice.text}</span>
            </div>
          )}
          {renderScreen()}
        </div>

        <PoweredBy />

        {state.exitAsk && (
          <ExitSheet
            paying={paying}
            onStay={() => dispatch({ type: "EXIT", value: false })}
            onExit={onClose}
          />
        )}
      </div>
    </div>
  );
}

function BootSkeleton() {
  return (
    <div className="spx-screen">
      <Skeleton h={72} r={16} style={{ marginBottom: 16 }} />
      <Skeleton h={15} w="42%" style={{ marginBottom: 8 }} />
      <Skeleton h={13} w="66%" style={{ marginBottom: 20 }} />
      <Skeleton h={11} w="22%" style={{ marginBottom: 9 }} />
      <Skeleton h={50} r={12} />
    </div>
  );
}

/** Surfaces render errors instead of leaving an empty shadow root. */
class ErrorBoundary extends React.Component {
  constructor(p) {
    super(p);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error("[SPX:app] render error", error, info);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="spx-overlay">
        <div className="spx-sheet">
          <div className="spx-body">
            <div className="spx-center">
              <div className="spx-status-icon spx-status-bad">
                <Icon.Alert />
              </div>
              <div className="spx-title">Checkout couldn&apos;t load</div>
              <div className="spx-sub">
                {String(this.state.error?.message ?? this.state.error)}
              </div>
            </div>
          </div>
          <div className="spx-actions">
            <button
              className="spx-btn spx-btn-primary"
              onClick={() => location.assign("/checkout")}
            >
              Continue to standard checkout
            </button>
          </div>
        </div>
      </div>
    );
  }
}
