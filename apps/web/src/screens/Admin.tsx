import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import {
  ArrowLeftIcon,
  PassIcon,
  CheckIcon,
  CloseIcon,
  MegaphoneIcon,
  ShieldIcon,
  StoreIcon,
  UserIcon,
} from "../components/Icons";
import { EmptyState } from "../components/EmptyState";

/**
 * Operator console (§9). Admin surfaces are required, not optional.
 *
 * This is deliberately limited to reports, metadata, merchant verification,
 * campaign review and an audit trail. It never shows private message bodies —
 * staff access to private content is a separate, policy-governed path.
 */
export function AdminScreen({ onBack }: { onBack: () => void }) {
  const [tab, setTab] = useState<"overview" | "reports" | "merchants" | "campaigns" | "users" | "audit">("overview");

  return (
    <div>
      <button className="btn ghost" onClick={onBack} style={{ paddingLeft: 0, marginBottom: "var(--space-3)" }}>
        <ArrowLeftIcon width={18} height={18} /> Back
      </button>
      <h1 className="screen-title">Operator console</h1>
      <p className="meta">Reports, merchant verification, campaign review and an audited trail of staff actions.</p>

      <div className="pill-row" role="tablist" aria-label="Admin sections">
        {(["overview", "reports", "merchants", "campaigns", "users", "audit"] as const).map((t) => (
          <button key={t} role="tab" aria-pressed={tab === t} className="pill" onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>

      {tab === "overview" && <Overview />}
      {tab === "reports" && <Reports />}
      {tab === "merchants" && <Merchants />}
      {tab === "campaigns" && <Campaigns />}
      {tab === "users" && <Users />}
      {tab === "audit" && <Audit />}
    </div>
  );
}

function Overview() {
  const [data, setData] = useState<{
    openReports: number; pendingMerchants: number; pendingCampaigns: number; actions7d: number;
    reportsByType: Array<{ target_type: string; n: number }>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void (async () => {
      try {
        setData(await api("/v1/admin/overview"));
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Could not load the overview");
      }
    })();
  }, []);
  if (error) return <div className="notice danger">{error}</div>;
  if (!data) return <div className="skeleton" aria-busy="true" />;
  return (
    <div className="stat-grid">
      <div className="card stat"><span className="stat-num">{data.openReports}</span><span className="meta">Open reports</span></div>
      <div className="card stat"><span className="stat-num">{data.pendingMerchants}</span><span className="meta">Merchants to verify</span></div>
      <div className="card stat"><span className="stat-num">{data.pendingCampaigns}</span><span className="meta">Campaigns to review</span></div>
      <div className="card stat"><span className="stat-num">{data.actions7d}</span><span className="meta">Actions (7d)</span></div>
      {data.reportsByType.length > 0 && (
        <div className="card" style={{ gridColumn: "1 / -1" }}>
          <div className="meta">Reports by target type (7 days)</div>
          {data.reportsByType.map((r) => (
            <div key={r.target_type} className="row spread">
              <span>{r.target_type}</span>
              <span>{r.n}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface Report {
  id: string; target_type: string; target_id: string; reason: string; details: string | null;
  status: string; created_at: string; reporter_handle: string;
}

function Reports() {
  const [reports, setReports] = useState<Report[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<{ reports: Report[] }>("/v1/admin/reports?status=open");
      setReports(res.reports);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load reports");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function act(id: string, action: string) {
    setBusy(id + action);
    try {
      await api(`/v1/admin/reports/${id}/action`, { body: { action, reason: `operator ${action}` } });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not apply the action");
    } finally {
      setBusy(null);
    }
  }
  async function dismiss(id: string) {
    setBusy(id + "dismiss");
    try {
      await api(`/v1/admin/reports/${id}/dismiss`, { body: { resolution: "No violation found" } });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not dismiss the report");
    } finally {
      setBusy(null);
    }
  }

  if (error) return <div className="notice danger">{error}</div>;
  if (reports === null) return <div className="skeleton" aria-busy="true" />;
  if (reports.length === 0) {
    return <EmptyState icon={<ShieldIcon />} title="No open reports" text="The queue is clear." />;
  }
  return (
    <div className="stack">
      {reports.map((r) => (
        <div className="card" key={r.id}>
          <div className="row spread">
            <strong>{r.reason}</strong>
            <span className="audience-tag">{r.target_type}</span>
          </div>
          <div className="meta">@{r.reporter_handle} · {new Date(r.created_at).toLocaleString()}</div>
          {r.details && <p className="meta">{r.details}</p>}
          <div className="row" style={{ gap: "var(--space-2)", marginTop: "var(--space-2)", flexWrap: "wrap" }}>
            <button className="btn small" disabled={busy !== null} onClick={() => void act(r.id, "remove")}>
              <CloseIcon width={14} height={14} /> Remove
            </button>
            <button className="btn small" disabled={busy !== null} onClick={() => void act(r.id, "limit_reach")}>
              Limit reach
            </button>
            <button className="btn small" disabled={busy !== null} onClick={() => void act(r.id, "label")}>
              Label
            </button>
            <button className="btn small" disabled={busy !== null} onClick={() => void dismiss(r.id)}>
              <CheckIcon width={14} height={14} /> Dismiss
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

interface Merchant {
  id: string; name: string; category: string | null; description: string | null;
  verificationStatus: string; ownerHandle: string; ownerName: string;
}

function Merchants() {
  const [merchants, setMerchants] = useState<Merchant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const res = await api<{ merchants: Merchant[] }>("/v1/admin/merchants?status=unverified");
      setMerchants(res.merchants);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load merchants");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function verify(id: string, verificationStatus: "verified" | "rejected") {
    try {
      await api(`/v1/admin/merchants/${id}/verify`, { body: { verificationStatus, reason: `operator ${verificationStatus}` } });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update the merchant");
    }
  }

  if (error) return <div className="notice danger">{error}</div>;
  if (merchants === null) return <div className="skeleton" aria-busy="true" />;
  if (merchants.length === 0) return <EmptyState icon={<StoreIcon />} title="No merchants awaiting review" text="New businesses will appear here." />;
  return (
    <div className="stack">
      {merchants.map((m) => (
        <div className="card" key={m.id}>
          <div className="row spread">
            <strong>{m.name}</strong>
            <span className="audience-tag">{m.verificationStatus}</span>
          </div>
          <div className="meta">{m.category ?? "uncategorised"} · @{m.ownerHandle}</div>
          {m.description && <p className="meta">{m.description}</p>}
          <div className="row" style={{ gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
            <button className="btn small primary" onClick={() => void verify(m.id, "verified")}>
              <CheckIcon width={14} height={14} /> Verify
            </button>
            <button className="btn small" onClick={() => void verify(m.id, "rejected")}>Reject</button>
          </div>
        </div>
      ))}
    </div>
  );
}

interface QueueCampaign {
  id: string; name: string; status: string; objective: string; category: string; creativeTitle: string | null;
  budgetMinor: number; currency: string; advertiserHandle: string; merchantName: string | null;
  merchantVerification: string | null;
}

function Campaigns() {
  const [campaigns, setCampaigns] = useState<QueueCampaign[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const res = await api<{ campaigns: QueueCampaign[] }>("/v1/admin/campaigns");
      setCampaigns(res.campaigns);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load campaigns");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function review(id: string, decision: "approved" | "rejected", reason?: string) {
    try {
      await api(`/v1/admin/campaigns/${id}/review`, { body: { decision, reason } });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not review the campaign");
    }
  }

  if (error) return <div className="notice danger">{error}</div>;
  if (campaigns === null) return <div className="skeleton" aria-busy="true" />;
  if (campaigns.length === 0) return <EmptyState icon={<MegaphoneIcon />} title="No campaigns awaiting review" text="Submitted campaigns land here." />;
  return (
    <div className="stack">
      {campaigns.map((c) => (
        <div className="card" key={c.id}>
          <div className="row spread">
            <strong>{c.name}</strong>
            <span className="audience-tag">{c.status}</span>
          </div>
          <div className="meta">
            {c.objective} · {c.category} · {(c.budgetMinor / 100).toLocaleString()} {c.currency} · @{c.advertiserHandle}
          </div>
          {c.creativeTitle && <p className="meta">“{c.creativeTitle}”</p>}
          <div className="meta row" style={{ gap: 4 }}>
            Business: {c.merchantName ?? "—"} ({c.merchantVerification ?? "unknown"})
          </div>
          {c.merchantVerification !== "verified" && (
            <div className="notice">This campaign will not run until its business is verified.</div>
          )}
          <div className="row" style={{ gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
            <button className="btn small primary" onClick={() => void review(c.id, "approved", "Meets policy")}>
              <CheckIcon width={14} height={14} /> Approve
            </button>
            <button className="btn small" onClick={() => void review(c.id, "rejected", "Does not meet policy")}>
              <CloseIcon width={14} height={14} /> Reject
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function Users() {
  const [q, setQ] = useState("");
  const [users, setUsers] = useState<Array<{ id: string; handle: string; displayName: string; email: string; moderationStatus: string }> | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await api<{ users: typeof users }>(`/v1/admin/users?q=${encodeURIComponent(q)}`);
      setUsers(res.users);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Search failed");
    }
  }

  async function action(id: string, action: string) {
    try {
      await api(`/v1/admin/users/${id}/action`, { body: { action, reason: `operator ${action}` } });
      setUsers((prev) => prev?.map((u) => (u.id === id ? { ...u, moderationStatus: action === "restore" ? "active" : action } : u)) ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not apply the action");
    }
  }

  return (
    <div>
      {error && <div className="notice danger">{error}</div>}
      <form className="row" style={{ gap: "var(--space-2)" }} onSubmit={search}>
        <input className="input" placeholder="Search by handle or email" aria-label="Search users" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn" type="submit">Search</button>
      </form>
      <div className="stack" style={{ marginTop: "var(--space-3)" }}>
        {users?.map((u) => (
          <div className="card" key={u.id}>
            <div className="row spread">
              <strong className="row" style={{ gap: "var(--space-2)" }}>
                <UserIcon width={16} height={16} /> {u.displayName}
              </strong>
              <span className="audience-tag">{u.moderationStatus}</span>
            </div>
            <div className="meta">@{u.handle} · {u.email}</div>
            <div className="row" style={{ gap: "var(--space-2)", marginTop: "var(--space-2)", flexWrap: "wrap" }}>
              <button className="btn small" onClick={() => void action(u.id, "warn")}>Warn</button>
              <button className="btn small" onClick={() => void action(u.id, "restrict")}>Restrict</button>
              <button className="btn small" onClick={() => void action(u.id, "suspend")}>Suspend</button>
              <button className="btn small" onClick={() => void action(u.id, "ban")}>Ban</button>
              <button className="btn small" onClick={() => void action(u.id, "restore")}>
                <CheckIcon width={14} height={14} /> Restore
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Audit() {
  const [events, setEvents] = useState<Array<{ id: string; action: string; entity_type: string; entity_id: string; created_at: string }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void (async () => {
      try {
        const res = await api<{ events: typeof events }>("/v1/admin/audit");
        setEvents(res.events);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Could not load the audit log");
      }
    })();
  }, []);
  if (error) return <div className="notice danger">{error}</div>;
  if (events === null) return <div className="skeleton" aria-busy="true" />;
  return (
    <div className="stack">
      {events.map((e) => (
        <div className="card" key={e.id}>
          <div className="row spread">
            <strong className="row" style={{ gap: "var(--space-2)" }}>
              <PassIcon width={15} height={15} /> {e.action}
            </strong>
            <span className="meta">{new Date(e.created_at).toLocaleString()}</span>
          </div>
          <div className="meta">{e.entity_type} · {e.entity_id}</div>
        </div>
      ))}
    </div>
  );
}

