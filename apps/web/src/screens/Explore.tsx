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
  const [posts, setPosts] = useState<Array<{ id: string; body: string | null; author: { id: string; displayName: string; handle: string } }>>([]);
  const [shops, setShops] = useState<Array<{ id: string; name: string; category: string | null }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [locatedNote, setLocatedNote] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await api<{ merchants: Array<{ id: string; name: string; category: string | null }> }>("/v1/merchants");
        setShops(res.merchants);
      } catch {
        setShops([]);
      }
    })();
  }, []);


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
    // People and posts are separate indexes; only meaningful once the query
    // has substance.
    if (query.trim().length >= 2) {
      try {
        const found = await api<{ users: Array<{ id: string; handle: string; displayName: string }> }>(
          `/v1/search/users?q=${encodeURIComponent(query.trim())}`,
        );
        setPeople(found.users);
      } catch {
        setPeople([]);
      }
      try {
        const found = await api<{ items: Array<{ id: string; body: string | null; author: { id: string; displayName: string; handle: string } }> }>(
          `/v1/search/posts?q=${encodeURIComponent(query.trim())}`,
        );
        setPosts(found.items);
      } catch {
        setPosts([]);
      }
    } else {
      setPeople([]);
      setPosts([]);
    }
  }, [query, category, kind]);

  // Ask the device for a position, send it, and let the server round it. The
  // browser prompt is the consent; nothing is read without it.
  const useMyLocation = useCallback(async () => {
    if (!("geolocation" in navigator)) {
      setLocatedNote("This device has no location support.");
      return;
    }
    setLocating(true);
    setLocatedNote(null);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          await api("/v1/me/location", {
            body: { lat: pos.coords.latitude, lng: pos.coords.longitude },
          });
          setLocatedNote("Ranking by your area (~1 km). Vibe only keeps a rounded spot, never your exact location.");
          await load();
        } catch (e) {
          setLocatedNote(e instanceof ApiError ? e.message : "Could not use your location.");
        } finally {
          setLocating(false);
        }
      },
      () => {
        setLocatedNote("Location permission denied. Explore still works from your saved city.");
        setLocating(false);
      },
      { enableHighAccuracy: false, maximumAge: 600000, timeout: 10000 },
    );
  }, [load]);

  // Debounce so typing does not fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => void load(), 250);
    return () => clearTimeout(timer);
  }, [load]);

  return (
    <div>
      <h1 className="screen-title">Explore</h1>

      {/* Live is the loudest thing on Explore: a room happening now is the
          fastest way into a real-world experience. */}
      <button className="card live-cta" onClick={() => nav.push({ name: "live" })}>
        <span className="row" style={{ gap: "var(--space-2)" }}>
          <span className="live-dot" aria-hidden />
          <strong>Live now</strong>
        </span>
        <span className="meta">Voice rooms, listening parties, watch parties and match rooms.</span>
        <ChevronRightIcon width={18} height={18} />
      </button>

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

      <div className="row" style={{ gap: "var(--space-2)", marginBottom: "var(--space-3)", flexWrap: "wrap" }}>
        <button className="btn small ghost" onClick={useMyLocation} disabled={locating}>
          <MapPinIcon width={14} height={14} /> {locating ? "Locating…" : "Use my location"}
        </button>
        <span className="meta">
          {[me.area, me.city].filter(Boolean).join(", ")
            ? `Ranking for ${[me.area, me.city].filter(Boolean).join(", ")}`
            : "Add a city in You, or share a rounded position"}
        </span>
      </div>
      {locatedNote && <p className="meta" style={{ marginBottom: "var(--space-3)" }}>{locatedNote}</p>}

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

      {posts.length > 0 && (
        <div style={{ marginBottom: "var(--space-4)" }}>
          <p className="eyebrow">Posts</p>
          <div className="stack">
            {posts.map((post) => (
              <button
                key={post.id}
                className="card"
                style={{ width: "100%", textAlign: "left", cursor: "pointer" }}
                onClick={() => nav.push({ name: "profile", userId: post.author.id })}
              >
                <span className="meta">@{post.author.handle}</span>
                <p style={{ margin: "var(--space-1) 0 0" }}>{post.body}</p>
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

      <h2 className="section-title" style={{ marginTop: "var(--space-5)" }}>Shops</h2>
      {shops === null && <div className="skeleton" aria-busy="true" />}
      {shops?.length === 0 && <p className="meta">No verified shops yet.</p>}
      <div className="stack">
        {shops?.map((s) => (
          <button key={s.id} className="card row spread" onClick={() => nav.push({ name: "store", merchantId: s.id })}>
            <span>
              <strong>{s.name}</strong>
              {s.category && <div className="meta">{s.category}</div>}
            </span>
            <span className="audience-tag"><StoreIcon width={12} height={12} /> Verified</span>
          </button>
        ))}
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
