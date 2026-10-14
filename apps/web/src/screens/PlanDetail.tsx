import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { formatMinorUnits } from "@vibe/shared";
import type { Me } from "../types";
import {
  ArrowLeftIcon,
  CalendarIcon,
  CheckIcon,
  ClockIcon,
  MapPinIcon,
  MoneyIcon,
  TimerIcon,
  UsersIcon,
} from "../components/Icons";

interface Props {
  planId: string;
  me: Me;
  onBack: () => void;
  onChanged: () => void;
}

interface PlanDetail {
  plan: {
    id: string;
    circleId: string;
    organizerId: string;
    title: string;
    description: string | null;
    state: string;
    startsAt: string;
    timezone: string;
    place: string | null;
    onlineUrl: string | null;
    budgetAmount: number | null;
    budgetCurrency: string | null;
    participantLimit: number | null;
    cancellationPolicy: string | null;
  };
  goingCount: number;
  rsvps: Array<{ userId: string; state: string }>;
}

const RSVP_STATES = [
  { id: "going", label: "Going" },
  { id: "interested", label: "Interested" },
  { id: "declined", label: "Can't make it" },
];

export function PlanDetailScreen({ planId, me, onBack, onChanged }: Props) {
  const [detail, setDetail] = useState<PlanDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [viewerRsvp, setViewerRsvp] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await api<PlanDetail>(`/v1/plans/${planId}`);
      setDetail(result);
      setViewerRsvp(result.rsvps.find((r) => r.userId === me.id)?.state ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this plan");
    }
  }, [planId, me.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function rsvp(state: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ state: string }>(`/v1/plans/${planId}/rsvps`, { body: { state } });
      setViewerRsvp(res.state);
      setNotice(
        res.state === "waitlisted"
          ? "This plan is full — you're on the waitlist."
          : `You're marked as ${res.state}.`,
      );
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update your RSVP");
    } finally {
      setBusy(false);
    }
  }

  const byState = (state: string) => detail?.rsvps.filter((r) => r.state === state) ?? [];
  const going = [...byState("going"), ...byState("checked_in")];
  const waitlisted = byState("waitlisted");
  const interested = byState("interested");

  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!detail) return;
    let cancelled = false;
    api<{ members: Array<{ id: string; handle: string }> }>(`/v1/circles/${detail.plan.circleId}`)
      .then((c) => {
        if (cancelled) return;
        setNames(Object.fromEntries(c.members.map((m) => [m.id, m.handle])));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [detail]);

  const label = (userId: string) => `@${names[userId] ?? userId.slice(0, 6)}`;

  return (
    <div>
      <button className="btn ghost" onClick={onBack} style={{ paddingLeft: 0, marginBottom: "var(--space-3)" }}>
        <ArrowLeftIcon width={18} height={18} /> Back
      </button>

      {error && <div className="notice danger">{error}</div>}
      {notice && <div className="notice success">{notice}</div>}
      {!detail && !error && <div className="skeleton" aria-busy="true" />}

      {detail && (
        <>
          <div className="card" style={{ marginBottom: "var(--space-3)" }}>
            <div className="row spread" style={{ alignItems: "flex-start", marginBottom: "var(--space-3)" }}>
              <h1 className="screen-title" style={{ margin: 0 }}>
                {detail.plan.title}
              </h1>
              <span className="status-chip">{detail.plan.state.replace(/_/g, " ")}</span>
            </div>
            <div className="stack">
              <div className="row" style={{ gap: "var(--space-2)" }}>
                <CalendarIcon width={16} height={16} style={{ color: "var(--violet-soft)" }} />
                <span>{formatWhen(detail.plan.startsAt, detail.plan.timezone)}</span>
              </div>
              {detail.plan.place && (
                <div className="row" style={{ gap: "var(--space-2)" }}>
                  <MapPinIcon width={16} height={16} style={{ color: "var(--violet-soft)" }} />
                  <span>{detail.plan.place}</span>
                </div>
              )}
              {detail.plan.participantLimit != null && (
                <div className="row" style={{ gap: "var(--space-2)" }}>
                  <UsersIcon width={16} height={16} style={{ color: "var(--violet-soft)" }} />
                  <span>
                    {going.length} of {detail.plan.participantLimit} spots filled
                  </span>
                </div>
              )}
              {detail.plan.budgetAmount != null && (
                <div className="row" style={{ gap: "var(--space-2)" }}>
                  <MoneyIcon width={16} height={16} style={{ color: "var(--violet-soft)" }} />
                  <span>
                    Estimated {formatMinorUnits(detail.plan.budgetAmount, detail.plan.budgetCurrency ?? "NGN")}{" "}
                    {detail.plan.budgetCurrency}
                  </span>
                </div>
              )}
            </div>
          </div>

          <h3 className="section-title" style={{ margin: "var(--space-4) 0 var(--space-3)" }}>
            Your RSVP
          </h3>
          <div className="pill-row">
            {RSVP_STATES.map((s) => (
              <button
                key={s.id}
                className="pill"
                aria-pressed={viewerRsvp === s.id}
                onClick={() => void rsvp(s.id)}
                disabled={busy}
              >
                {s.label}
              </button>
            ))}
          </div>
          {viewerRsvp === "waitlisted" && (
            <div className="notice warning">
              <ClockIcon width={16} height={16} /> You&rsquo;re on the waitlist. You&rsquo;ll move up if
              someone drops out.
            </div>
          )}

          <h3 className="section-title" style={{ margin: "var(--space-5) 0 var(--space-3)" }}>
            Who&rsquo;s coming
          </h3>
          <div className="card">
            <AttendanceGroup title="Going" people={going} label={label} />
            <AttendanceGroup title="Interested" people={interested} label={label} />
            <AttendanceGroup title="Waitlist" people={waitlisted} label={label} />
            {detail.rsvps.length === 0 && <p className="meta">No one has responded yet.</p>}
          </div>

          <p className="meta" style={{ marginTop: "var(--space-4)", display: "flex", gap: 6 }}>
            <TimerIcon width={13} height={13} /> A Vibe plan is not a reservation. Bookings are confirmed by the venue or provider.
          </p>
        </>
      )}
    </div>
  );
}

function AttendanceGroup({
  title,
  people,
  label,
}: {
  title: string;
  people: Array<{ userId: string; state: string }>;
  label: (userId: string) => string;
}) {
  if (people.length === 0) return null;
  return (
    <div style={{ marginBottom: "var(--space-3)" }}>
      <p className="eyebrow" style={{ marginBottom: "var(--space-2)" }}>
        {title} · {people.length}
      </p>
      <div className="row" style={{ flexWrap: "wrap", gap: "var(--space-2)" }}>
        {people.map((p) => (
          <span key={p.userId} className="audience-tag">
            <CheckIcon width={12} height={12} /> {label(p.userId)}
          </span>
        ))}
      </div>
    </div>
  );
}

function formatWhen(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone,
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString();
  }
}
