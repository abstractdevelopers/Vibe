import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { Comment, FeedItem, Me, PollActivity } from "../types";
import {
  CloseIcon,
  CommentIcon,
  GiftIcon,
  HeartIcon,
  ImageIcon,
  InboxIcon,
  PollIcon,
  SendIcon,
  ShareIcon,
} from "../components/Icons";
import { EmptyState } from "../components/EmptyState";
import { useNav } from "../nav";
import { ReportSheet } from "../components/ReportSheet";
import { GiftSheet } from "../components/GiftSheet";

export type CreateMode = "post" | "poll" | "plan" | "expense" | "media";

interface Props {
  me: Me;
  refreshKey: number;
  onChanged: () => void;
  onCreate: (mode: CreateMode) => void;
}

type FeedTab = "for-you" | "following";

export function HomeScreen({ me, refreshKey, onChanged, onCreate }: Props) {
  const [tab, setTab] = useState<FeedTab>("for-you");
  const [items, setItems] = useState<FeedItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setItems(null);
    setError(null);
    try {
      const result = await api<{ items: FeedItem[]; nextCursor: string | null }>(
        `/v1/feed?limit=20${tab === "following" ? "&tab=following" : ""}`,
      );
      setItems(result.items);
      setCursor(result.nextCursor);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load the feed");
    }
  }, [tab]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function loadMore() {
    if (!cursor) return;
    const result = await api<{ items: FeedItem[]; nextCursor: string | null }>(
      `/v1/feed?limit=20${tab === "following" ? "&tab=following" : ""}&cursor=${encodeURIComponent(cursor)}`,
    );
    setItems((prev) => [...(prev ?? []), ...result.items]);
    setCursor(result.nextCursor);
  }

  async function toggleReaction(item: FeedItem) {
    setItems((prev) =>
      (prev ?? []).map((p) =>
        p.id === item.id
          ? {
              ...p,
              viewerReacted: !p.viewerReacted,
              reactionCount: p.reactionCount + (p.viewerReacted ? -1 : 1),
            }
          : p,
      ),
    );
    try {
      await api(`/v1/posts/${item.id}/reactions`, { body: { kind: "like" } });
    } catch {
      void load();
    }
  }

  const firstName = me.displayName.split(" ")[0];

  return (
    <div>
      <div className="row spread" style={{ marginTop: "var(--space-2)", marginBottom: "var(--space-3)" }}>
        <div>
          <p className="eyebrow">Good to see you</p>
          <h1 className="screen-title" style={{ margin: 0 }}>
            {firstName}
          </h1>
        </div>
        <span className="avatar" aria-hidden="true">
          {me.displayName.slice(0, 1).toUpperCase()}
        </span>
      </div>

      {/* One composer. It opens the same create sheet as the centre action, so
          there is a single creation flow rather than two competing ones. */}
      <div className="composer">
        <span className="avatar sm" aria-hidden="true">
          {me.displayName.slice(0, 1).toUpperCase()}
        </span>
        <button className="composer-prompt" onClick={() => onCreate("post")}>
          What&rsquo;s happening, {firstName}?
        </button>
      </div>
      <div className="composer-tools" style={{ padding: "var(--space-2) 0" }}>
        <button className="tool-btn" onClick={() => onCreate("media")}>
          <ImageIcon width={16} height={16} /> Photo
        </button>
        <button className="tool-btn violet" onClick={() => onCreate("poll")}>
          <PollIcon width={16} height={16} /> Poll
        </button>
        <button className="tool-btn coral" onClick={() => onCreate("plan")}>
          <PollIcon width={16} height={16} /> Plan
        </button>
      </div>

      <div className="pill-row" role="tablist" aria-label="Feed filter">
        <button className="pill" role="tab" aria-pressed={tab === "for-you"} onClick={() => setTab("for-you")}>
          For You
        </button>
        <button className="pill" role="tab" aria-pressed={tab === "following"} onClick={() => setTab("following")}>
          Following
        </button>
      </div>

      {error && (
        <div className="notice danger">
          <span className="grow">{error}</span>
          <button className="btn ghost" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}

      {items === null && (
        <div aria-busy="true">
          <div className="skeleton" />
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      )}

      {items?.length === 0 && (
        <EmptyState
          icon={<InboxIcon />}
          title="Your feed is quiet"
          text="Follow people or join a Circle and this space fills with plans, polls and ideas."
          action={
            <button className="btn primary" onClick={() => onCreate("post")}>
              Write the first post
            </button>
          }
        />
      )}

      <div className="stream">
        {items?.map((item) => (
          <FeedCard
            key={item.id}
            item={item}
            me={me}
            onReact={() => void toggleReaction(item)}
            onChanged={onChanged}
            onCreate={onCreate}
          />
        ))}
      </div>

      {cursor && (
        <button className="btn block" onClick={() => void loadMore()}>
          Load more
        </button>
      )}
    </div>
  );
}

