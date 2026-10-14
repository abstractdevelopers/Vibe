import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { Me } from "../types";
import { EmptyState } from "../components/EmptyState";
import {
  CalendarIcon,
  ChevronRightIcon,
  CompassIcon,
  MapPinIcon,
  MoneyIcon,
  SearchIcon,
  StoreIcon,
} from "../components/Icons";
import { useNav } from "../nav";

interface DiscoveryResult {
  id: string;
  kind: "event" | "place";
  name: string;
  category?: string;
  city?: string | null;
  area?: string | null;
  description?: string | null;
  place?: string | null;
  startsAt?: string;
  state?: string;
  priceBand?: number | null;
  imageUrl?: string | null;
  isVerified?: boolean;
  isSample?: boolean;
  organizer?: { id: string; handle: string; displayName: string };
  goingCount?: number;
  score: number;
  reasons: string[];
}

const CATEGORIES = [
  { id: "", label: "Everything" },
  { id: "food", label: "Food" },
  { id: "nightlife", label: "Nightlife" },
  { id: "outdoors", label: "Outdoors" },
  { id: "culture", label: "Culture" },
  { id: "retail", label: "Shops" },
  { id: "media", label: "Media" },
];

export function ExploreScreen({ me }: { me: Me }) {
  const nav = useNav();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [kind, setKind] = useState<"all" | "event" | "place">("all");
  const [results, setResults] = useState<DiscoveryResult[] | null>(null);
  const [people, setPeople] = useState<Array<{ id: string; handle: string; displayName: string }>>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setResults(null);
    setError(null);
    const params = new URLSearchParams();
    if (query.trim()) params.set("q", query.trim());
    if (category) params.set("category", category);
    if (kind !== "all") params.set("kind", kind);
    try {
      const result = await api<{ results: DiscoveryResult[] }>(`/v1/explore?${params}`);
      setResults(result.results);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load Explore");
    }
    // People are a separate index; only meaningful once the query has substance.
    if (query.trim().length >= 2) {
      try {
        const found = await api<{ users: Array<{ id: string; handle: string; displayName: string }> }>(
          `/v1/search/users?q=${encodeURIComponent(query.trim())}`,
        );
        setPeople(found.users);
      } catch {
        setPeople([]);
      }
    } else {
      setPeople([]);
    }
  }, [query, category, kind]);

  // Debounce so typing does not fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => void load(), 250);
    return () => clearTimeout(timer);
  }, [load]);

  return (
    <div>
      <h1 className="screen-title">Explore</h1>

      <div className="row" style={{ gap: "var(--space-2)", marginBottom: "var(--space-3)" }}>
        <div className="grow" style={{ position: "relative" }}>
          <SearchIcon
            width={17}
            height={17}
            style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "var(--text-faint)" }}
          />
          <input
            aria-label="Search Vibe"
            placeholder="Search events, places, shops…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ marginBottom: 0, paddingLeft: 40 }}
          />
        </div>
      </div>

      <div className="pill-row" role="tablist" aria-label="Result type">
        <button className="pill" role="tab" aria-pressed={kind === "all"} onClick={() => setKind("all")}>
          All
        </button>
        <button className="pill" role="tab" aria-pressed={kind === "event"} onClick={() => setKind("event")}>
          Events
        </button>
        <button className="pill" role="tab" aria-pressed={kind === "place"} onClick={() => setKind("place")}>
          Places &amp; shops
        </button>
      </div>

      <div className="pill-row" role="tablist" aria-label="Categories">
        {CATEGORIES.map((c) => (
          <button
            key={c.id}
            className="pill"
            role="tab"
            aria-pressed={category === c.id}
            onClick={() => setCategory(c.id)}
          >
            {c.label}
          </button>
        ))}
      </div>

      {me.city || me.area ? (
        <p className="meta" style={{ marginBottom: "var(--space-3)" }}>
          <MapPinIcon width={13} height={13} style={{ verticalAlign: "-2px" }} /> Ranking for{" "}
          {[me.area, me.city].filter(Boolean).join(", ")}. Change it in You. Explore never reads your
          device location.
        </p>
      ) : (
        <p className="meta" style={{ marginBottom: "var(--space-3)" }}>
          <MapPinIcon width={13} height={13} style={{ verticalAlign: "-2px" }} /> Set your city and area in
          You to rank by where you are. Explore works without any location permission.
        </p>
      )}

      {error && <div className="notice danger">{error}</div>}

      {people.length > 0 && (
        <div style={{ marginBottom: "var(--space-4)" }}>
          <p className="eyebrow">People</p>
          <div className="stack">
            {people.map((person) => (
              <button
                key={person.id}
                className="row"
                style={{
                  gap: "var(--space-3)",
                  width: "100%",
                  textAlign: "left",
                  padding: "var(--space-2) 0",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                }}
                onClick={() => nav.push({ name: "profile", userId: person.id })}
              >
                <span className="avatar sm" aria-hidden="true">
                  {person.displayName.slice(0, 1).toUpperCase()}
                </span>
                <span className="grow">
                  <span style={{ display: "block", fontWeight: 600 }}>{person.displayName}</span>
                  <span className="meta">@{person.handle}</span>
                </span>
                <ChevronRightIcon width={16} height={16} style={{ color: "var(--text-faint)" }} />
              </button>
            ))}
          </div>
        </div>
      )}

      {results === null && (
        <div aria-busy="true">
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      )}

      {results?.length === 0 && (
        <EmptyState
          icon={<CompassIcon />}
          title="Nothing matches yet"
          text="Try a different word or category. Discovery covers events, places and shops by area."
          action={
            <button
              className="btn"
              onClick={() => {
                setQuery("");
                setCategory("");
                setKind("all");
              }}
            >
              Clear filters
            </button>
          }
        />
      )}

      <div className="stack">
        {results?.map((r) =>
          r.kind === "event" ? (
            <EventCard key={r.id} result={r} onOpen={() => nav.push({ name: "plan", planId: r.id })} />
          ) : (
            <PlaceCard key={r.id} result={r} onOpen={() => nav.push({ name: "place", placeId: r.id })} />
          ),
        )}
      </div>
    </div>
  );
}

