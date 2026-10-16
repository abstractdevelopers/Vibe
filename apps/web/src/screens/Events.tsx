import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { ArrowLeftIcon, CalendarIcon, MapPinIcon, TicketIcon, CheckIcon, QrIcon, LockIcon } from "../components/Icons";
import { EmptyState } from "../components/EmptyState";
import { ScreenHeader } from "../components/ScreenHeader";

interface EventSummary {
  id: string;
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string | null;
  timezone: string;
  place: string | null;
  city: string | null;
  area: string | null;
  priceMinor: number;
  currency: string;
  state: string;
  booking: { verified: boolean; provider: string | null; reference: string | null };
  organizer: { id: string; displayName: string; handle: string };
}

function when(iso: string, tz: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: tz });
  } catch {
    return new Date(iso).toLocaleString();
  }
}

export function EventsScreen({ onBack }: { onBack: () => void }) {
  const [events, setEvents] = useState<EventSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await api<{ events: EventSummary[] }>("/v1/events");
        setEvents(res.events);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Could not load events");
      }
    })();
  }, []);

  return (
    <div>
      <button className="btn ghost" onClick={onBack} style={{ paddingLeft: 0, marginBottom: "var(--space-3)" }}>
        <ArrowLeftIcon width={18} height={18} /> Back
      </button>
      <ScreenHeader
        eyebrow="Gather"
        title="Events"
        subtitle="A Vibe event is not a reservation or a ticket. Ticketing stays with the provider or merchant."
      />

      {error && <div className="notice danger">{error}</div>}
      {events === null && !error && <div className="skeleton" aria-busy="true" />}
      {events?.length === 0 && (
        <EmptyState icon={<CalendarIcon />} title="No events yet" text="When people publish events they appear here." />
      )}
      <div className="stack">
        {events?.map((e) => (
          <EventCard key={e.id} event={e} />
        ))}
      </div>
    </div>
  );
}

function EventCard({ event }: { event: EventSummary }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card">
      <button
        className="grow"
        onClick={() => setOpen((v) => !v)}
        style={{ background: "none", border: "none", textAlign: "left", cursor: "pointer", padding: 0, width: "100%" }}
        aria-expanded={open}
      >
        <div className="row spread">
          <strong>{event.title}</strong>
          <span className="audience-tag">{event.state}</span>
        </div>
        <div className="meta row" style={{ gap: "var(--space-2)", flexWrap: "wrap", marginTop: "var(--space-1)" }}>
          <span className="row" style={{ gap: 4 }}>
            <CalendarIcon width={14} height={14} /> {when(event.startsAt, event.timezone)}
          </span>
          {(event.place || event.city) && (
            <span className="row" style={{ gap: 4 }}>
              <MapPinIcon width={14} height={14} /> {[event.place, event.area, event.city].filter(Boolean).join(", ")}
            </span>
          )}
        </div>
        <div className="meta" style={{ marginTop: "var(--space-1)" }}>
          {event.priceMinor === 0 ? "Free entry" : `${(event.priceMinor / 100).toLocaleString()} ${event.currency}`} ·{" "}
          {/* Booking is only ever shown as verified when a provider backs it. */}
          {event.booking.verified ? (
            <span className="row" style={{ gap: 4, display: "inline-flex" }}>
              <TicketIcon width={14} height={14} /> Booking verified
            </span>
          ) : (
            "No verified booking"
          )}
        </div>
      </button>
      {open && <EventDetail eventId={event.id} />}
    </div>
  );
}

function EventDetail({ eventId }: { eventId: string }) {
  const [detail, setDetail] = useState<(EventSummary & { checkinCount: number }) | null>(null);
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setDetail(await api<EventSummary & { checkinCount: number }>(`/v1/events/${eventId}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load the event");
    }
  }, [eventId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function checkIn(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await api<{ checkedIn: boolean; alreadyCheckedIn: boolean }>(`/v1/events/${eventId}/checkin`, {
        body: { code },
      });
      setMessage(res.alreadyCheckedIn ? "You are already checked in." : "Checked in. See you there!");
      setCode("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not check in");
    } finally {
      setBusy(false);
    }
  }

  async function issueCode() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ code: string }>(`/v1/events/${eventId}/checkin-codes`, { body: { ttlMinutes: 180, maxUses: 50 } });
      setIssued(res.code);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not issue a check-in code");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: "var(--space-3)" }}>
      {detail?.description && <p>{detail.description}</p>}
      <p className="meta">
        {detail ? detail.checkinCount : 0} checked in · Organizer {detail?.organizer.displayName}
      </p>

      {message && <div className="notice success">{message}</div>}
      {error && <div className="notice danger">{error}</div>}

      <form onSubmit={checkIn} className="row" style={{ gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
        <input
          className="input"
          placeholder="Enter check-in code"
          aria-label="Check-in code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <button className="btn primary" type="submit" disabled={busy || !code}>
          <CheckIcon width={16} height={16} /> Check in
        </button>
      </form>

      <div style={{ marginTop: "var(--space-3)" }}>
        <button className="btn ghost" onClick={() => void issueCode()} disabled={busy}>
          <QrIcon width={16} height={16} /> Issue a check-in code (organizer)
        </button>
        {issued && (
          <div className="card" style={{ marginTop: "var(--space-2)" }}>
            <div className="meta">Share this code. It is single-use by default and can be revoked.</div>
            <div style={{ fontFamily: "monospace", fontSize: 18, wordBreak: "break-all" }}>{issued}</div>
          </div>
        )}
      </div>
      <p className="meta row" style={{ gap: 4, marginTop: "var(--space-2)" }}>
        <LockIcon width={14} height={14} /> The code is validated on the server and carries no personal data.
      </p>
    </div>
  );
}
