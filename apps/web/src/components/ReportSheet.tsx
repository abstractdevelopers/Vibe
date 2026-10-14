import { useState } from "react";
import { api, ApiError } from "../api";
import { CloseIcon, ShieldIcon } from "./Icons";

interface Props {
  targetType: "user" | "post" | "comment" | "activity" | "circle" | "ad";
  targetId: string;
  onClose: () => void;
}

const REASONS = [
  { id: "spam", label: "Spam or scam" },
  { id: "harassment", label: "Harassment or hate" },
  { id: "impersonation", label: "Impersonation" },
  { id: "sexual", label: "Sexual or exploitative content" },
  { id: "threat", label: "Credible threat of harm" },
  { id: "other", label: "Something else" },
];

/**
 * Report flow, required from every surface per the spec. Kept short and
 * progressive — one choice plus optional detail, never a giant modal form.
 */
export function ReportSheet({ targetType, targetId, onClose }: Props) {
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!reason) return;
    setBusy(true);
    setError(null);
    try {
      await api("/v1/reports", {
        body: { targetType, targetId, reason, ...(note ? { details: note } : {}) },
      });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not submit the report");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label="Report" onClick={onClose}>
      <div className="sheet-inner" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" aria-hidden="true" />
        <div className="row spread" style={{ marginBottom: "var(--space-4)" }}>
          <div className="row" style={{ gap: "var(--space-2)" }}>
            <ShieldIcon width={20} height={20} style={{ color: "var(--violet-soft)" }} />
            <h2 style={{ fontSize: "var(--text-section)" }}>Report</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <CloseIcon width={18} height={18} />
          </button>
        </div>

        {done ? (
          <div className="notice success">
            Thanks — a moderator will review this. You can close this now.
          </div>
        ) : (
          <>
            {error && <div className="notice danger">{error}</div>}
            <p className="muted" style={{ marginTop: 0 }}>
              What&rsquo;s wrong with this?
            </p>
            {REASONS.map((r) => (
              <button
                key={r.id}
                className="option"
                aria-pressed={reason === r.id}
                onClick={() => setReason(r.id)}
                style={{ marginBottom: "var(--space-2)" }}
              >
                <span className="option-label">{r.label}</span>
              </button>
            ))}
            <label htmlFor="reportNote">Anything else? (optional)</label>
            <textarea id="reportNote" value={note} onChange={(e) => setNote(e.target.value)} />
            <button className="btn primary block" onClick={() => void submit()} disabled={busy || !reason}>
              {busy ? "Sending…" : "Submit report"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