function ReasonChips({ reasons }: { reasons: string[] }) {
  if (reasons.length === 0) return null;
  return (
    <div className="row" style={{ flexWrap: "wrap", gap: "var(--space-1)", marginTop: "var(--space-2)" }}>
      {reasons.map((reason) => (
        <span key={reason} className="audience-tag">
          {reason}
        </span>
      ))}
    </div>
  );
}

function EventCard({ result, onOpen }: { result: DiscoveryResult; onOpen: () => void }) {
  return (
    <button className="card interactive" style={{ display: "block", width: "100%", textAlign: "left" }} onClick={onOpen}>
      <div className="row spread" style={{ alignItems: "flex-start" }}>
        <span className="row" style={{ gap: "var(--space-2)" }}>
          <CalendarIcon width={16} height={16} style={{ color: "var(--violet-soft)" }} />
          <span className="eyebrow">Event</span>
        </span>
        {result.goingCount ? <span className="meta">{result.goingCount} going</span> : null}
      </div>
      <h3 style={{ margin: "var(--space-2) 0" }}>{result.name}</h3>
      <div className="row" style={{ gap: "var(--space-3)", flexWrap: "wrap" }}>
        {result.startsAt && <span className="meta">{formatWhen(result.startsAt)}</span>}
        {(result.area || result.city) && (
          <span className="meta">
            <MapPinIcon width={12} height={12} style={{ verticalAlign: "-2px" }} />{" "}
            {[result.area, result.city].filter(Boolean).join(", ")}
          </span>
        )}
        {result.organizer && <span className="meta">by @{result.organizer.handle}</span>}
      </div>
      <ReasonChips reasons={result.reasons} />
    </button>
  );
}

function PlaceCard({ result, onOpen }: { result: DiscoveryResult; onOpen: () => void }) {
  return (
    <button className="card interactive" style={{ display: "block", width: "100%", textAlign: "left" }} onClick={onOpen}>
      <div className="row spread" style={{ alignItems: "flex-start" }}>
        <span className="row" style={{ gap: "var(--space-2)" }}>
          <StoreIcon width={16} height={16} style={{ color: "var(--violet-soft)" }} />
          <span className="eyebrow">{result.category}</span>
        </span>
        {result.isSample && <span className="audience-tag">Sample listing</span>}
      </div>
      <h3 style={{ margin: "var(--space-2) 0" }}>{result.name}</h3>
      {result.description && <p className="muted" style={{ margin: "0 0 var(--space-2)" }}>{result.description}</p>}
      <div className="row" style={{ gap: "var(--space-3)", flexWrap: "wrap" }}>
        {(result.area || result.city) && (
          <span className="meta">
            <MapPinIcon width={12} height={12} style={{ verticalAlign: "-2px" }} />{" "}
            {[result.area, result.city].filter(Boolean).join(", ")}
          </span>
        )}
        {result.priceBand != null && (
          <span className="meta" aria-label={`Price band ${result.priceBand} of 4`}>
            <MoneyIcon width={12} height={12} style={{ verticalAlign: "-2px" }} />{" "}
            {"₦".repeat(result.priceBand)}
          </span>
        )}
      </div>
      <ReasonChips reasons={result.reasons} />
    </button>
  );
}

function formatWhen(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  } catch {
    return iso;
  }
}
