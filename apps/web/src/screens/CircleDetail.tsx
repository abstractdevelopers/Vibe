import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { formatMinorUnits } from "@vibe/shared";
import type { ExpenseSummary, PlanSummary } from "../types";
import {
  ArrowLeftIcon,
  CalendarIcon,
  ChatIcon,
  CheckIcon,
  ChevronRightIcon,
  EditIcon,
  PlusIcon,
  TrashIcon,
  UsersIcon,
  WalletIcon,
} from "../components/Icons";
import { useNav } from "../nav";

interface Props {
  circleId: string;
  refreshKey: number;
  onBack: () => void;
  onChanged: () => void;
}

interface CircleDetail {
  circle: { id: string; name: string; description: string | null; privacy: string };
  /** The circle's chat. Every member is in it; it is created on first open. */
  conversationId: string;
  viewerRole: string;
  members: Array<{ id: string; handle: string; displayName: string; role: string }>;
  plans: PlanSummary[];
  expenses: ExpenseSummary[];
}

/**
 * A Circle's detail view. It is its own route so Back returns here from a plan
 * or expense, keeping the Circle context instead of jumping to the tab.
 */
export function CircleDetailScreen({ circleId, refreshKey, onBack, onChanged }: Props) {
  const nav = useNav();
  const [detail, setDetail] = useState<CircleDetail | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({ name: "", description: "", privacy: "private" });

  const load = useCallback(async () => {
    try {
      setDetail(await api<CircleDetail>(`/v1/circles/${circleId}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this Circle");
    }
  }, [circleId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  function startEdit() {
    if (!detail) return;
    setDraft({
      name: detail.circle.name,
      description: detail.circle.description ?? "",
      privacy: detail.circle.privacy,
    });
    setEditing(true);
    setConfirmDelete(false);
  }

  async function saveEdit() {
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/circles/${circleId}`, {
        method: "PATCH",
        body: {
          name: draft.name.trim(),
          description: draft.description.trim() === "" ? null : draft.description.trim(),
          privacy: draft.privacy,
        },
      });
      setEditing(false);
      setNotice("Circle updated.");
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the Circle");
    } finally {
      setBusy(false);
    }
  }

  async function deleteCircle() {
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/circles/${circleId}`, { method: "DELETE" });
      onChanged();
      onBack();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete the Circle");
      setBusy(false);
    }
  }

  async function createInvite() {
    try {
      const result = await api<{ inviteToken: string }>(`/v1/circles/${circleId}/invites`, {
        body: { role: "member" },
      });
      const link = `${location.origin}/invite/${result.inviteToken}`;
      try {
        await navigator.clipboard?.writeText(link);
        setNotice("Invite link copied to your clipboard.");
      } catch {
        setNotice(`Invite link: ${link}`);
      }
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create an invite");
    }
  }

  return (
    <div>
      <button className="btn ghost" onClick={onBack} style={{ paddingLeft: 0, marginBottom: "var(--space-3)" }}>
        <ArrowLeftIcon width={18} height={18} /> Back
      </button>

      {notice && (
        <div className="notice success">
          <CheckIcon width={16} height={16} /> {notice}
        </div>
      )}
      {error && <div className="notice danger">{error}</div>}

      {!detail && <div className="skeleton" aria-busy="true" />}

      {detail && editing && (
        <div className="card" style={{ marginBottom: "var(--space-4)" }}>
          <h3 style={{ marginTop: 0 }}>Edit Circle</h3>
          <label className="field">
            <span className="eyebrow">Name</span>
            <input
              value={draft.name}
              maxLength={80}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <label className="field">
            <span className="eyebrow">Description</span>
            <textarea
              value={draft.description}
              maxLength={500}
              rows={3}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </label>
          <label className="field">
            <span className="eyebrow">Privacy</span>
            <select
              value={draft.privacy}
              onChange={(e) => setDraft({ ...draft, privacy: e.target.value })}
            >
              <option value="private">Private — members only</option>
              <option value="invite_only">Invite only — join by link</option>
              <option value="public_discoverable">Discoverable — anyone can find it</option>
            </select>
          </label>
          <div className="row" style={{ gap: "var(--space-2)", marginTop: "var(--space-3)" }}>
            <button className="btn primary" disabled={busy || draft.name.trim() === ""} onClick={() => void saveEdit()}>
              {busy ? "Saving…" : "Save changes"}
            </button>
            <button className="btn ghost" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {detail && (
        <div className="card">
          <div className="row spread" style={{ marginBottom: "var(--space-3)" }}>
            <h3>{detail.circle.name}</h3>
            <button className="btn violet" onClick={() => void createInvite()}>
              <PlusIcon width={17} height={17} /> Invite
            </button>
          </div>
          <p className="muted">{detail.circle.description ?? "No description yet."}</p>

          {/* Edit and delete are admin/owner acts; the API enforces the same
              boundary, so hiding the buttons is a courtesy, not the guard. */}
          {(detail.viewerRole === "owner" || detail.viewerRole === "admin") && !editing && (
            <div className="row" style={{ gap: "var(--space-2)", marginBottom: "var(--space-3)", flexWrap: "wrap" }}>
              <button className="btn small ghost" onClick={startEdit}>
                <EditIcon width={15} height={15} /> Edit
              </button>
              {detail.viewerRole === "owner" &&
                (confirmDelete ? (
                  <>
                    <span className="meta">Delete this Circle for everyone?</span>
                    <button className="btn small danger" disabled={busy} onClick={() => void deleteCircle()}>
                      {busy ? "Deleting…" : "Yes, delete"}
                    </button>
                    <button className="btn small ghost" disabled={busy} onClick={() => setConfirmDelete(false)}>
                      Keep it
                    </button>
                  </>
                ) : (
                  <button className="btn small danger" onClick={() => setConfirmDelete(true)}>
                    <TrashIcon width={15} height={15} /> Delete
                  </button>
                ))}
            </div>
          )}

          {/* The circle's chat is the circle. Plans and money below are what the
              conversation turns into. */}
          <button
            className="btn primary block"
            style={{ marginBottom: "var(--space-4)" }}
            onClick={() => nav.push({ name: "conversation", conversationId: detail.conversationId })}
          >
            <ChatIcon width={18} height={18} /> Open Circle chat
          </button>

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