function FeedCard({
  item,
  me,
  onReact,
  onChanged,
  onCreate,
}: {
  item: FeedItem;
  me: Me;
  onReact: () => void;
  onChanged: () => void;
  onCreate: (mode: CreateMode) => void;
}) {
  const nav = useNav();
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [gifting, setGifting] = useState(false);

  async function share() {
    const text = item.body ?? "A post on Vibe";
    const url = `${location.origin}/p/${item.id}`;
    try {
      if (navigator.share) await navigator.share({ text, url });
      else await navigator.clipboard?.writeText(url);
    } catch {
      /* the user dismissed the share sheet; nothing to do */
    }
  }

  return (
    <article className="post">
      {item.isSponsored && (
        <div className="row spread" style={{ marginBottom: "var(--space-2)" }}>
          <span className="sponsored-tag">Sponsored</span>
          <button
            className="meta"
            onClick={() => setReporting(true)}
            style={{ background: "none", border: "none", cursor: "pointer" }}
          >
            Why this ad · Report
          </button>
        </div>
      )}

      <div className="post-head">
        <button
          className="avatar sm"
          aria-label={`View ${item.author.displayName}'s profile`}
          onClick={() => nav.push({ name: "profile", userId: item.author.id })}
          style={{ border: "none", cursor: "pointer" }}
        >
          {item.author.displayName.slice(0, 1).toUpperCase()}
        </button>
        <div className="grow">
          <button
            className="feed-author"
            onClick={() => nav.push({ name: "profile", userId: item.author.id })}
            style={{ background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }}
          >
            {item.author.displayName}
          </button>
          <div className="meta">
            @{item.author.handle} · {relativeTime(item.createdAt)}
          </div>
        </div>
        <span className="audience-tag">{audienceLabel(item.audience)}</span>
      </div>

      {item.body && <p className="post-body">{item.body}</p>}
      {item.mediaUrls && item.mediaUrls.length > 0 && <PostMedia urls={item.mediaUrls} />}
      {item.activity && <PollCard activity={item.activity} onChanged={onChanged} />}

      <div className="post-actions">
        <button className="react-btn" onClick={onReact} aria-pressed={item.viewerReacted}>
          <HeartIcon />
          {item.reactionCount > 0 ? item.reactionCount : "Like"}
        </button>
        <button
          className="react-btn"
          onClick={() => setCommentsOpen((v) => !v)}
          aria-expanded={commentsOpen}
          aria-label="Comments"
        >
          <CommentIcon />
          {item.commentCount > 0 ? item.commentCount : "Comment"}
        </button>
        <button className="react-btn" onClick={() => onCreate("media")} aria-label="Add a photo">
          <ImageIcon />
        </button>
        <button className="react-btn" onClick={() => setGifting(true)} aria-label="Send a gift">
          <GiftIcon />
        </button>
        <button className="react-btn" onClick={() => void share()} aria-label="Share">
          <ShareIcon />
        </button>
      </div>

      {commentsOpen && <CommentThread postId={item.id} me={me} onChanged={onChanged} />}

      {gifting && <GiftSheet postId={item.id} authorName={item.author.displayName} onClose={() => setGifting(false)} />}

      {reporting && <ReportSheet targetType="post" targetId={item.id} onClose={() => setReporting(false)} />}
    </article>
  );
}

