import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { formatMinorUnits } from "@vibe/shared";
import type { CircleSummary, ExpenseSummary, Me, PlanSummary } from "../types";
import { EmptyState } from "../components/EmptyState";
import {
  CalendarIcon,
  CheckIcon,
  CirclesIcon,
  LockIcon,
  PlusIcon,
  UsersIcon,
  ChevronRightIcon,
  WalletIcon,
} from "../components/Icons";
import { useNav } from "../nav";

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
  const nav = useNav();
  const [circles, setCircles] = useState<CircleSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<CircleDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
    void api<CircleDetail>(`/v1/circles/${selected}`)
      .then(setDetail)
      .catch(() => setDetail(null));
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
      setNotice(`Invite copied · expires in 72h`);
      setTimeout(() => setNotice(null), 6000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create an invite");
    }
  }

  return (
    <div>
      <div className="row spread" style={{ marginBottom: "var(--space-4)" }}>
        <h1 className="screen-title" style={{ margin: 0 }}>
          Circles
        </h1>
        <button className="btn" onClick={() => setShowCreate((v) => !v)} aria-expanded={showCreate}>
          <PlusIcon width={18} height={18} /> New
        </button>
      </div>

      {notice && (
        <div className="notice success">
          <CheckIcon width={16} height={16} /> {notice}
        </div>
      )}
      {error && <div className="notice danger">{error}</div>}

      {showCreate && (
        <div className="card" style={{ marginBottom: "var(--space-4)" }}>
          <h3 className="section-title" style={{ marginBottom: "var(--space-3)" }}>
            New Circle
          </h3>
          <label htmlFor="circleName">Name</label>
          <input
            id="circleName"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Weekend crew, Housemates, Book club…"
          />
          <p className="meta" style={{ marginBottom: "var(--space-3)" }}>
            <LockIcon width={13} height={13} style={{ verticalAlign: "-2px" }} /> Private by default. Invite people after.
          </p>
          <button className="btn primary block" onClick={() => void createCircle()} disabled={!name.trim()}>
            Create Circle
          </button>
        </div>
      )}

      {circles === null && <div className="skeleton" aria-busy="true" />}

      {circles?.length === 0 && (
        <EmptyState
          icon={<CirclesIcon />}
          title="No Circles yet"
          text="A Circle is your group space — plans, shared money and memories in one place."
          action={
            <button className="btn primary" onClick={() => setShowCreate(true)}>
              <PlusIcon width={18} height={18} /> Create your first Circle
            </button>
          }
        />
      )}

      {circles?.map((circle) => {
        const active = selected === circle.id;
        return (
          <button
            key={circle.id}
            className="card interactive"
            style={{ display: "block", width: "100%", textAlign: "left", marginBottom: "var(--space-3)" }}
            onClick={() => setSelected(active ? null : circle.id)}
            aria-expanded={active}
          >
            <div className="row spread">
              <div className="row" style={{ gap: "var(--space-3)" }}>
                <span className="avatar violet" aria-hidden="true">
                  {circle.name.slice(0, 1).toUpperCase()}
                </span>
                <div>
                  <div className="feed-author">{circle.name}</div>
                  <div className="meta">
                    {circle.member_count} {circle.member_count === 1 ? "member" : "members"}
                  </div>
                </div>
              </div>
              <span className="audience-tag">
                {circle.privacy === "private" ? (
                  <LockIcon width={12} height={12} />
                ) : null}
                {circle.privacy.replace("_", " ")}
              </span>
            </div>
          </button>
        );
      })}

      {detail && (
        <div className="card" style={{ marginTop: "var(--space-2)" }}>
          <div className="row spread" style={{ marginBottom: "var(--space-3)" }}>
            <h3>{detail.circle.name}</h3>
            <button className="btn violet" onClick={() => void createInvite()}>
              <PlusIcon width={17} height={17} /> Invite
            </button>
          </div>
          <p className="muted">{detail.circle.description ?? "No description yet."}</p>

          <Section icon={<CalendarIcon width={16} height={16} />} title="Plans">
            {detail.plans.length === 0 ? (
              <p className="meta">No plans yet — propose one from Create.</p>
            ) : (
              detail.plans.map((plan) => (
                <button
                  key={plan.id}
                  className="row spread"
                  style={{
                    padding: "var(--space-3) 0",
                    width: "100%",
                    background: "none",
                    border: "none",
                    borderBottom: "1px solid var(--hairline)",
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                  onClick={() => nav.push({ name: "plan", planId: plan.id })}
                >
                  <span>{plan.title}</span>
                  <span className="row" style={{ gap: "var(--space-2)" }}>
                    <span className="meta">
                      {new Date(plan.starts_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })} ·{" "}
                      {plan.state}
                    </span>
                    <ChevronRightIcon width={16} height={16} style={{ color: "var(--text-faint)" }} />
                  </span>
                </button>
              ))
            )}
          </Section>

          <Section icon={<WalletIcon width={16} height={16} />} title="Shared money">
            <p className="meta" style={{ marginBottom: "var(--space-2)" }}>
              Vibe coordinates shared expenses. It never holds your money.
            </p>
            {detail.expenses.length === 0 ? (
              <p className="meta">Nothing to settle.</p>
            ) : (
              detail.expenses.map((expense) => (
                <button
                  key={expense.id}
                  className="row spread"
                  style={{
                    padding: "var(--space-3) 0",
                    width: "100%",
                    background: "none",
                    border: "none",
                    borderBottom: "1px solid var(--hairline)",
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                  onClick={() => nav.push({ name: "expense", expenseId: expense.id })}
                >
                  <span>{expense.description}</span>
                  <span className="row" style={{ gap: "var(--space-2)" }}>
                    <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
                      {formatMinorUnits(expense.amountMinor, expense.currency)} {expense.currency}
                    </span>
                    <ChevronRightIcon width={16} height={16} style={{ color: "var(--text-faint)" }} />
                  </span>
                </button>
              ))
            )}
          </Section>

          <Section icon={<UsersIcon width={16} height={16} />} title={`Members · ${detail.members.length}`}>
            {detail.members.map((member) => (
              <div key={member.id} className="row spread" style={{ padding: "var(--space-2) 0" }}>
                <div className="row" style={{ gap: "var(--space-2)" }}>
                  <span className="avatar sm" aria-hidden="true">
                    {member.displayName.slice(0, 1).toUpperCase()}
                  </span>
                  <span>@{member.handle}</span>
                </div>
                <span className="status-chip">{member.role}</span>
              </div>
            ))}
          </Section>
        </div>
      )}
    </div>
  );
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: "var(--space-5)" }}>
      <div className="row" style={{ gap: "var(--space-2)", marginBottom: "var(--space-2)", color: "var(--text-secondary)" }}>
        {icon}
        <span className="eyebrow" style={{ color: "var(--text-secondary)" }}>
          {title}
        </span>
      </div>
      {children}
    </section>
  );
}
