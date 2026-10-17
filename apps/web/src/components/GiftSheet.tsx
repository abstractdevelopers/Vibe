import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { CheckIcon, CloseIcon, GiftIcon } from "./Icons";
import { GiftBurst, type GiftBurstSpec } from "./GiftBurst";

interface GiftOption {
  id: string;
  label: string;
  hint: string;
  count: number;
  viewerSent: boolean;
}

/**
 * A gift is a free social gesture, never money. The sheet says so plainly and
 * the server enforces the same rule: the catalogue is fixed, and no gift carries
 * a price, balance or value.
 */
export function GiftSheet({
  postId,
  roomId,
  authorName,
  onClose,
  onSent,
}: {
  /** A post id, or omit when `roomId` is set (a gift inside a live room). */
  postId?: string;
  roomId?: string;
  authorName: string;
  onClose: () => void;
  onSent?: () => void;
}) {
  const [gifts, setGifts] = useState<GiftOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [burst, setBurst] = useState<GiftBurstSpec | null>(null);

  useEffect(() => {
    if (roomId) {
      // A room gift has no per-post counts; the catalogue is the same set.
      void api<{ gifts: Array<{ id: string; label: string; hint: string }> }>("/v1/gifts/catalogue")
        .then((r) => setGifts(r.gifts.map((g) => ({ ...g, count: 0, viewerSent: false }))))
        .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load gifts"));
      return;
    }
    void api<{ gifts: GiftOption[] }>(`/v1/posts/${postId}/gifts`)
      .then((r) => setGifts(r.gifts))
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load gifts"));
  }, [postId, roomId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function send(kind: string) {
    setBusy(kind);
    setError(null);
    try {
      await api(roomId ? `/v1/activities/rooms/${roomId}/gifts` : `/v1/posts/${postId}/gifts`, { body: { kind } });
      setGifts((prev) =>
        (prev ?? []).map((g) =>
          g.id === kind && !g.viewerSent ? { ...g, viewerSent: true, count: g.count + 1 } : g,
        ),
      );
      // Play the burst only after the server accepted the gift, so the
      // animation never claims something that did not happen.
      const label = (gifts ?? []).find((g) => g.id === kind)?.label ?? "gift";
      setBurst({ id: Date.now(), emoji: EMOJI[kind] ?? "🎁", label, count: 1 });
      // Let the feed pick up the new gift count (the burst stays on screen).
      onSent?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send that gift");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label="Send a gift" onClick={onClose}>
      <div className="sheet-inner" onClick={(e) => e.stopPropagation()}>
        {burst && <GiftBurst spec={burst} onDone={() => setBurst(null)} />}
        <div className="sheet-handle" aria-hidden="true" />
        <div className="row spread" style={{ marginBottom: "var(--space-3)" }}>
          <div>
            <p className="eyebrow">Gift</p>
            <h2 style={{ fontSize: "var(--text-title)", letterSpacing: "var(--tracking-display)" }}>
              Appreciate {authorName}
            </h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <CloseIcon width={18} height={18} />
          </button>
        </div>

        <div className="notice">
          <GiftIcon width={16} height={16} /> A free cheer — no money, no balance. For a gift that carries
          real value, use the gift button on the post.
        </div>

        {error && <div className="notice danger">{error}</div>}

        {gifts === null ? (
          <div className="skeleton" aria-busy="true" />
        ) : (
          <div className="gift-grid">
            {gifts.map((g) => (
              <button
                key={g.id}
                className="gift-option"
                onClick={() => void send(g.id)}
                disabled={g.viewerSent || busy !== null}
                aria-pressed={g.viewerSent}
              >
                <span className="gift-emoji" aria-hidden="true">
                  {EMOJI[g.id] ?? "🎁"}
                </span>
                <span className="gift-label">{g.label}</span>
                <span className="meta">{g.viewerSent ? "Sent" : g.count > 0 ? `${g.count}` : g.hint}</span>
                {g.viewerSent && (
                  <span className="gift-check" aria-hidden="true">
                    <CheckIcon width={14} height={14} />
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const EMOJI: Record<string, string> = {
  sparkle: "✨",
  high_five: "🙌",
  cheer: "📣",
  hug: "🤗",
  fire: "🔥",
};
