import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { ArrowLeftIcon, BarChartIcon, MegaphoneIcon } from "../components/Icons";
import { EmptyState } from "../components/EmptyState";

interface Campaign {
  id: string;
  name: string;
  status: string;
  objective: string;
  category: string;
  budget_minor: number;
  currency: string;
  created_at: string;
}

const CATEGORIES = ["general", "retail", "food", "events", "services"];
const OBJECTIVES = ["awareness", "traffic", "engagement", "sales"];

export function AdvertisingScreen({ onBack }: { onBack: () => void }) {
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "", objective: "awareness", creative: "", destinationUrl: "",
    budget: "", currency: "NGN", category: "general", frequencyCap: 3,
  });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api<{ campaigns: Campaign[] }>("/v1/campaigns");
      setCampaigns(res.campaigns);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load your campaigns");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await api<{ id: string }>("/v1/campaigns", {
        method: "POST",
        body: {
          name: form.name,
          objective: form.objective,
          creative: form.creative,
          destinationUrl: form.destinationUrl,
          budgetMinor: Math.round(Number(form.budget || "0") * 100),
          currency: form.currency,
          category: form.category,
          frequencyCap: form.frequencyCap,
        },
      });
      await api(`/v1/campaigns/${created.id}/submit`, { method: "POST" });
      setForm({ ...form, name: "", creative: "", destinationUrl: "", budget: "" });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the campaign");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button className="btn ghost" onClick={onBack} style={{ paddingLeft: 0, marginBottom: "var(--space-3)" }}>
        <ArrowLeftIcon width={18} height={18} /> Back
      </button>
      <h1 className="screen-title">Advertising</h1>
      <p className="meta">
        Campaigns are reviewed before they run. Every placement is labelled Sponsored, and regulated
        categories are not available.
      </p>

      {error && <div className="notice danger">{error}</div>}

      <h2 className="section-title">Your campaigns</h2>
      {campaigns === null && !error && <div className="skeleton" aria-busy="true" />}
      {campaigns?.length === 0 && (
        <EmptyState icon={<MegaphoneIcon />} title="No campaigns yet" text="Create one below to get started." />
      )}
      <div className="stack">
        {campaigns?.map((c) => (
          <div className="card" key={c.id}>
            <div className="row spread">
              <strong>{c.name}</strong>
              <span className="audience-tag">{c.status.replace(/_/g, " ")}</span>
            </div>
            <div className="meta">
              {c.objective} · {c.category} · {((c.budget_minor) / 100).toLocaleString()} {c.currency}
            </div>
          </div>
        ))}
      </div>

      <h2 className="section-title">New campaign</h2>
      <form className="card" onSubmit={create}>
        <label className="meta" htmlFor="c-name">Name</label>
        <input id="c-name" className="input" required value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })} />

        <label className="meta" htmlFor="c-objective">Objective</label>
        <select id="c-objective" className="input" value={form.objective}
          onChange={(e) => setForm({ ...form, objective: e.target.value })}>
          {OBJECTIVES.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>

        <label className="meta" htmlFor="c-category">Category</label>
        <select id="c-category" className="input" value={form.category}
          onChange={(e) => setForm({ ...form, category: e.target.value })}>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>

        <label className="meta" htmlFor="c-creative">Creative</label>
        <textarea id="c-creative" className="input" required rows={2} value={form.creative}
          onChange={(e) => setForm({ ...form, creative: e.target.value })} />

        <label className="meta" htmlFor="c-dest">Destination URL</label>
        <input id="c-dest" className="input" type="url" required placeholder="https://"
          value={form.destinationUrl} onChange={(e) => setForm({ ...form, destinationUrl: e.target.value })} />

        <label className="meta" htmlFor="c-budget">Budget</label>
        <div className="row" style={{ gap: "var(--space-2)" }}>
          <input id="c-budget" className="input" type="number" min={0} required value={form.budget}
            onChange={(e) => setForm({ ...form, budget: e.target.value })} />
          <input className="input" aria-label="Currency" style={{ width: 90 }} value={form.currency}
            onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase().slice(0, 3) })} />
        </div>

        <button className="btn primary" style={{ marginTop: "var(--space-3)" }} disabled={busy} type="submit">
          <BarChartIcon width={16} height={16} /> {busy ? "Submitting…" : "Create and submit for review"}
        </button>
      </form>
    </div>
  );
}
