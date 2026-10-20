import { useEffect, useState } from "react";
import { api, ApiError, idempotencyKey } from "../api";
import { CloseIcon } from "../components/Icons";
import { formatMoney } from "../money";

interface Balance {
  currency: string;
  lifetimeEarnedMinor: number;
  paidOutMinor: number;
  pendingMinor: number;
  inFlightMinor: number;
  availableMinor: number;
  minPayoutMinor: number;
  payoutProvider: string;
  destinations: Destination[];
}

interface Destination {
  id: string;
  bank_name: string | null;
  account_name: string | null;
  account_last4: string | null;
  currency: string;
  status: string;
  is_default: boolean;
}

interface Payout {
  id: string;
  amount_minor: number;
  currency: string;
  status: string;
  failure_reason: string | null;
  bank_name: string | null;
  account_last4: string | null;
}


/**
 * Wallet: what a creator has earned, and how they get it out.
 *
 * The balance shown is the ledger's, not a stored number, so it can never
 * disagree with the books. Earnings are held for a week before they become
 * withdrawable, and a payout needs an approved bank account — the screen says
 * both rather than letting a button fail.
 */
export function Wallet({ onClose }: { onClose: () => void }) {
  const [balance, setBalance] = useState<Balance | null>(null);
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [account, setAccount] = useState({ accountName: "", accountNumber: "", bankCode: "", label: "My account" });

  async function load() {
    try {
      const [b, p] = await Promise.all([
        api<Balance>("/v1/money/balance"),
        api<{ payouts: Payout[] }>("/v1/money/payouts"),
      ]);
      setBalance(b);
      setPayouts(p.payouts);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load your wallet");
    }
  }

  useEffect(() => { void load(); }, []);

  async function addAccount() {
    setBusy(true);
    setError(null);
    try {
      await api("/v1/money/destinations", { body: account });
      setAdding(false);
      setAccount({ accountName: "", accountNumber: "", bankCode: "", label: "My account" });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add that account");
    } finally {
      setBusy(false);
    }
  }

  async function withdraw() {
    const destination = balance?.destinations.find((d) => d.status === "approved");
    if (!destination) {
      setError("Add a bank account first. The bank has to approve it before it can receive money.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api("/v1/money/payouts", {
        idempotencyKey: idempotencyKey("payout"),
        body: { destinationId: destination.id },
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start that payout");
    } finally {
      setBusy(false);
    }
  }

  const payoutsEnabled = balance?.payoutProvider !== "disabled";

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label="Wallet" onClick={onClose}>
      <div className="sheet-inner" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" aria-hidden="true" />
        <div className="row spread" style={{ marginBottom: "var(--space-4)" }}>
          <div>
            <p className="eyebrow">Wallet</p>
            <h2 style={{ fontSize: "var(--text-title)", letterSpacing: "var(--tracking-display)" }}>Your earnings</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <CloseIcon width={18} height={18} />
          </button>
        </div>

        {error && <p className="meta" role="alert" style={{ color: "var(--danger)" }}>{error}</p>}

        {balance === null ? (
          <p className="meta">Loading…</p>
        ) : (
          <div className="stack">
            <div className="wallet-balance">
              <span className="meta">Available to withdraw</span>
              <span className="wallet-amount">{formatMoney(balance.availableMinor, balance.currency)}</span>
              {balance.pendingMinor > 0 && (
                <span className="meta">
                  {formatMoney(balance.pendingMinor, balance.currency)} is still clearing. New earnings can be withdrawn
                  after 7 days.
                </span>
              )}
            </div>

            <div className="card">
              <div className="wallet-row">
                <span className="meta">Earned all time</span>
                <strong>{formatMoney(balance.lifetimeEarnedMinor, balance.currency)}</strong>
              </div>
              <div className="wallet-row">
                <span className="meta">Paid out</span>
                <strong>{formatMoney(balance.paidOutMinor, balance.currency)}</strong>
              </div>
              {balance.inFlightMinor > 0 && (
                <div className="wallet-row">
                  <span className="meta">In progress</span>
                  <strong>{formatMoney(balance.inFlightMinor, balance.currency)}</strong>
                </div>
              )}
            </div>

            <div className="card">
              <div className="row spread" style={{ marginBottom: "var(--space-2)" }}>
                <strong>Bank account</strong>
                {!adding && (
                  <button className="btn small" onClick={() => setAdding(true)}>Add</button>
                )}
              </div>

              {balance.destinations.length === 0 && !adding && (
                <p className="meta">No bank account yet. Add one so you can withdraw.</p>
              )}

              {balance.destinations.map((d) => (
                <div key={d.id} className="wallet-row">
                  <div>
                    <div>{d.bank_name ?? "Bank"} •••• {d.account_last4 ?? "----"}</div>
                    <span className="meta">{d.account_name ?? ""}</span>
                  </div>
                  <span className="meta">
                    {d.status === "approved" ? "Ready" : d.status === "pending" ? "Awaiting bank" : d.status}
                  </span>
                </div>
              ))}

              {adding && (
                <div className="stack" style={{ marginTop: "var(--space-3)" }}>
                  <label>
                    <span className="meta">Account name</span>
                    <input
                      value={account.accountName}
                      onChange={(e) => setAccount({ ...account, accountName: e.target.value })}
                      placeholder="As it appears at your bank"
                    />
                  </label>
                  <label>
                    <span className="meta">Account number</span>
                    <input
                      value={account.accountNumber}
                      inputMode="numeric"
                      onChange={(e) => setAccount({ ...account, accountNumber: e.target.value.replace(/\D/g, "").slice(0, 10) })}
                      placeholder="10 digits"
                    />
                  </label>
                  <label>
                    <span className="meta">Bank code</span>
                    <input
                      value={account.bankCode}
                      inputMode="numeric"
                      onChange={(e) => setAccount({ ...account, bankCode: e.target.value.replace(/\D/g, "").slice(0, 6) })}
                      placeholder="e.g. 058"
                    />
                  </label>
                  <p className="meta">
                    Your bank reviews the account before it can receive money. We never store your full account number.
                  </p>
                  <div className="row" style={{ gap: "var(--space-2)" }}>
                    <button className="btn primary" disabled={busy} onClick={() => void addAccount()}>
                      {busy ? "Adding…" : "Add account"}
                    </button>
                    <button className="btn ghost" onClick={() => setAdding(false)}>Cancel</button>
                  </div>
                </div>
              )}
            </div>

            <button
              className="btn primary"
              disabled={busy || !payoutsEnabled || balance.availableMinor < balance.minPayoutMinor}
              onClick={() => void withdraw()}
            >
              {!payoutsEnabled
                ? "Withdrawals are not switched on yet"
                : balance.availableMinor < balance.minPayoutMinor
                  ? `Minimum withdrawal is ${formatMoney(balance.minPayoutMinor, balance.currency)}`
                  : `Withdraw ${formatMoney(balance.availableMinor, balance.currency)}`}
            </button>

            {payouts.length > 0 && (
              <div className="card">
                <strong>Withdrawals</strong>
                {payouts.map((p) => (
                  <div key={p.id} className="wallet-row">
                    <div>
                      <div>{formatMoney(p.amount_minor, p.currency)}</div>
                      <span className="meta">
                        {p.bank_name ?? "Bank"} •••• {p.account_last4 ?? "----"}
                        {p.failure_reason ? ` — ${p.failure_reason}` : ""}
                      </span>
                    </div>
                    <span className="meta">{p.status}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
