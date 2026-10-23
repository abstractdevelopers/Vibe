import type { FastifyInstance } from "fastify";
import { requireUser, type AppContext } from "../http.js";

/**
 * The wider catalogue.
 *
 * Vibe does not build every game. The arcade section is fed by a public games
 * catalogue, so the shelf can be broad without us shipping an engine (or a
 * licence) for each title. Two rules keep that honest:
 *
 *  1. An external game is never presented as playable here. It links out to the
 *     publisher, and the card says so. Our own titles keep the "Playable" badge
 *     and stay on the server-authoritative table.
 *  2. A third-party API is a dependency that can be slow or down, so it is
 *     fetched on the server, cached, timeboxed, and backed by a static list. A
 *     catalogue outage degrades the shelf; it never breaks Play.
 *
 * Nothing is proxied from the client and no key is involved: the upstream is a
 * public, read-only endpoint.
 */

const UPSTREAM = "https://www.freetogame.com/api/games";
const CACHE_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 3500;
const MAX_ITEMS = 60;

export interface ExternalGame {
  id: string;
  name: string;
  blurb: string;
  genre: string;
  platform: string;
  thumbnail: string | null;
  url: string;
  publisher: string | null;
  releaseDate: string | null;
}

interface UpstreamRow {
  id?: number;
  title?: string;
  short_description?: string;
  genre?: string;
  platform?: string;
  thumbnail?: string;
  game_url?: string;
  publisher?: string;
  release_date?: string;
}

/**
 * A tiny static shelf used only when the upstream cannot be reached. It is
 * deliberately short and obviously generic — it is a placeholder for a failed
 * fetch, not a pretend catalogue.
 */
const FALLBACK: ExternalGame[] = [
  {
    id: "fallback-strategy",
    name: "Strategy classics",
    blurb: "Browser strategy games, from the publisher's own site.",
    genre: "Strategy",
    platform: "Web",
    thumbnail: null,
    url: "https://www.freetogame.com/genre/strategy",
    publisher: null,
    releaseDate: null,
  },
  {
    id: "fallback-shooter",
    name: "Shooters",
    blurb: "Free-to-play shooters, browsed on the source catalogue.",
    genre: "Shooter",
    platform: "Web",
    thumbnail: null,
    url: "https://www.freetogame.com/genre/shooter",
    publisher: null,
    releaseDate: null,
  },
  {
    id: "fallback-mmo",
    name: "MMO worlds",
    blurb: "Persistent worlds and the people in them.",
    genre: "MMO",
    platform: "Web",
    thumbnail: null,
    url: "https://www.freetogame.com/genre/mmo",
    publisher: null,
    releaseDate: null,
  },
];

let cache: { at: number; items: ExternalGame[]; degraded: boolean } | null = null;
let inFlight: Promise<{ items: ExternalGame[]; degraded: boolean }> | null = null;

/** Normalise one upstream row. Anything malformed is dropped, not rendered. */
function toGame(row: UpstreamRow): ExternalGame | null {
  if (!row || !row.title || !row.game_url) return null;
  // Only http(s) links, so a hostile payload cannot introduce javascript:.
  if (!/^https?:\/\//i.test(row.game_url)) return null;
  const thumb = typeof row.thumbnail === "string" && /^https?:\/\//i.test(row.thumbnail) ? row.thumbnail : null;
  return {
    id: row.id !== undefined ? `fg-${row.id}` : `fg-${row.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    name: String(row.title).slice(0, 120),
    blurb: String(row.short_description ?? "").slice(0, 240),
    genre: String(row.genre ?? "Other").slice(0, 40),
    platform: String(row.platform ?? "Web").slice(0, 40),
    thumbnail: thumb,
    url: row.game_url,
    publisher: row.publisher ? String(row.publisher).slice(0, 80) : null,
    releaseDate: row.release_date ? String(row.release_date).slice(0, 20) : null,
  };
}

async function fetchCatalogue(): Promise<{ items: ExternalGame[]; degraded: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(UPSTREAM, {
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": "vibe-catalogue/1.0" },
    });
    if (!res.ok) return { items: FALLBACK, degraded: true };
    const rows = (await res.json()) as UpstreamRow[];
    if (!Array.isArray(rows)) return { items: FALLBACK, degraded: true };
    const items = rows.slice(0, MAX_ITEMS).map(toGame).filter((g): g is ExternalGame => g !== null);
    if (items.length === 0) return { items: FALLBACK, degraded: true };
    return { items, degraded: false };
  } catch {
    return { items: FALLBACK, degraded: true };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The cached shelf. Concurrent callers share one request, so a shelf that is
 * opened by twenty people at once still makes one outbound call.
 */
export async function externalCatalogue(): Promise<{ items: ExternalGame[]; degraded: boolean; fetchedAt: string }> {
  if (cache && Date.now() - cache.at < CACHE_MS) {
    return { ...cache, fetchedAt: new Date(cache.at).toISOString() };
  }
  if (!inFlight) {
    inFlight = fetchCatalogue().finally(() => { inFlight = null; });
  }
  const result = await inFlight;
  cache = { at: Date.now(), ...result };
  return { ...cache, fetchedAt: new Date(cache.at).toISOString() };
}

export function gamesCatalogueRoutes(ctx: AppContext) {
  return async function register(app: FastifyInstance): Promise<void> {
    // The shelf, merged with what is playable here. One call gives the Play
    // screen everything it needs: our tables, and the rest of the world.
    app.get("/v1/games/catalogue", async (req) => {
      await requireUser(ctx, req);
      const [local, external] = await Promise.all([
        ctx.pool
          .query<{
            id: string; name: string; category: string; blurb: string;
            min_players: number; max_players: number; stake_enabled: boolean; availability: string;
          }>(
            `SELECT id, name, category, blurb, min_players, max_players, stake_enabled, availability
               FROM game_catalog ORDER BY sort_order`,
          )
          .then((r) => r.rows)
          .catch(() => []),
        externalCatalogue(),
      ]);
      return {
        local: local.map((g) => ({
          id: g.id,
          name: g.name,
          category: g.category,
          blurb: g.blurb,
          minPlayers: g.min_players,
          maxPlayers: g.max_players,
          stakeEnabled: g.stake_enabled,
          availability: g.availability,
        })),
        external: external.items,
        // The client shows a quiet note rather than an error when this is true.
        degraded: external.degraded,
        fetchedAt: external.fetchedAt,
        source: "freetogame",
      };
    });
  };
}
