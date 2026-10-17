import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { Comment, FeedItem, Me, PollActivity } from "../types";
import {
  CloseIcon,
  CommentIcon,
  EditIcon,
  GiftIcon,
  CheerIcon,
  HeartIcon,
  ImageIcon,
  InboxIcon,
  PollIcon,
  ReplyIcon,
  SendIcon,
  ShareIcon,
  TrashIcon,
} from "../components/Icons";
import { EmptyState } from "../components/EmptyState";
import { useNav } from "../nav";
import { ReportSheet } from "../components/ReportSheet";
import { GiftSheet } from "../components/GiftSheet";
import { PaidGiftSheet } from "../components/PaidGiftSheet";
import { Avatar } from "../components/Avatar";
import { MediaGrid } from "../components/MediaView";
import { Toast, type ToastState } from "../components/Toast";

/** A paid placement appears after this many organic posts in the feed. */
const SPONSORED_AFTER = 15;

export type CreateMode = "post" | "poll" | "plan" | "expense" | "media";

interface SponsoredAd {
  campaignId: string;
  title: string;
  body: string;
  cta: string;
  destinationUrl: string;
  advertiserName: string;
  advertiserId: string;
  placementId: string;
  /** Banner image, or null for a text-only creative. */
  imageUrl: string | null;
}

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
  const [toast, setToast] = useState<ToastState | null>(null);
  const [ad, setAd] = useState<SponsoredAd | null>(null);

  const notify = useCallback((next: Omit<ToastState, "id">) => {
    setToast({ ...next, id: Date.now() });
  }, []);

  const load = useCallback(async () => {
    setItems(null);
    setError(null);
    try {
      const result = await api<{ items: FeedItem[]; nextCursor: string | null; sponsored: SponsoredAd | null }>(
        `/v1/feed?limit=20${tab === "following" ? "&tab=following" : ""}`,
      );
      setItems(result.items);
      setCursor(result.nextCursor);
      setAd(result.sponsored ?? null);
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

  /**
   * Optimistically remove the post, then offer an Undo that restores it. The
   * server keeps the post (soft-delete), so undo is a real state transition and
   * survives a reload, not just a local list edit.
   */
  async function deletePost(item: FeedItem) {
    const snapshot = items;
    setItems((prev) => (prev ?? []).filter((p) => p.id !== item.id));
    try {
      await api(`/v1/posts/${item.id}`, { method: "DELETE" });
    } catch (err) {
      setItems(snapshot);
      notify({ message: err instanceof ApiError ? err.message : "Could not delete the post", tone: "danger" });
      return;
    }
    notify({
      message: "Post deleted",
      action: {
        label: "Undo",
        onAction: () => void restorePost(item, snapshot),
      },
    });
  }

  async function restorePost(item: FeedItem, snapshot: FeedItem[] | null) {
    try {
      await api(`/v1/posts/${item.id}/restore`, { method: "POST" });
      // Put it back where it was rather than jumping it to the top.
      setItems((prev) => {
        const list = prev ?? [];
        if (list.some((p) => p.id === item.id)) return list;
        const restored = snapshot?.find((p) => p.id === item.id) ?? item;
        return [restored, ...list].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      });
      notify({ message: "Post restored", tone: "success" });
      onChanged();
    } catch (err) {
      notify({ message: err instanceof ApiError ? err.message : "Could not restore the post", tone: "danger" });
      void load();
    }
  }

  const firstName = me.displayName.split(" ")[0];

  // A greeting that knows the hour, and a line that turns over through the day,
  // so the first thing you see is never the same twice.
  const hour = new Date().getHours();
  const greeting =
    hour < 5 ? "Still up" : hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : hour < 22 ? "Good evening" : "Late one";
  const VIBES = [
    "Make something happen.",
    "Who's free tonight?",
    "Turn talk into plans.",
    "Start something small.",
    "Good vibes only.",
    "What's the move?",
  ];
  const vibe = VIBES[(new Date().getDate() + hour) % VIBES.length];

  return (
    <div>
      <div className="row spread" style={{ marginTop: "var(--space-2)", marginBottom: "var(--space-3)" }}>
        <div>
          <p className="eyebrow">{greeting}</p>
          <h1 className="screen-title" style={{ margin: 0 }}>
            {firstName}
          </h1>
          <p className="vibe-line">{vibe}</p>
        </div>
      </div>

      {/* One composer. It opens the same create sheet as the centre action, so
          there is a single creation flow rather than two competing ones. */}
      <div className="composer">
        <Avatar name={me.displayName} url={me.avatarUrl} size="sm" />
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
        {/* A paid placement is inserted after the 15th organic post, never
            displacing ranking — the feed leads with people, and a brand only
            appears once the viewer has scrolled past a screenful. */}
        {items?.map((item, index) => (
          <div key={item.id}>
            <FeedCard
              item={item}
              me={me}
              onReact={() => void toggleReaction(item)}
              onDelete={() => void deletePost(item)}
              notify={notify}
              onChanged={onChanged}
              onCreate={onCreate}
            />
            {index === SPONSORED_AFTER && ad && (
              <SponsoredCard
                ad={ad}
                onHide={() => {
                  const hidden = ad;
                  setAd(null);
                  void api(`/v1/ads/${hidden.campaignId}/hide`, { method: "POST" }).catch(() => undefined);
                  notify({ message: "Ad hidden", tone: "info" });
                }}
              />
            )}
          </div>
        ))}
      </div>

      {cursor && (
        <button className="btn block" onClick={() => void loadMore()}>
          Load more
        </button>
      )}

      {toast && (
        <div className="toast-host">
          <Toast toast={toast} onDismiss={() => setToast(null)} />
        </div>
      )}
    </div>
  );
}

function FeedCard({
  item,
  me,
  onReact,
  onDelete,
  notify,
  onChanged,
  onCreate,
}: {
  item: FeedItem;
  me: Me;
  onReact: () => void;
  onDelete: () => void;
  notify: (t: Omit<ToastState, "id">) => void;
  onChanged: () => void;
  onCreate: (mode: CreateMode) => void;
}) {
  const nav = useNav();
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [gifting, setGifting] = useState(false);
  const [paidGifting, setPaidGifting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState(item.body ?? "");
  const [editError, setEditError] = useState<string | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Comment activity is counted locally so the thread can stay open. Calling
  // onChanged() here would bump the feed's refresh key, reload the feed, and
  // remount this card, collapsing the conversation the user is in the middle of.
  const [commentDelta, setCommentDelta] = useState(0);
  const isMine = item.author.id === me.id;

  async function saveEdit() {
    setEditBusy(true);
    setEditError(null);
    try {
      await api(`/v1/posts/${item.id}`, { method: "PATCH", body: { body: editBody } });
      setEditing(false);
      onChanged();
    } catch (err) {
      setEditError(err instanceof ApiError ? err.message : "Could not save your edit");
    } finally {
      setEditBusy(false);
    }
  }

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

  async function copyPostLink() {
    try {
      await navigator.clipboard?.writeText(`${location.origin}/p/${item.id}`);
      notify({ message: "Link copied", tone: "success" });
    } catch {
      notify({ message: "Could not copy the link", tone: "danger" });
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
          className="avatar-button"
          aria-label={`View ${item.author.displayName}'s profile`}
          onClick={() => nav.push({ name: "profile", userId: item.author.id })}
        >
          <Avatar name={item.author.displayName} url={item.author.avatarUrl} size="sm" />
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

      {editing ? (
        <div className="card" style={{ margin: "var(--space-2) 0" }}>
          <label htmlFor={`edit-${item.id}`}>Edit your post</label>
          <textarea
            id={`edit-${item.id}`}
            value={editBody}
            onChange={(e) => setEditBody(e.target.value)}
            rows={3}
            maxLength={5000}
          />
          {editError && <div className="notice danger">{editError}</div>}
          <div className="row" style={{ gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
            <button className="btn primary" onClick={() => void saveEdit()} disabled={editBusy || !editBody.trim()}>
              {editBusy ? "Saving…" : "Save changes"}
            </button>
            <button className="btn ghost" onClick={() => setEditing(false)} disabled={editBusy}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        item.body && <p className="post-body">{item.body}</p>
      )}
      {item.mediaUrls && item.mediaUrls.length > 0 && <MediaGrid urls={item.mediaUrls} />}
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
          {item.commentCount + commentDelta > 0 ? item.commentCount + commentDelta : "Comment"}
        </button>
        <button className="react-btn" onClick={() => onCreate("media")} aria-label="Add a photo">
          <ImageIcon />
        </button>
        {/* Gifting yourself makes no sense — the API refuses it. The primary
            gift action on someone else's post is the paid picker (real money,
            Bachs checkout); the free cheer is the secondary sparkle action. */}
        {!isMine && (
          <button
            className="react-btn"
            onClick={() => setPaidGifting(true)}
            aria-label="Send a gift"
          >
            <GiftIcon />
          </button>
        )}
        {!isMine && (
          <button
            className="react-btn"
            onClick={() => setGifting(true)}
            aria-label="Send a cheer"
            aria-pressed={item.viewerCheered}
          >
            <CheerIcon />
            {item.giftCount > 0 ? item.giftCount : "Cheer"}
          </button>
        )}
        {isMine && item.giftCount > 0 && (
          <span className="react-btn" aria-label={`${item.giftCount} cheers`} style={{ cursor: "default" }}>
            <CheerIcon />
            {item.giftCount}
          </span>
        )}
        <button className="react-btn" onClick={() => void copyPostLink()} aria-label="Copy link">
          <ShareIcon />
        </button>
        {isMine && !editing && (
          <button className="react-btn" onClick={() => setEditing(true)} aria-label="Edit post">
            <EditIcon />
          </button>
        )}
        {isMine && (
          <button
            className="react-btn"
            onClick={() => setConfirmDelete(true)}
            aria-label="Delete post"
          >
            <TrashIcon />
          </button>
        )}
      </div>

      {confirmDelete && (
        <div className="notice danger" role="alertdialog" aria-label="Delete this post?">
          <span className="grow">Delete this post? You can undo for a few seconds.</span>
          <button
            className="btn ghost"
            onClick={() => {
              setConfirmDelete(false);
              onDelete();
            }}
          >
            Delete
          </button>
          <button className="btn ghost" onClick={() => setConfirmDelete(false)}>
            Cancel
          </button>
        </div>
      )}

      {commentsOpen && (
        <CommentThread
          postId={item.id}
          me={me}
          notify={notify}
          onCommentChange={(delta) => setCommentDelta((d) => d + delta)}
        />
      )}

      {gifting && (
        <GiftSheet
          postId={item.id}
          authorName={item.author.displayName}
          onClose={() => setGifting(false)}
          onSent={onChanged}
        />
      )}
      {paidGifting && (
        <PaidGiftSheet
          recipientId={item.author.id}
          recipientName={item.author.handle}
          postId={item.id}
          onClose={() => setPaidGifting(false)}
        />
      )}

      {reporting && <ReportSheet targetType="post" targetId={item.id} onClose={() => setReporting(false)} />}
    </article>
  );
}


function CommentThread({
  postId,
  me,
  notify,
  onCommentChange,
}: {
  postId: string;
  me: Me;
  notify: (t: Omit<ToastState, "id">) => void;
  onCommentChange: (delta: number) => void;
}) {
  const nav = useNav();
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [replyTo, setReplyTo] = useState<{ id: string; handle: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const [editBusy, setEditBusy] = useState(false);

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
      await api(`/v1/posts/${postId}/comments`, {
        body: { body: body.trim(), ...(replyTo ? { parentId: replyTo.id } : {}) },
      });
      setBody("");
      setReplyTo(null);
      // Reload the thread so the new reply lands in the right place in the tree.
      await load();
      onCommentChange(1);
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit(id: string) {
    if (!editBody.trim()) return;
    setEditBusy(true);
    try {
      await api(`/v1/comments/${id}`, { method: "PATCH", body: { body: editBody.trim() } });
      setEditingId(null);
      await load();
    } catch (err) {
      notify({ message: err instanceof ApiError ? err.message : "Could not save your edit", tone: "danger" });
    } finally {
      setEditBusy(false);
    }
  }

  async function remove(id: string) {
    try {
      await api(`/v1/comments/${id}`, { method: "DELETE" });
      await load();
      notify({
        message: "Comment deleted",
        action: {
          label: "Undo",
          onAction: () => void restore(id),
        },
      });
    } catch (err) {
      notify({ message: err instanceof ApiError ? err.message : "Could not delete the comment", tone: "danger" });
    }
  }

  async function restore(id: string) {
    try {
      await api(`/v1/comments/${id}/restore`, { method: "POST" });
      await load();
      notify({ message: "Comment restored", tone: "success" });
    } catch (err) {
      notify({ message: err instanceof ApiError ? err.message : "Could not restore the comment", tone: "danger" });
      await load();
    }
  }

  function renderComment(c: Comment, isReply: boolean) {
    const editing = editingId === c.id;
    return (
      <div key={c.id}>
        <div className="comment-row">
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
              {c.editedAt && !c.deleted ? " · edited" : ""}
            </div>
            {c.deleted ? (
              <div className="comment-deleted">Comment deleted</div>
            ) : editing ? (
              <div className="comment-editor">
                <input
                  aria-label="Edit your comment"
                  value={editBody}
                  onChange={(e) => setEditBody(e.target.value)}
                  style={{ marginBottom: 0 }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void saveEdit(c.id);
                    if (e.key === "Escape") setEditingId(null);
                  }}
                />
                <button className="btn primary" disabled={editBusy || !editBody.trim()} onClick={() => void saveEdit(c.id)}>
                  Save
                </button>
                <button className="btn ghost" onClick={() => setEditingId(null)}>
                  Cancel
                </button>
              </div>
            ) : (
              <div>{c.body}</div>
            )}
            {!c.deleted && !editing && (
              <div className="comment-actions">
                {!isReply && (
                  <button onClick={() => setReplyTo({ id: c.id, handle: c.author.handle })}>
                    <ReplyIcon width={13} height={13} /> Reply
                  </button>
                )}
                {c.isMine && (
                  <button
                    onClick={() => {
                      setEditingId(c.id);
                      setEditBody(c.body);
                    }}
                  >
                    Edit
                  </button>
                )}
                {c.isMine && <button onClick={() => void remove(c.id)}>Delete</button>}
              </div>
            )}
          </div>
        </div>
        {!isReply && c.replies && c.replies.length > 0 && (
          <div className="comment-replies">{c.replies.map((reply) => renderComment(reply, true))}</div>
        )}
      </div>
    );
  }

  return (
    <div style={{ marginTop: "var(--space-3)", paddingTop: "var(--space-3)", borderTop: "1px solid var(--hairline)" }}>
      {comments === null && <p className="meta">Loading comments…</p>}
      {comments?.length === 0 && <p className="meta">No comments yet. Start the conversation.</p>}
      {comments?.map((c) => renderComment(c, false))}

      {replyTo && (
        <div className="meta" style={{ marginTop: "var(--space-2)" }}>
          Replying to @{replyTo.handle}{" "}
          <button
            className="btn ghost"
            style={{ padding: "0 var(--space-2)" }}
            onClick={() => setReplyTo(null)}
          >
            Cancel
          </button>
        </div>
      )}
      <div className="row" style={{ gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
        <input
          aria-label={replyTo ? `Reply to ${replyTo.handle}` : "Write a comment"}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={replyTo ? `Reply to @${replyTo.handle}…` : "Add a comment…"}
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

/**
 * A real Sponsored placement. It is visually distinct and labelled, carries the
 * advertiser's identity, and offers "Why this ad" plus a one-tap hide. The click
 * and hide both report to the server so delivery and metrics stay honest.
 */
function SponsoredCard({ ad, onHide }: { ad: SponsoredAd; onHide: () => void }) {
  const [whyOpen, setWhyOpen] = useState(false);
  function open() {
    // Fire-and-forget click report, then open the advertiser's destination.
    void api(`/v1/ads/${ad.campaignId}/click`, {
      method: "POST",
      body: { placementId: ad.placementId, surface: "feed" },
    }).catch(() => undefined);
    window.open(ad.destinationUrl, "_blank", "noopener,noreferrer");
  }
  return (
    <article className="post sponsored">
      <div className="row spread" style={{ marginBottom: "var(--space-2)" }}>
        <span className="sponsored-tag">Sponsored</span>
        <div className="row" style={{ gap: "var(--space-2)" }}>
          <button className="meta" onClick={() => setWhyOpen((v) => !v)} style={linkish}>
            Why this ad
          </button>
          <button className="meta" onClick={onHide} style={linkish}>
            Hide
          </button>
        </div>
      </div>
      <div className="post-head">
        <div className="grow">
          <div className="feed-author">{ad.advertiserName}</div>
          <div className="meta">{ad.title}</div>
        </div>
      </div>
      {whyOpen && (
        <p className="meta" style={{ marginTop: "var(--space-2)" }}>
          This appears because the advertiser chose a broad audience. Vibe does not target ads using
          your private messages or sensitive traits.
        </p>
      )}
      {/* A banner creative. The image is served from our own media path, so it
          is same-origin and needs no remote allow-list. */}
      {ad.imageUrl && (
        <button className="ad-banner" onClick={open} aria-label={`${ad.cta}: ${ad.title}`}>
          <img src={ad.imageUrl} alt="" loading="lazy" />
        </button>
      )}
      <p style={{ marginTop: "var(--space-2)" }}>{ad.body}</p>
      <button className="btn primary" style={{ marginTop: "var(--space-3)" }} onClick={open}>
        {ad.cta}
      </button>
    </article>
  );
}

const linkish: React.CSSProperties = { background: "none", border: "none", cursor: "pointer" };