function PostMedia({ urls }: { urls: string[] }) {
  if (urls.length === 1) {
    return (
      <div className="post-media">
        <img src={urls[0]} alt="" loading="lazy" />
      </div>
    );
  }
  return (
    <div className="post-media post-media-grid">
      {urls.slice(0, 4).map((url) => (
        <img key={url} src={url} alt="" loading="lazy" />
      ))}
    </div>
  );
}

function CommentThread({ postId, me, onChanged }: { postId: string; me: Me; onChanged: () => void }) {
  const nav = useNav();
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await api<{ comments: Comment[] }>(`/v1/posts/${postId}/comments`);
      setComments(result.comments);
    } catch {
      setComments([]);
    }
  }, [postId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit() {
    if (!body.trim()) return;
    setBusy(true);
    try {
      const created = await api<{ id: string; createdAt: string }>(`/v1/posts/${postId}/comments`, {
        body: { body: body.trim() },
      });
      // Append locally rather than triggering a feed reload, which would
      // remount this card and collapse the open thread.
      setComments((prev) => [
        ...(prev ?? []),
        { id: created.id, body: body.trim(), createdAt: created.createdAt, author: me },
      ]);
      setBody("");
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: "var(--space-3)", paddingTop: "var(--space-3)", borderTop: "1px solid var(--hairline)" }}>
      {comments === null && <p className="meta">Loading comments…</p>}
      {comments?.length === 0 && <p className="meta">No comments yet. Start the conversation.</p>}
      {comments?.map((c) => (
        <div
          key={c.id}
          className="row"
          style={{ gap: "var(--space-2)", alignItems: "flex-start", marginBottom: "var(--space-2)" }}
        >
          <button
            className="avatar sm"
            aria-label={`View ${c.author.displayName}'s profile`}
            onClick={() => nav.push({ name: "profile", userId: c.author.id })}
            style={{ border: "none", cursor: "pointer" }}
          >
            {c.author.displayName.slice(0, 1).toUpperCase()}
          </button>
          <div className="grow">
            <div className="meta">
              <strong style={{ color: "var(--text-secondary)" }}>@{c.author.handle}</strong> ·{" "}
              {relativeTime(c.createdAt)}
            </div>
            <div>{c.body}</div>
          </div>
        </div>
      ))}
      <div className="row" style={{ gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
        <input
          aria-label="Write a comment"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Add a comment…"
          style={{ marginBottom: 0 }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
        />
        <button className="btn primary" onClick={() => void submit()} disabled={busy || !body.trim()}>
          <SendIcon width={17} height={17} />
        </button>
      </div>
    </div>
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
    <div className="inset stack">
      <div className="row spread">
        <span className="eyebrow">Poll</span>
        <span className="meta">
          {activity.totalVotes} {activity.totalVotes === 1 ? "vote" : "votes"} ·{" "}
          {closed ? activity.state.replace("_", " ") : "open"}
        </span>
      </div>
      {activity.options.map((option) => {
        const pct = Math.round((option.votes / total) * 100);
        const chosen = activity.viewerOptionId === option.id;
        return (
          <button
            key={option.id}
            className="option"
            aria-pressed={chosen}
            onClick={() => void vote(option.id)}
            disabled={closed}
          >
            <span className="option-fill" style={{ width: `${pct}%` }} aria-hidden="true" />
            <span className="option-label">{option.label}</span>
            <span className="option-count">{pct}%</span>
          </button>
        );
      })}
      {error && <div className="notice danger">{error}</div>}
    </div>
  );
}

function audienceLabel(audience: string): string {
  switch (audience) {
    case "public":
      return "Public";
    case "circle":
      return "Circle";
    case "private":
      return "Only me";
    default:
      return "Connections";
  }
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
