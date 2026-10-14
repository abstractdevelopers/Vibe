import { useCallback, useEffect, useState } from "react";
import { api, ApiError, idempotencyKey } from "../api";
import type { FeedItem, Me, PollActivity } from "../types";

interface Props {
  me: Me;
  refreshKey: number;
  onChanged: () => void;
}

type FeedTab = "for-you" | "following";

export function HomeScreen({ refreshKey, onChanged }: Props) {
  const [tab, setTab] = useState<FeedTab>("for-you");
  const [items, setItems] = useState<FeedItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [composer, setComposer] = useState("");
  const [posting, setPosting] = useState(false);

  const load = useCallback(async () => {
    setItems(null);
    setError(null);
    try {
      const result = await api<{ items: FeedItem[]; nextCursor: string | null }>("/v1/feed?limit=20");
      setItems(result.items);
      setCursor(result.nextCursor);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load the feed");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function loadMore() {
    if (!cursor) return;
    const result = await api<{ items: FeedItem[]; nextCursor: string | null }>(
      `/v1/feed?limit=20&cursor=${encodeURIComponent(cursor)}`,
    );
    setItems((prev) => [...(prev ?? []), ...result.items]);
    setCursor(result.nextCursor);
  }

  async function submitPost() {
    if (!composer.trim()) return;
    setPosting(true);
    try {
      await api("/v1/posts", { body: { body: composer.trim(), audience: "connections" } });
      setComposer("");
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not publish");
    } finally {
      setPosting(false);
    }
  }

  async function toggleReaction(item: FeedItem) {
    // Optimistic: the UI can safely revert if the server disagrees.
    setItems((prev) =>
      (prev ?? []).map((p) =>
        p.id === item.id
          ? { ...p, viewerReacted: !p.viewerReacted, reactionCount: p.reactionCount + (p.viewerReacted ? -1 : 1) }
          : p,
      ),
    );
    try {
      await api(`/v1/posts/${item.id}/reactions`, { body: { kind: "like" } });
    } catch {
      void load();
    }
  }

  return (
    <div>
      <h1 className="screen-title">Home</h1>

      <div className="card">
        <label htmlFor="composer">What&rsquo;s happening?</label>
        <textarea
          id="composer"
          value={composer}
          onChange={(e) => setComposer(e.target.value)}
          placeholder="Share a plan, ask a question, start something…"
        />
        <div className="row spread">
          <span className="meta">Visible to your connections</span>
          <button className="btn primary" onClick={() => void submitPost()} disabled={posting || !composer.trim()}>
            {posting ? "Posting…" : "Post"}
          </button>
        </div>
      </div>

      <div className="pill-row" role="tablist" aria-label="Feed filter">
        <button className="pill" aria-pressed={tab === "for-you"} onClick={() => setTab("for-you")}>
          For You
        </button>
        <button className="pill" aria-pressed={tab === "following"} onClick={() => setTab("following")}>
          Following
        </button>
        <button className="pill" aria-pressed={false} disabled title="Enable location in settings to use Nearby">
          Nearby (off)
        </button>
      </div>

      {error && <div className="notice danger">{error}</div>}

      {items === null && (
        <div aria-busy="true">
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      )}

      {items?.length === 0 && (
        <div className="empty">
          <p>Your feed is quiet.</p>
          <p className="muted">Join a Circle or follow people to fill it up.</p>
        </div>
      )}

      {items?.map((item) => (
        <FeedCard key={item.id} item={item} onReact={() => void toggleReaction(item)} onChanged={onChanged} />
      ))}

      {cursor && (
        <button className="btn" onClick={() => void loadMore()}>
          Load more
        </button>
      )}
    </div>
  );
}

function FeedCard({ item, onReact, onChanged }: { item: FeedItem; onReact: () => void; onChanged: () => void }) {
  return (
    <article className="card">
      {item.isSponsored && (
        <div className="row spread" style={{ marginBottom: "var(--space-2)" }}>
          <span className="sponsored-tag">Sponsored</span>
          <span className="meta">Why this ad · Hide · Report</span>
        </div>
      )}
      <div className="row" style={{ marginBottom: "var(--space-2)" }}>
        <span className="avatar" aria-hidden="true">
          {item.author.displayName.slice(0, 1).toUpperCase()}
        </span>
        <div>
          <div style={{ fontWeight: 600 }}>{item.author.displayName}</div>
          <div className="meta">
            @{item.author.handle} · {new Date(item.createdAt).toLocaleString()}
          </div>
        </div>
        <span className="audience-tag" style={{ marginLeft: "auto" }}>
          {item.audience}
        </span>
      </div>

      {item.body && <p style={{ marginTop: 0 }}>{item.body}</p>}
      {item.activity && <PollCard activity={item.activity} onChanged={onChanged} />}

      <div className="row" style={{ marginTop: "var(--space-2)" }}>
        <button className="btn ghost" onClick={onReact} aria-pressed={item.viewerReacted}>
          {item.viewerReacted ? "♥" : "♡"} {item.reactionCount}
        </button>
        <span className="meta">{item.commentCount} comments</span>
      </div>
    </article>
  );
}

function PollCard({ activity, onChanged }: { activity: PollActivity; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const closed = activity.state !== "open";
  const total = Math.max(activity.totalVotes, 1);

  async function vote(optionId: string) {
    setError(null);
    try {
      await api(`/v1/activities/${activity.id}/votes`, { body: { optionId } });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not record your vote");
    }
  }

  return (
    <div className="stack" style={{ marginTop: "var(--space-3)" }}>
      <div className="meta">
        Poll · {activity.totalVotes} votes · {closed ? activity.state : "open"}
      </div>
      {activity.options.map((option) => (
        <button
          key={option.id}
          className="option"
          aria-pressed={activity.viewerOptionId === option.id}
          onClick={() => void vote(option.id)}
          disabled={closed}
        >
          <span>{option.label}</span>
          <span className="row" style={{ gap: "var(--space-2)" }}>
            <span
              className="option-bar"
              style={{ width: `${Math.round((option.votes / total) * 60) + 6}px` }}
              aria-hidden="true"
            />
            <span className="meta">{option.votes}</span>
          </span>
        </button>
      ))}
      {error && <div className="notice danger">{error}</div>}
    </div>
  );
}
