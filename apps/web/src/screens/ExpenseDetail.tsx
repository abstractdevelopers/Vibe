import { useCallback, useEffect, useState } from "react";
import { api, ApiError, idempotencyKey } from "../api";
import { formatMinorUnits } from "@vibe/shared";
import type { ExpenseDetail, ExpenseEvent, Me } from "../types";
import {
  ArrowLeftIcon,
  CheckIcon,
  ClockIcon,
  InfoIcon,
  ReceiptIcon,
  ShieldIcon,
  TimerIcon,
} from "../components/Icons";

interface Props {
  expenseId: string;
  me: Me;
  onBack: () => void;
  onChanged: () => void;
}

export function ExpenseDetailScreen({ expenseId, me, onBack, onChanged }: Props) {
  const [detail, setDetail] = useState<ExpenseDetail | null>(null);
  const [events, setEvents] = useState<ExpenseEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [d, e] = await Promise.all([
        api<ExpenseDetail>(`/v1/expenses/${expenseId}`),
        api<{ events: ExpenseEvent[] }>(`/v1/expenses/${expenseId}/events`),
      ]);
      setDetail(d);
      setEvents(e.events);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this expense");
    }
  }, [expenseId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function reportPayment() {
    if (!detail) return;
    const mine = detail.participants.find((p) => p.userId === me.id);
    if (!mine) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/expenses/${expenseId}/payment-reports`, {
        idempotencyKey: idempotencyKey("report"),
        body: { amountMinor: mine.allocationMinor, currency: detail.expense.currency },
      });
      setNotice("Marked as reported. It stays unverified until someone confirms it.");
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not report the payment");
    } finally {
      setBusy(false);
    }
  }

  async function verifyReport(reportId: string) {
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/expenses/${expenseId}/payment-reports/${reportId}/verify`, {
        body: { verificationSource: "confirmed_by_organizer" },
      });
      setNotice("Payment verified.");
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not verify the payment");
    } finally {
      setBusy(false);
    }
  }

  const currency = detail?.expense.currency ?? "";
  const mine = detail?.participants.find((p) => p.userId === me.id);
  const myReport = detail?.paymentReports.find((r) => r.participantId === me.id);
  const canVerify = detail?.expense.payerId === me.id || detail?.expense.creatorId === me.id;

  return (
    <div>
      <button className="btn ghost" onClick={onBack} style={{ paddingLeft: 0, marginBottom: "var(--space-3)" }}>
        <ArrowLeftIcon width={18} height={18} /> Back
      </button>

      {error && <div className="notice danger">{error}</div>}
      {notice && <div className="notice success">{notice}</div>}

      {!detail && !error && <div className="skeleton" aria-busy="true" />}

      {detail && (
        <>
          <div className="card" style={{ marginBottom: "var(--space-3)" }}>
            <div className="row spread" style={{ alignItems: "flex-start" }}>
              <div>
                <p className="eyebrow">{detail.expense.splitMode} split</p>
                <h1 className="screen-title" style={{ margin: "4px 0 0" }}>
                  {detail.expense.description}
                </h1>
              </div>
              <span className="stat">
                {formatMinorUnits(detail.expense.amountMinor, currency)}
                <span className="meta"> {currency}</span>
              </span>
            </div>
          </div>

          <div className="notice">
            <InfoIcon width={16} height={16} /> Payments happen through your bank or provider. Vibe
            records who has reported and who has verified — it never holds the money.
          </div>

          <h3 className="section-title" style={{ margin: "var(--space-5) 0 var(--space-3)" }}>
            Who owes what
          </h3>
          {detail.participants.map((p) => (
            <div key={p.userId} className="card" style={{ padding: "var(--space-4)", marginBottom: "var(--space-2)" }}>
              <div className="row spread">
                <div className="row" style={{ gap: "var(--space-3)" }}>
                  <span className="avatar sm" aria-hidden="true">
                    {p.displayName.slice(0, 1).toUpperCase()}
                  </span>
                  <div>
                    <div style={{ fontWeight: 600 }}>
                      @{p.handle}
                      {p.userId === me.id && <span className="meta"> · you</span>}
                    </div>
                    <div className="meta">{statusLabel(p.status)}</div>
                  </div>
                </div>
                <div className="row" style={{ gap: "var(--space-2)" }}>
                  <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>
                    {formatMinorUnits(p.allocationMinor, currency)}
                  </span>
                  <StatusChip status={p.status} />
                </div>
              </div>
            </div>
          ))}

          {mine && mine.status !== "settled" && mine.status !== "waived" && (
            <div className="card" style={{ marginBottom: "var(--space-3)" }}>
              <div className="row spread">
                <div>
                  <div style={{ fontWeight: 600 }}>Your share</div>
                  <div className="meta">
                    {formatMinorUnits(mine.allocationMinor, currency)} {currency}
                  </div>
                </div>
                {myReport ? (
                  <StatusChip status={myReport.status} />
                ) : (
                  <button className="btn primary" onClick={() => void reportPayment()} disabled={busy}>
                    <ReceiptIcon width={18} height={18} /> I&rsquo;ve paid
                  </button>
                )}
              </div>
              {myReport && myReport.status === "reported" && (
                <p className="meta" style={{ marginTop: "var(--space-2)", marginBottom: 0 }}>
                  <ClockIcon width={13} height={13} style={{ verticalAlign: "-2px" }} /> Reported by you —
                  unverified until confirmed.
                </p>
              )}
            </div>
          )}

          {canVerify && detail.paymentReports.some((r) => r.status === "reported") && (
            <div className="card" style={{ marginBottom: "var(--space-3)" }}>
              <div className="row" style={{ gap: "var(--space-2)", marginBottom: "var(--space-3)" }}>
                <ShieldIcon width={18} height={18} style={{ color: "var(--violet-soft)" }} />
                <span className="section-title">Confirm reported payments</span>
              </div>
              {detail.paymentReports
                .filter((r) => r.status === "reported")
                .map((r) => {
                  const who = detail.participants.find((p) => p.userId === r.participantId);
                  return (
                    <div key={r.id} className="row spread" style={{ padding: "var(--space-2) 0" }}>
                      <span>
                        @{who?.handle} · {formatMinorUnits(r.amountMinor, currency)} {currency}
                      </span>
                      <button className="btn violet" onClick={() => void verifyReport(r.id)} disabled={busy}>
                        <CheckIcon width={17} height={17} /> Verify
                      </button>
                    </div>
                  );
                })}
            </div>
          )}

          <h3 className="section-title" style={{ margin: "var(--space-5) 0 var(--space-3)" }}>
            History
          </h3>
          <div className="card">
            {events.length === 0 && <p className="meta">No history yet.</p>}
            {events.map((e, i) => (
              <div
                key={e.id}
                className="row"
                style={{
                  gap: "var(--space-3)",
                  alignItems: "flex-start",
                  padding: "var(--space-2) 0",
                  borderTop: i === 0 ? "none" : "1px solid var(--hairline)",
                }}
              >
                <TimerIcon width={16} height={16} style={{ color: "var(--text-faint)", marginTop: 3 }} />
                <div className="grow">
                  <div style={{ fontWeight: 500 }}>{eventLabel(e)}</div>
                  <div className="meta">{new Date(e.created_at).toLocaleString()}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  const cls =
    status === "payment_verified" || status === "settled"
      ? "verified"
      : status === "payment_reported"
        ? "reported"
        : status === "disputed" || status === "cancelled"
          ? "disputed"
          : "";
  return <span className={`status-chip ${cls}`}>{status.replace(/_/g, " ")}</span>;
}

function statusLabel(status: string): string {
  switch (status) {
    case "proposed":
      return "Not yet confirmed";
    case "accepted":
      return "Accepted the split";
    case "due":
      return "Owes their share";
    case "payment_reported":
      return "Says they paid — unverified";
    case "payment_verified":
      return "Payment verified";
    case "settled":
      return "Settled";
    case "waived":
      return "Waived";
    case "disputed":
      return "Disputed";
    case "cancelled":
      return "Cancelled";
    default:
      return status.replace(/_/g, " ");
  }
}

function eventLabel(e: ExpenseEvent): string {
  const to = e.to_status ? e.to_status.replace(/_/g, " ") : "";
  switch (e.type) {
    case "expense.created":
      return "Expense created";
    case "payment.reported":
      return "Payment reported (unverified)";
    case "payment.verified":
      return `Payment verified${e.note ? ` · ${e.note}` : ""}`;
    case "status.changed":
      return to ? `Status changed to ${to}` : "Status changed";
    default:
      return e.type.replace(/[._]/g, " ");
  }
}
