import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api";
import type { ConversationSummary, Me, PublicUser } from "../types";
import { EmptyState } from "../components/EmptyState";
import { ChatIcon, PlusIcon, SearchIcon } from "../components/Icons";
import { useNav } from "../nav";

interface Props {
  me: Me;
  refreshKey: number;
}

/**
 * The conversation list. Messaging is a first-class surface, not buried: this is
 * reachable from the Inbox in one tap. Unread counts are per conversation and
 * derived from a read watermark, so they stay correct across devices.
 */
export function MessagesScreen({ me, refreshKey }: Props) {
  const nav = useNav();
  const [items, setItems] = useState<ConversationSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [composing, setComposing] = useState(false);
  const [people, setPeople] = useState<PublicUser[] | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await api<{ conversations: ConversationSummary[] }>("/v1/conversations");
      setItems(result.conversations);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load your messages");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  useEffect(() => {
    if (!composing) return;
    void api<{ users: PublicUser[] }>("/v1/search/users?limit=12")
      .then((r) => setPeople(r.users))
      .catch(() => setPeople([]));
  }, [composing]);

  const filtered = useMemo(() => {
    const list = items ?? [];
    if (!query.trim()) return list;
    const q = query.toLowerCase();
    return list.filter((c) => {
      const name = titleFor(c, me).toLowerCase();
      const handle = c.participants.map((p) => p.handle).join(" ").toLowerCase();
      return name.includes(q) || handle.includes(q);
    });
  }, [items, query, me]);

  async function startWith(userId: string) {
    try {
      const result = await api<{ id: string }>("/v1/conversations", { body: { userId } });
      setComposing(false);
      nav.push({ name: "conversation", conversationId: result.id });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start that conversation");
    }
  }

  const totalUnread = (items ?? []).reduce((sum, c) => sum + c.unreadCount, 0);

  return (
    <div>
      <div className="row spread" style={{ marginBottom: "var(--space-4)" }}>
        <div>
          <h1 className="screen-title" style={{ margin: 0 }}>
            Messages
          </h1>
          {totalUnread > 0 && <p className="meta">{totalUnread} unread</p>}
        </div>
        <button className="btn" onClick={() => setComposing((v) => !v)} aria-expanded={composing}>
          <PlusIcon width={17} height={17} /> New
        </button>
      </div>

      {error && <div className="notice danger">{error}</div>}

      {composing && (
        <div className="card" style={{ marginBottom: "var(--space-4)" }}>
          <h3 className="section-title" style={{ marginBottom: "var(--space-3)" }}>
            Start a conversation
          </h3>
          {people === null ? (
            <div className="skeleton" aria-busy="true" />
          ) : people.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              No people to message yet. Follow someone or join a Circle to meet people.
            </p>
          ) : (
            people
              .filter((p) => p.id !== me.id)
              .map((p) => (
                <button
                  key={p.id}
                  className="row spread"
                  style={{ padding: "var(--space-3) 0", width: "100%", borderBottom: "1px solid var(--hairline)" }}
                  onClick={() => void startWith(p.id)}
                >
                  <span className="row" style={{ gap: "var(--space-3)" }}>
                    <span className="avatar sm" aria-hidden="true">
                      {p.displayName.slice(0, 1).toUpperCase()}
                    </span>
                    <span>
                      <span style={{ display: "block", fontWeight: 600 }}>{p.displayName}</span>
                      <span className="meta">@{p.handle}</span>
                    </span>
                  </span>
                  <ChatIcon width={17} height={17} style={{ color: "var(--text-muted)" }} />
                </button>
              ))
          )}
        </div>
      )}

      {items && items.length > 0 && (
        <div className="search-field" style={{ marginBottom: "var(--space-3)" }}>
          <SearchIcon width={17} height={17} aria-hidden="true" />
          <input
            aria-label="Search conversations"
            placeholder="Search conversations"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}

      {items === null && (
        <div aria-busy="true">
          <div className="skeleton" />
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      )}

      {items?.length === 0 && !composing && (
        <EmptyState
          icon={<ChatIcon />}
          title="No messages yet"
          text="Start a private conversation with someone you follow, or from their profile."
          action={
            <button className="btn primary" onClick={() => setComposing(true)}>
              <PlusIcon width={18} height={18} /> Start a conversation
            </button>
          }
        />
      )}

      {filtered.map((c) => {
        const title = titleFor(c, me);
        const other = c.participants[0];
        return (
          <button
            key={c.id}
            className="card interactive conversation-row"
            style={{ display: "flex", width: "100%", gap: "var(--space-3)", marginBottom: "var(--space-2)", alignItems: "center" }}
            onClick={() => nav.push({ name: "conversation", conversationId: c.id })}
          >
            <span className="avatar" aria-hidden="true">
              {c.kind === "group" ? <ChatIcon width={18} height={18} /> : title.slice(0, 1).toUpperCase()}
            </span>
            <span className="grow" style={{ minWidth: 0 }}>
              <span className="row spread">
                <span className="row" style={{ gap: "var(--space-2)", minWidth: 0 }}>
                  <span style={{ fontWeight: c.unreadCount > 0 ? 700 : 600 }}>{title}</span>
                  {c.circleId && <span className="chip tiny">Circle</span>}
                </span>
                <span className="meta">{relativeTime(c.lastMessageAt)}</span>
              </span>
              <span className="row spread" style={{ gap: "var(--space-2)" }}>
                <span className="conversation-preview">
                  {c.lastMessage
                    ? `${c.lastMessage.senderName ?? "Someone"}: ${
                        c.lastMessage.body ?? (c.lastMessage.mediaUrls.length > 0 ? "Photo" : "")
                      }`
                    : "No messages yet"}
                </span>
                {c.unreadCount > 0 && <span className="badge">{c.unreadCount}</span>}
              </span>
            </span>
          </button>
        );
      })}

      {items && items.length > 0 && filtered.length === 0 && (
        <EmptyState
          icon={<SearchIcon />}
          title="No matches"
          text={`Nothing matches “${query}”. Try another name or handle.`}
        />
      )}
    </div>
  );
}

export function titleFor(c: ConversationSummary, me: Me): string {
  if (c.kind === "group") return c.title ?? "Group chat";
  const other = c.participants.find((p) => p.id !== me.id) ?? c.participants[0];
  return other?.displayName ?? "Conversation";
}

function relativeTime(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
