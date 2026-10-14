import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { ConversationDetail, Me, Message } from "../types";
import {
  ArrowLeftIcon,
  CheckIcon,
  CloseIcon,
  ImageIcon,
  SendIcon,
  TrashIcon,
  UploadIcon,
} from "../components/Icons";
import { useImageUpload } from "../media";
import { useNav } from "../nav";
import { useRealtime } from "../realtime";

interface Props {
  conversationId: string;
  me: Me;
  onChanged: () => void;
}

/**
 * A conversation thread.
 *
 * Sending is optimistic: the message appears immediately with a "sending"
 * state and a client-generated id. The server deduplicates on that id, so a
 * retry after a dropped response cannot double-post. Realtime only signals that
 * something changed; the thread re-reads over HTTP, so a missed socket event
 * never loses a message.
 */
export function ConversationScreen({ conversationId, me, onChanged }: Props) {
  const nav = useNav();
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<Array<{ clientId: string; body: string }>>([]);
  const media = useImageUpload();
  const endRef = useRef<HTMLDivElement>(null);

  const loadHead = useCallback(async () => {
    try {
      const [d, page] = await Promise.all([
        api<ConversationDetail>(`/v1/conversations/${conversationId}`),
        api<{ messages: Message[]; nextCursor: string | null }>(`/v1/conversations/${conversationId}/messages?limit=30`),
      ]);
      setDetail(d);
      setMessages(page.messages);
      setCursor(page.nextCursor);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not open this conversation");
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    setLoading(true);
    setMessages([]);
    void loadHead();
  }, [loadHead]);

  // Mark read when the thread opens and whenever a new message arrives.
  useEffect(() => {
    if (loading) return;
    void api(`/v1/conversations/${conversationId}/read`, { method: "POST" }).then(onChanged).catch(() => undefined);
  }, [conversationId, loading, messages.length, onChanged]);

  useRealtime((event) => {
    if (event.type === "message.created" && event.entityId === conversationId) {
      void refresh();
    }
  });

  const refresh = useCallback(async () => {
    try {
      const page = await api<{ messages: Message[]; nextCursor: string | null }>(
        `/v1/conversations/${conversationId}/messages?limit=30`,
      );
      setMessages((prev) => {
        // Merge so already-loaded older pages are not dropped when the newest
        // page arrives (a message send should not collapse history).
        const seen = new Set(prev.map((m) => m.id));
        const merged = [...page.messages.filter((m) => !seen.has(m.id)), ...prev];
        return merged.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      });
      setPending((prev) => prev.filter((p) => !page.messages.some((m) => m.clientId === p.clientId)));
    } catch {
      /* keep showing what we have; the next event or open reconciles */
    }
  }, [conversationId]);

  async function loadOlder() {
    if (!cursor) return;
    const page = await api<{ messages: Message[]; nextCursor: string | null }>(
      `/v1/conversations/${conversationId}/messages?limit=30&cursor=${encodeURIComponent(cursor)}`,
    );
    setMessages((prev) => [...page.messages, ...prev]);
    setCursor(page.nextCursor);
  }

  async function send() {
    const text = body.trim();
    const hasMedia = media.images.length > 0;
    if (!text && !hasMedia) return;
    const clientId = crypto.randomUUID();
    setPending((prev) => [...prev, { clientId, body: text }]);
    setBody("");
    setSending(true);
    try {
      const mediaUrls = hasMedia ? await media.upload() : [];
      await api(`/v1/conversations/${conversationId}/messages`, {
        body: { clientId, ...(text ? { body: text } : {}), ...(mediaUrls.length ? { mediaUrls } : {}) },
      });
      await refresh();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send that message");
      setPending((prev) => prev.filter((p) => p.clientId !== clientId));
      setBody(text);
    } finally {
      setSending(false);
      media.images.forEach((_, i) => media.remove(i));
    }
  }

  async function removeMessage(messageId: string) {
    try {
      await api(`/v1/conversations/${conversationId}/messages/${messageId}/delete`, { method: "POST" });
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, deleted: true, body: null, mediaUrls: [] } : m)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete that message");
    }
  }

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, pending.length]);

  const title =
    detail?.conversation.kind === "group"
      ? detail.conversation.title ?? "Group chat"
      : detail?.members.find((m) => m.id !== me.id)?.displayName ?? "Conversation";
  const other = detail?.members.find((m) => m.id !== me.id);

  return (
    <div className="thread">
      <div className="thread-head">
        <button className="icon-button" onClick={() => nav.back()} aria-label="Back">
          <ArrowLeftIcon width={20} height={20} />
        </button>
        <button
          className="row"
          style={{ gap: "var(--space-3)", minWidth: 0 }}
          onClick={() => other && nav.push({ name: "profile", userId: other.id })}
          disabled={!other}
        >
          <span className="avatar sm" aria-hidden="true">
            {title.slice(0, 1).toUpperCase()}
          </span>
          <span style={{ minWidth: 0 }}>
            <span style={{ display: "block", fontWeight: 700 }}>{title}</span>
            <span className="meta">
              {detail?.conversation.kind === "group"
                ? `${detail.members.length} members`
                : `@${other?.handle ?? "unknown"}`}
            </span>
          </span>
        </button>
      </div>

      {error && <div className="notice danger">{error}</div>}

      <div className="thread-body">
        {cursor && (
          <button className="btn ghost block" onClick={() => void loadOlder()}>
            Load earlier messages
          </button>
        )}

        {loading && (
          <div aria-busy="true">
            <div className="skeleton" />
            <div className="skeleton" />
          </div>
        )}

        {!loading && messages.length === 0 && pending.length === 0 && (
          <p className="thread-empty">No messages yet. Say hello 👋</p>
        )}

        {messages.map((m) => (
          <MessageBubble
            key={m.id}
            mine={m.senderId === me.id}
            author={m.author.displayName}
            body={m.body}
            mediaUrls={m.mediaUrls}
            deleted={m.deleted}
            at={m.createdAt}
            onDelete={m.senderId === me.id && !m.deleted ? () => void removeMessage(m.id) : undefined}
          />
        ))}

        {pending.map((p) => (
          <MessageBubble key={p.clientId} mine author={me.displayName} body={p.body} mediaUrls={[]} deleted={false} at={new Date().toISOString()} sending />
        ))}
        <div ref={endRef} />
      </div>

      <form
        className="thread-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {media.images.length > 0 && (
          <div className="thumb-row" style={{ marginBottom: "var(--space-2)" }}>
            {media.images.map((image, index) => (
              <div className="thumb" key={image.preview}>
                <img src={image.preview} alt={`Attachment ${index + 1}`} />
                <button type="button" onClick={() => media.remove(index)} aria-label={`Remove photo ${index + 1}`}>
                  <CloseIcon width={13} height={13} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="row" style={{ gap: "var(--space-2)" }}>
          <label className="icon-button" aria-label="Attach a photo" style={{ cursor: "pointer" }}>
            <ImageIcon width={19} height={19} />
            <input
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                if (e.target.files) void media.add(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
          <input
            aria-label="Message"
            placeholder="Message…"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            style={{ marginBottom: 0 }}
          />
          <button className="btn primary" type="submit" disabled={sending || (!body.trim() && media.images.length === 0)} aria-label="Send">
            <SendIcon width={18} height={18} />
          </button>
        </div>
        {media.error && <div className="notice danger">{media.error}</div>}
      </form>
    </div>
  );
}

function MessageBubble({
  mine,
  author,
  body,
  mediaUrls,
  deleted,
  at,
  sending,
  onDelete,
}: {
  mine: boolean;
  author: string;
  body: string | null;
  mediaUrls: string[];
  deleted: boolean;
  at: string;
  sending?: boolean;
  onDelete?: () => void;
}) {
  return (
    <div className={`bubble-row ${mine ? "mine" : "theirs"}`}>
      <div className={`bubble ${mine ? "mine" : "theirs"} ${sending ? "sending" : ""}`}>
        {!mine && <span className="bubble-author">{author}</span>}
        {deleted ? (
          <span className="bubble-deleted">This message was deleted</span>
        ) : (
          <>
            {mediaUrls.length > 0 && (
              <div className="bubble-media">
                {mediaUrls.map((url) => (
                  <img key={url} src={url} alt="Shared attachment" loading="lazy" />
                ))}
              </div>
            )}
            {body && <span className="bubble-body">{body}</span>}
          </>
        )}
        <span className="bubble-meta">
          {sending ? (
            <>
              <UploadIcon width={11} height={11} /> Sending…
            </>
          ) : (
            <>
              {time(at)}
              {mine && !deleted && <CheckIcon width={11} height={11} />}
            </>
          )}
        </span>
      </div>
      {onDelete && (
        <button className="bubble-delete" onClick={onDelete} aria-label="Delete message">
          <TrashIcon width={13} height={13} />
        </button>
      )}
    </div>
  );
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
