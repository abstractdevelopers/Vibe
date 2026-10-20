import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { ArrowLeftIcon, BarChartIcon, MegaphoneIcon, EyeIcon, ClickIcon } from "../components/Icons";
import { EmptyState } from "../components/EmptyState";
import { ScreenHeader } from "../components/ScreenHeader";
import { formatMoney, toMinorUnits } from "../money";

interface Campaign {
  id: string;
  name: string;
  status: string;
  objective: string;
  category: string;
  budgetMinor: number;
  currency: string;
  creativeTitle: string | null;
  createdAt: string;
}

interface Merchant {
  id: string;
  name: string;
  verificationStatus: string;
}

interface Metrics {
  verified: { served: number; reach: number };
  reported: { impressions: number; clicks: number };
  clickThroughRate: number | null;
}

const CATEGORIES = ["general", "retail", "food", "events", "services"];
const OBJECTIVES = ["awareness", "traffic", "engagement", "sales"];

export function AdvertisingScreen({ onBack }: { onBack: () => void }) {
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [metricsFor, setMetricsFor] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [form, setForm] = useState({
    name: "", objective: "awareness", creative: "", creativeTitle: "", creativeBody: "",
    destinationUrl: "", budget: "", currency: "NGN", category: "general", frequencyCap: 3, merchantId: "",
  });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [c, m] = await Promise.all([
        api<{ campaigns: Campaign[] }>("/v1/campaigns"),
        api<{ merchants: Merchant[] }>("/v1/merchants/mine"),
      ]);
      setCampaigns(c.campaigns);
      setMerchants(m.merchants);
      setForm((f) => (f.merchantId || !m.merchants[0] ? f : { ...f, merchantId: m.merchants[0]!.id }));
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
          creativeTitle: form.creativeTitle || undefined,
          creativeBody: form.creativeBody || undefined,
          destinationUrl: form.destinationUrl,
          budgetMinor: toMinorUnits(form.budget || "0", form.currency) ?? 0,
          currency: form.currency,
          category: form.category,
          frequencyCap: form.frequencyCap,
          merchantId: form.merchantId,
        },
      });
      await api(`/v1/campaigns/${created.id}/submit`, { method: "POST" });
      setForm({ ...form, name: "", creative: "", creativeTitle: "", creativeBody: "", destinationUrl: "", budget: "" });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the campaign");
    } finally {
      setBusy(false);
    }
  }

  async function showMetrics(id: string) {
    setMetricsFor(id);
    setMetrics(null);
    try {
      setMetrics(await api<Metrics>(`/v1/campaigns/${id}/metrics`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load metrics");
    }
  }

  return (
    <div>
      <button className="btn ghost" onClick={onBack} style={{ paddingLeft: 0, marginBottom: "var(--space-3)" }}>
        <ArrowLeftIcon width={18} height={18} /> Back
      </button>
      <ScreenHeader
        eyebrow="Reach"
        title="Advertising"
        subtitle="Campaigns are reviewed before they run, and only for a verified business. Every placement is labelled Sponsored, and regulated categories are not available."
      />

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
              <strong>{c.creativeTitle || c.name}</strong>
              <span className="audience-tag">{c.status.replace(/_/g, " ")}</span>
            </div>
            <div className="meta">
              {c.objective} · {c.category} · {formatMoney(c.budgetMinor, c.currency)} budget
            </div>
            <button className="btn small" style={{ marginTop: "var(--space-2)" }} onClick={() => void showMetrics(c.id)}>
              <BarChartIcon width={14} height={14} /> Metrics
            </button>
            {metricsFor === c.id && (
              <div style={{ marginTop: "var(--space-2)" }}>
                {!metrics ? (
                  <div className="skeleton" aria-busy="true" />
                ) : (
                  <div className="stat-grid">
                    <div className="card stat">
                      <span className="stat-num row" style={{ gap: 4 }}>
                        <EyeIcon width={16} height={16} /> {metrics.verified.served}
                      </span>
                      <span className="meta">Verified served</span>
                    </div>
                    <div className="card stat">
                      <span className="stat-num">{metrics.verified.reach}</span>
                      <span className="meta">Verified reach</span>
                    </div>
                    <div className="card stat">
                      <span className="stat-num">{metrics.reported.impressions}</span>
                      <span className="meta">Reported impressions</span>
                    </div>
                    <div className="card stat">
                      <span className="stat-num row" style={{ gap: 4 }}>
                        <ClickIcon width={16} height={16} /> {metrics.reported.clicks}
                      </span>
                      <span className="meta">Reported clicks</span>
                    </div>
                    <p className="meta" style={{ gridColumn: "1 / -1" }}>
                      Verified counts come from Vibe serving the ad. Reported counts come from the
                      viewer's device. They are shown separately, never as one number.
                      {metrics.clickThroughRate !== null && ` Click-through: ${(metrics.clickThroughRate * 100).toFixed(1)}%.`}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      <h2 className="section-title">New campaign</h2>
      {merchants.length === 0 ? (
        <div className="notice">
          Create a business first (Orders → your storefront), then come back to advertise for it.
        </div>
      ) : (
        <form className="card" onSubmit={create}>
          <label className="meta" htmlFor="c-merchant">Business</label>
          <select id="c-merchant" className="input" required value={form.merchantId}
            onChange={(e) => setForm({ ...form, merchantId: e.target.value })}>
            {merchants.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} {m.verificationStatus !== "verified" ? `(${m.verificationStatus} — won't run yet)` : ""}
              </option>
            ))}
          </select>

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

          <label className="meta" htmlFor="c-title">Headline shown in the card</label>
          <input id="c-title" className="input" value={form.creativeTitle}
            onChange={(e) => setForm({ ...form, creativeTitle: e.target.value })} />

          <label className="meta" htmlFor="c-body">Body shown in the card</label>
          <textarea id="c-body" className="input" rows={2} value={form.creativeBody}
            onChange={(e) => setForm({ ...form, creativeBody: e.target.value })} />

          <label className="meta" htmlFor="c-creative">Creative (internal note)</label>
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
      )}
    </div>
  );
}
