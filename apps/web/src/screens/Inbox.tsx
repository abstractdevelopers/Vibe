import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { Notification } from "../types";
import { EmptyState } from "../components/EmptyState";
import {
  BellIcon,
  CalendarIcon,
  CheckIcon,
  MoneyIcon,
  UsersIcon,
} from "../components/Icons";

interface Props {
  refreshKey: number;
  onChanged: () => void;
}

export function InboxScreen({ refreshKey, onChanged }: Props) {
  const [items, setItems] = useState<Notification[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await api<{ notifications: Notification[] }>("/v1/notifications");
      setItems(result.notifications);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load your inbox");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function markAllRead() {
    try {
      await api("/v1/notifications/read", { method: "POST" });
      setItems((prev) => (prev ?? []).map((n) => ({ ...n, read_at: n.read_at ?? new Date().toISOString() })));
      onChanged();
    } catch {
      /* leave state as-is; the next load reconciles */
    }
  }

  const unread = items?.filter((n) => !n.read_at).length ?? 0;

  return (
    <div>
      <div className="row spread" style={{ marginBottom: "var(--space-4)" }}>
        <h1 className="screen-title" style={{ margin: 0 }}>
          Inbox
        </h1>
        {unread > 0 && (
          <button className="btn ghost" onClick={() => void markAllRead()}>
            <CheckIcon width={17} height={17} /> Mark all read
          </button>
        )}
      </div>

      {error && <div className="notice danger">{error}</div>}

      {items === null && (
        <div aria-busy="true">
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      )}

      {items?.length === 0 && (
        <EmptyState
          icon={<BellIcon />}
          title="You're all caught up"
          text="Plan updates, RSVPs and shared-expense activity land here."
        />
      )}

      {items?.map((n) => {
        const { Icon, text, tone } = describe(n);
        return (
          <div
            key={n.id}
            className="card"
            style={{
              display: "flex",
              gap: "var(--space-3)",
              alignItems: "flex-start",
              marginBottom: "var(--space-2)",
              borderColor: n.read_at ? "var(--border)" : "var(--border-strong)",
            }}
          >
            <span className={`avatar sm ${tone}`} aria-hidden="true">
              <Icon width={17} height={17} strokeWidth={2} />
            </span>
            <div className="grow">
              <div style={{ fontWeight: n.read_at ? 500 : 700 }}>{text}</div>
              <div className="meta">{relativeTime(n.created_at)}</div>
            </div>
            {!n.read_at && <span className="status-chip reported">New</span>}
          </div>
        );
      })}
    </div>
  );
}

function describe(n: Notification): { Icon: typeof BellIcon; text: string; tone: string } {
  const place = typeof n.payload?.title === "string" ? n.payload.title : "a plan";
  switch (n.type) {
    case "plan.created":
      return { Icon: CalendarIcon, text: `A new plan was proposed: ${place}`, tone: "violet" };
    case "plan.updated":
    case "plan.changed":
      return { Icon: CalendarIcon, text: `A plan you're part of was updated: ${place}`, tone: "violet" };
    case "plan.cancelled":
      return { Icon: CalendarIcon, text: `A plan was cancelled: ${place}`, tone: "coral" };
    case "plan.rsvp_updated":
      return { Icon: UsersIcon, text: `Someone changed their RSVP on ${place}`, tone: "violet" };
    case "payment.reported":
      return { Icon: MoneyIcon, text: "A shared expense payment was reported — it needs verification", tone: "coral" };
    case "payment.verified":
      return { Icon: MoneyIcon, text: "A payment was verified on a shared expense", tone: "violet" };
    default:
      return { Icon: BellIcon, text: n.type.replace(/[._]/g, " "), tone: "violet" };
  }
}

function relativeTime(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
