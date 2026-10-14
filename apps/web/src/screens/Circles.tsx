import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { formatMinorUnits } from "@vibe/shared";
import type { CircleSummary, ExpenseSummary, Me, PlanSummary } from "../types";

interface Props {
  me: Me;
  refreshKey: number;
  onChanged: () => void;
}

interface CircleDetail {
  circle: { id: string; name: string; description: string | null; privacy: string };
  viewerRole: string;
  members: Array<{ id: string; handle: string; displayName: string; role: string }>;
  plans: PlanSummary[];
  expenses: ExpenseSummary[];
}

export function CirclesScreen({ refreshKey, onChanged }: Props) {
  const [circles, setCircles] = useState<CircleSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<CircleDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  const loadCircles = useCallback(async () => {
    try {
      const result = await api<{ circles: CircleSummary[] }>("/v1/circles");
      setCircles(result.circles);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load Circles");
    }
  }, []);

  useEffect(() => {
    void loadCircles();
  }, [loadCircles, refreshKey]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    void api<CircleDetail>(`/v1/circles/${selected}`).then(setDetail).catch(() => setDetail(null));
  }, [selected, refreshKey]);

  async function createCircle() {
    if (!name.trim()) return;
    try {
      const result = await api<{ id: string }>("/v1/circles", {
        body: { name: name.trim(), privacy: "private" },
      });
      setName("");
      setShowCreate(false);
      await loadCircles();
      setSelected(result.id);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the Circle");
    }
  }

  async function createInvite() {
    if (!selected) return;
    try {
      const result = await api<{ inviteToken: string }>(`/v1/circles/${selected}/invites`, {
        body: { role: "member", maxUses: 10, expiresInHours: 72 },
      });
      await navigator.clipboard?.writeText(result.inviteToken).catch(() => undefined);
      setError(`Invite token (copied): ${result.inviteToken}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create an invite");
    }
  }

  return (
    <div>
      <div className="row spread">
        <h1 className="screen-title">Circles</h1>
        <button className="btn" onClick={() => setShowCreate((v) => !v)}>
          New Circle
        </button>
      </div>

      {error && <div className="notice">{error}</div>}

      {showCreate && (
        <div className="card">
          <label htmlFor="circleName">Circle name</label>
          <input id="circleName" value={name} onChange={(e) => setName(e.target.value)} />
          <p className="meta">Private by default. Invite people after creating it.</p>
          <button className="btn primary" onClick={() => void createCircle()} disabled={!name.trim()}>
            Create
          </button>
        </div>
      )}

      {circles === null && <div className="skeleton" aria-busy="true" />}
      {circles?.length === 0 && (
        <div className="empty">
          <p>No Circles yet.</p>
          <p className="muted">Create one to coordinate plans and shared expenses.</p>
        </div>
      )}

      {circles?.map((circle) => (
        <button
          key={circle.id}
          className="card"
          style={{ display: "block", textAlign: "left", width: "100%", cursor: "pointer" }}
          onClick={() => setSelected(circle.id === selected ? null : circle.id)}
          aria-expanded={selected === circle.id}
        >
          <div className="row spread">
            <h3 style={{ margin: 0 }}>{circle.name}</h3>
            <span className="audience-tag">{circle.privacy.replace("_", " ")}</span>
          </div>
          <div className="meta">
            {circle.member_count} members · you are {circle.role}
          </div>
        </button>
      ))}

      {detail && (
        <div className="card">
          <div className="row spread">
            <h3>{detail.circle.name}</h3>
            <button className="btn" onClick={() => void createInvite()}>
              Invite
            </button>
          </div>
          <p className="muted">{detail.circle.description ?? "No description yet."}</p>

          <h4>Plans</h4>
          {detail.plans.length === 0 && <p className="meta">No plans yet.</p>}
          {detail.plans.map((plan) => (
            <div key={plan.id} className="row spread">
              <span>{plan.title}</span>
              <span className="meta">
                {new Date(plan.starts_at).toLocaleDateString()} · {plan.state}
              </span>
            </div>
          ))}

          <h4>Shared money</h4>
          <p className="meta">
            Track and coordinate shared expenses. Vibe does not hold pooled funds in this version.
          </p>
          {detail.expenses.length === 0 && <p className="meta">Nothing to settle.</p>}
          {detail.expenses.map((expense) => (
            <div key={expense.id} className="row spread">
              <span>{expense.description}</span>
              <span>
                {formatMinorUnits(expense.amountMinor, expense.currency)} {expense.currency} ·{" "}
                <span className="meta">{expense.splitMode}</span>
              </span>
            </div>
          ))}

          <h4>Members</h4>
          {detail.members.map((member) => (
            <div key={member.id} className="row spread">
              <span>@{member.handle}</span>
              <span className="meta">{member.role}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
