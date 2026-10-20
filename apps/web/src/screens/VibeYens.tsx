import { useCallback, useEffect, useState } from "react";
import { api, ApiError, idempotencyKey } from "../api";
import { ArrowLeftIcon, MoneyIcon, PlusIcon, SendIcon } from "../components/Icons";
import { ScreenHeader } from "../components/ScreenHeader";
import { formatMoney, toMinorUnits } from "../money";

/**
 * Vibe Yens — the optional prepaid balance.
 *
 * The whole feature is off unless the operator turns it on server-side, so this
 * screen treats a 404 as "not available" rather than an error. When it is on,
 * the balance is read from the ledger and a top-up only becomes real once the
 * provider confirms it; the copy says so plainly so nobody expects instant cash.
 */

interface WalletView {
  currency: string;
  balanceMinor: number;
  policy: string;
}

interface Activity {
  topups: Array<{ id: string; amount_minor: number; status: string; created_at: string }>;
  sent: Array<{ id: string; amount_minor: number; note: string | null; created_at: string; other_handle: string }>;
  received: Array<{ id: string; amount_minor: number; note: string | null; created_at: string; other_handle: string }>;
}

const TOPUP_AMOUNTS = [1000_00, 2500_00, 5000_00, 10000_00];


export function VibeYens({ onBack }: { onBack: () => void }) {
  const [view, setView] = useState<WalletView | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [send, setSend] = useState({ handle: "", amount: "", note: "" });
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [w, a] = await Promise.all([api<WalletView>("/v1/wallet"), api<Activity>("/v1/wallet/activity")]);
      setView(w);
      setActivity(a);
      setUnavailable(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setUnavailable(true);
        return;
      }
      setError(err instanceof ApiError ? err.message : "Could not load Vibe Yens");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function topUp(amountMinor: number) {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ redirectUrl: string | null; status: string }>("/v1/wallet/topups", {
        body: { amountMinor },
        idempotencyKey: idempotencyKey("topup"),
      });
      if (res.redirectUrl) {
        window.location.href = res.redirectUrl;
        return;
      }
      setNotice("Top-up started. Your balance updates once the payment is confirmed.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start the top-up");
    } finally {
      setBusy(false);
    }
  }

  async function sendToFriend() {
    setBusy(true);
    setError(null);
    try {
      const amountMinor = toMinorUnits(send.amount, "NGN") ?? NaN;
      if (!Number.isFinite(amountMinor) || amountMinor <= 0) throw new ApiError(400, "invalid_amount", "Enter an amount");
      const users = await api<{ users: Array<{ id: string; handle: string }> }>(
        `/v1/search/users?q=${encodeURIComponent(send.handle.replace(/^@/, ""))}`,
      );
      const match = users.users.find((u) => u.handle === send.handle.replace(/^@/, "")) ?? users.users[0];
      if (!match) throw new ApiError(404, "not_found", "No one found with that handle");
      await api("/v1/wallet/send", {
        body: { recipientId: match.id, amountMinor, note: send.note || undefined },
        idempotencyKey: idempotencyKey("send"),
      });
      setSend({ handle: "", amount: "", note: "" });
      setSendOpen(false);
      setNotice(`Sent ${formatMoney(amountMinor, "NGN")} to @${match.handle}.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button className="btn ghost" onClick={onBack} style={{ paddingLeft: 0, marginBottom: "var(--space-3)" }}>
        <ArrowLeftIcon width={18} height={18} /> Back
      </button>
      <ScreenHeader
        eyebrow="Money"
        title="Vibe Yens"
        subtitle="A prepaid balance you can spend on gifts or send to a friend inside Vibe."
      />

      {unavailable && (
        <div className="notice">Vibe Yens are not enabled on this deployment.</div>
      )}
      {error && <div className="notice danger">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      {view && (
        <>
          <div className="card" style={{ marginBottom: "var(--space-3)" }}>
            <div className="eyebrow">Balance</div>
            <div style={{ fontSize: 34, fontWeight: 700, letterSpacing: "-0.02em" }}>
              {formatMoney(view.balanceMinor, view.currency)}
            </div>
            <p className="meta" style={{ marginBottom: 0 }}>{view.policy}</p>
          </div>

          <div className="row" style={{ gap: "var(--space-2)", flexWrap: "wrap", marginBottom: "var(--space-3)" }}>
            {TOPUP_AMOUNTS.map((amount) => (
              <button key={amount} className="btn small" onClick={() => void topUp(amount)} disabled={busy}>
                <PlusIcon width={15} height={15} /> {formatMoney(amount, view.currency)}
              </button>
            ))}
            <button className="btn small primary" onClick={() => setSendOpen((v) => !v)} disabled={busy}>
              <SendIcon width={15} height={15} /> Send
            </button>
          </div>

          {sendOpen && (
            <div className="card" style={{ marginBottom: "var(--space-3)" }}>
              <div className="field">
                <label htmlFor="send-handle">To</label>
                <input
                  id="send-handle"
                  placeholder="@handle"
                  value={send.handle}
                  onChange={(e) => setSend({ ...send, handle: e.target.value })}
                />
              </div>
              <div className="field">
                <label htmlFor="send-amount">Amount (₦)</label>
                <input
                  id="send-amount"
                  inputMode="decimal"
                  placeholder="1000"
                  value={send.amount}
                  onChange={(e) => setSend({ ...send, amount: e.target.value })}
                />
              </div>
              <div className="field">
                <label htmlFor="send-note">Note (optional)</label>
                <input
                  id="send-note"
                  placeholder="for lunch"
                  value={send.note}
                  onChange={(e) => setSend({ ...send, note: e.target.value })}
                />
              </div>
              <button className="btn primary" onClick={() => void sendToFriend()} disabled={busy || !send.handle || !send.amount}>
                Send Vibe Yens
              </button>
            </div>
          )}

          {activity && (
            <div className="stack">
              <h3 className="section-title">Recent activity</h3>
              {activity.topups.length === 0 && activity.sent.length === 0 && activity.received.length === 0 && (
                <div className="meta">No Vibe Yens activity yet.</div>
              )}
              {activity.topups.map((t) => (
                <div key={t.id} className="row spread card" style={{ padding: "var(--space-3)" }}>
                  <span className="row" style={{ gap: "var(--space-2)" }}>
                    <MoneyIcon width={16} height={16} /> Top-up
                  </span>
                  <span className="meta">
                    {formatMoney(t.amount_minor, view.currency)} · {t.status}
                  </span>
                </div>
              ))}
              {activity.received.map((t) => (
                <div key={t.id} className="row spread card" style={{ padding: "var(--space-3)" }}>
                  <span className="row" style={{ gap: "var(--space-2)" }}>
                    <MoneyIcon width={16} height={16} /> From @{t.other_handle}
                  </span>
                  <span className="meta">+{formatMoney(t.amount_minor, view.currency)}</span>
                </div>
              ))}
              {activity.sent.map((t) => (
                <div key={t.id} className="row spread card" style={{ padding: "var(--space-3)" }}>
                  <span className="row" style={{ gap: "var(--space-2)" }}>
                    <SendIcon width={16} height={16} /> To @{t.other_handle}
                  </span>
                  <span className="meta">−{formatMoney(t.amount_minor, view.currency)}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {!view && !unavailable && !error && <div className="skeleton" aria-busy="true" />}
    </div>
  );
}
