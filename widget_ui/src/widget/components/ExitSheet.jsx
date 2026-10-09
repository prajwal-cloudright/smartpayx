/**
 * Exit confirmation — slides up from the bottom of the WIDGET, not the page.
 * Positioned absolute inside .spx-sheet (which is position:relative), so on
 * desktop it stays within the modal card instead of spanning the viewport.
 */
import React, { useEffect } from "react";
import { Button } from "../../shared/ui";

export default function ExitSheet({ onStay, onExit, paying }) {
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onStay();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onStay]);

  return (
    <div className="spx-exit-scrim" onClick={onStay}>
      <div
        className="spx-exit-sheet"
        role="alertdialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="spx-grabber" />
        <div className="spx-title" style={{ marginBottom: 8 }}>
          {paying ? "Payment may be in progress" : "Leave checkout?"}
        </div>
        <div className="spx-sub">
          {paying
            ? "If you've already paid, closing this won't cancel your order — the confirmation will reach you by email."
            : "Your details are saved. You can pick up right where you left off."}
        </div>
        <div className="spx-exit-actions">
          <Button variant="secondary" onClick={onStay}>No, stay</Button>
          <Button variant="danger" onClick={onExit}>Yes, exit</Button>
        </div>
      </div>
    </div>
  );
}
