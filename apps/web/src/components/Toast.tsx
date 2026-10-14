import { useEffect, useRef, useState } from "react";
import { CloseIcon } from "./Icons";

export interface ToastAction {
  label: string;
  onAction: () => void;
}

export interface ToastState {
  id: number;
  message: string;
  action?: ToastAction;
  tone?: "info" | "success" | "danger";
}

/**
 * One transient message with an optional undo action. It auto-dismisses, but an
 * undo toast pauses its own timer while the pointer or focus is on it, so a
 * person is never racing the clock to hit Undo.
 */
export function Toast({
  toast,
  onDismiss,
  durationMs = 6000,
}: {
  toast: ToastState;
  onDismiss: () => void;
  durationMs?: number;
}) {
  const [paused, setPaused] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (paused) return;
    timer.current = setTimeout(onDismiss, durationMs);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [paused, onDismiss, durationMs, toast.id]);

  return (
    <div
      className={`toast${toast.tone ? " " + toast.tone : ""}`}
      role="status"
      aria-live="polite"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className="grow">{toast.message}</span>
      {toast.action && (
        <button
          className="toast-action"
          onClick={() => {
            toast.action!.onAction();
            onDismiss();
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button className="toast-close" aria-label="Dismiss" onClick={onDismiss}>
        <CloseIcon width={16} height={16} />
      </button>
    </div>
  );
}
