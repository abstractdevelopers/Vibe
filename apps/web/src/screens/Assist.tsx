import { useState } from "react";
import { api, ApiError } from "../api";
import { ArrowLeftIcon, SparklesIcon, CheckIcon, CloseIcon } from "../components/Icons";

type Kind = "draft_plan" | "suggest_events" | "propose_budget" | "reminder";

interface Suggestion {
  id: string;
  title: string;
  body: string;
  fields: Record<string, unknown>;
  generated: boolean;
}

const KINDS: Array<{ id: Kind; label: string; hint: string }> = [
  { id: "draft_plan", label: "Draft a plan", hint: "A starting point for an outing" },
  { id: "suggest_events", label: "Suggest activities", hint: "Ideas to start a plan" },
  { id: "propose_budget", label: "Propose a budget", hint: "A rough per-head split" },
  { id: "reminder", label: "Draft a reminder", hint: "A nudge for the group" },
];

/**
 * AI assistance (§4.10). Every result is a labelled suggestion the person can
 * accept or dismiss. Accepting records intent only — it never creates a plan,
 * sends a message, books, or moves money.
 */
export function AssistScreen({ onBack }: { onBack: () => void }) {
  const [kind, setKind] = useState<Kind>("draft_plan");
  const [prompt, setPrompt] = useState("");
  const [total, setTotal] = useState("");
  const [people, setPeople] = useState("4");
  const [result, setResult] = useState<Suggestion | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function propose(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    setStatus(null);
    try {
      const body: Record<string, unknown> = { kind, prompt: prompt || undefined };
      if (kind === "propose_budget") {
        body.totalMinor = Math.round(Number(total || "0") * 100);
        body.people = Math.max(1, Number(people || "1"));
      }
      setResult(await api<Suggestion>("/v1/assist/propose", { body }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not generate a suggestion");
    } finally {
      setBusy(false);
    }
  }

  async function decide(decision: "accept" | "dismiss") {
    if (!result) return;
    try {
      await api(`/v1/assist/suggestions/${result.id}/${decision}`, { method: "POST" });
      setStatus(decision === "accept" ? "Saved to your suggestions. Nothing was created — review it when you are ready." : "Dismissed.");
      setResult(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not record your choice");
    }
  }

  return (
    <div>
      <button className="btn ghost" onClick={onBack} style={{ paddingLeft: 0, marginBottom: "var(--space-3)" }}>
        <ArrowLeftIcon width={18} height={18} /> Back
      </button>
      <h1 className="screen-title row" style={{ gap: "var(--space-2)" }}>
        <SparklesIcon width={22} height={22} /> Assist
      </h1>
      <p className="meta">
        Suggestions are generated. Vibe never sends, books, buys, or moves money for you — you confirm
        every action yourself.
      </p>

      <div className="pill-row" role="tablist" aria-label="Suggestion type">
        {KINDS.map((k) => (
          <button key={k.id} role="tab" aria-pressed={kind === k.id} className="pill" onClick={() => setKind(k.id)}>
            {k.label}
          </button>
        ))}
      </div>

      {error && <div className="notice danger">{error}</div>}
      {status && <div className="notice success">{status}</div>}

      <form className="card" onSubmit={propose}>
        <label className="meta" htmlFor="a-prompt">{KINDS.find((k) => k.id === kind)?.hint}</label>
        <input id="a-prompt" className="input" value={prompt} placeholder="e.g. Sunday brunch" onChange={(e) => setPrompt(e.target.value)} />
        {kind === "propose_budget" && (
          <div className="row" style={{ gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
            <input className="input" type="number" min={0} aria-label="Total" placeholder="Total" value={total} onChange={(e) => setTotal(e.target.value)} />
            <input className="input" type="number" min={1} aria-label="People" placeholder="People" value={people} onChange={(e) => setPeople(e.target.value)} />
          </div>
        )}
        <button className="btn primary" type="submit" style={{ marginTop: "var(--space-3)" }} disabled={busy}>
          <SparklesIcon width={16} height={16} /> {busy ? "Generating…" : "Generate suggestion"}
        </button>
      </form>

      {result && (
        <div className="card" style={{ marginTop: "var(--space-3)" }}>
          <div className="row spread">
            <strong>{result.title}</strong>
            <span className="audience-tag">Generated</span>
          </div>
          <p style={{ whiteSpace: "pre-wrap", marginTop: "var(--space-2)" }}>{result.body}</p>
          <div className="row" style={{ gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
            <button className="btn small primary" onClick={() => void decide("accept")}>
              <CheckIcon width={14} height={14} /> Accept
            </button>
            <button className="btn small" onClick={() => void decide("dismiss")}>
              <CloseIcon width={14} height={14} /> Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
