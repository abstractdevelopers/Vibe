import { useEffect, useMemo, useState } from "react";
import { api, ApiError, idempotencyKey } from "../api";
import { CloseIcon } from "./Icons";
import { GiftBurst, type GiftBurstSpec } from "./GiftBurst";

interface PaidGift {
  id: string;
  label: string;
  hint: string;
  emoji: string;
  tier: 1 | 2 | 3;
  priceMinor: number;
  currency: string;
  recipientMinor: number;
}

interface PurchaseResult {
  purchaseId: string;
  reference: string;
  amountMinor: number;
  feeMinor: number;
  recipientMinor: number;
  currency: string;
  status: string;
  redirectUrl: string | null;
}

/** ₦ formatting without doing money arithmetic in the client. */
function formatMinor(amountMinor: number, currency: string): string {
  const symbol = currency === "NGN" ? "₦" : `${currency} `;
  const whole = Math.floor(amountMinor / 100);
  const minor = Math.abs(amountMinor % 100);
  const withThousands = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return minor === 0 ? `${symbol}${withThousands}` : `${symbol}${withThousands}.${minor.toString().padStart(2, "0")}`;
}

/**
 * Paid gift picker.
 *
 * A gift costs real money and the recipient earns a real, withdrawable share,
 * so this says both out loud before anything is charged: the price, and the
 * split. The money is collected by Bachs; nothing here marks a gift paid. A
 * purchase returns `pending` and only a verified webhook fulfils it, which is
 * why the sheet shows a "waiting for the bank" state rather than a success one.
 *
 * Presentation only: `tier` decides how big the animation is, never the price.
 */
export function PaidGiftSheet({
  recipientId,
  recipientName,
  postId,
  roomId,
  onClose,
  onPurchased,
}: {
  recipientId: string;
  recipientName: string;
  postId?: string;
  /** Set when the gift is sent inside a live room. */
  roomId?: string;
  onClose: () => void;
  onPurchased?: () => void;
}) {
  const [gifts, setGifts] = useState<PaidGift[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PurchaseResult | null>(null);
  const [burst, setBurst] = useState<GiftBurstSpec | null>(null);
  // Kept so the redirect can be an explicit action rather than a surprise.
  const [redirectUrl, setRedirectUrl] = useState<string | null>(null);

  useEffect(() => {
    void api<{ gifts: PaidGift[] }>("/v1/money/gifts")
      .then((r) => setGifts(r.gifts))
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load gifts"));
  }, []);

  const chosen = useMemo(() => gifts?.find((g) => g.id === selected) ?? null, [gifts, selected]);
  const total = chosen ? chosen.priceMinor * quantity : 0;

  async function buy() {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      const purchase = await api<PurchaseResult>("/v1/money/gifts/purchase", {
        idempotencyKey: idempotencyKey("gift"),
        body: { giftId: chosen.id, quantity, recipientId, postId, roomId },
      });
      setResult(purchase);
      onPurchased?.();
      // Celebrate on this screen, then hand off to the provider's hosted
      // checkout. Redirecting instantly meant the animation was never seen; the
      // burst now plays first and the redirect is an explicit action.
      setBurst({ id: Date.now(), emoji: chosen.emoji, label: chosen.label, count: quantity });
      setRedirectUrl(purchase.redirectUrl);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start that purchase");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label="Send a gift" onClick={onClose}>
      <div className="sheet-inner paid-gift-sheet" onClick={(e) => e.stopPropagation()}>
        {burst && <GiftBurst spec={burst} onDone={() => setBurst(null)} />}
        <div className="sheet-handle" aria-hidden="true" />
        <div className="row spread" style={{ marginBottom: "var(--space-4)" }}>
          <div>
            <p className="eyebrow">Gift</p>
            <h2 style={{ fontSize: "var(--text-title)", letterSpacing: "var(--tracking-display)" }}>
              {result ? "Almost there" : `Send to @${recipientName}`}
            </h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <CloseIcon width={18} height={18} />
          </button>
        </div>

        {error && <p className="meta" role="alert" style={{ color: "var(--danger)" }}>{error}</p>}

        {result ? (
          <div className="stack">
            <p className="meta">
              Your bank is completing the payment. The gift appears on the post the moment it is confirmed —
              usually a few seconds. You can close this.
            </p>
            <div className="card">
              <div className="row spread">
                <span className="meta">Amount</span>
                <strong>{formatMinor(result.amountMinor, result.currency)}</strong>
              </div>
              <div className="row spread">
                <span className="meta">{recipientName} earns</span>
                <strong>{formatMinor(result.recipientMinor, result.currency)}</strong>
              </div>
              <div className="row spread">
                <span className="meta">Status</span>
                <strong>Waiting for the bank</strong>
              </div>
            </div>
            {redirectUrl && (
              <button
                className="btn primary block"
                onClick={() => window.location.assign(redirectUrl)}
              >
                Continue to payment
              </button>
            )}
          </div>
        ) : gifts === null ? (
          <p className="meta">Loading gifts…</p>
        ) : (
          <>
            <div className="paid-gift-grid">
              {gifts.map((g) => (
                <button
                  key={g.id}
                  className={`paid-gift-tile tier-${g.tier}${selected === g.id ? " selected" : ""}`}
                  onClick={() => setSelected(g.id)}
                  aria-pressed={selected === g.id}
                >
                  <span className="paid-gift-emoji" aria-hidden="true">{g.emoji}</span>
                  <span className="paid-gift-name">{g.label}</span>
                  <span className="paid-gift-price">{formatMinor(g.priceMinor, g.currency)}</span>
                </button>
              ))}
            </div>

            {chosen && (
              <div className="stack" style={{ marginTop: "var(--space-3)" }}>
                <div className="row spread" style={{ alignItems: "center" }}>
                  <span className="meta">How many?</span>
                  <span className="row" style={{ gap: "var(--space-2)", alignItems: "center" }}>
                    <button className="btn small" onClick={() => setQuantity((q) => Math.max(1, q - 1))} aria-label="Fewer">−</button>
                    <strong aria-live="polite">{quantity}</strong>
                    <button className="btn small" onClick={() => setQuantity((q) => Math.min(100, q + 1))} aria-label="More">+</button>
                  </span>
                </div>
                <div className="card">
                  <div className="row spread">
                    <span className="meta">You pay</span>
                    <strong>{formatMinor(total, chosen.currency)}</strong>
                  </div>
                  <div className="row spread">
                    <span className="meta">{recipientName} earns (70%)</span>
                    <strong>{formatMinor(chosen.recipientMinor * quantity, chosen.currency)}</strong>
                  </div>
                  <p className="meta" style={{ margin: "var(--space-2) 0 0" }}>
                    Vibe keeps 30%. The creator can withdraw their share to a bank account after 7 days.
                  </p>
                </div>
                <button className="btn primary" disabled={busy} onClick={() => void buy()}>
                  {busy ? "Starting checkout…" : `Pay ${formatMinor(total, chosen.currency)}`}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
