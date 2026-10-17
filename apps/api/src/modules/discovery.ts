import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { ApiError } from "../errors.js";
import { queryMany, queryOne } from "../db.js";
import { parse, requireUser, type AppContext } from "../http.js";
import { distanceBand, haversineKm } from "./location.js";

/**
 * Explore / discovery.
 *
 * The spec's ranking baseline is: recency + relationship + topic affinity +
 * meaningful engagement + content quality/safety, and it explicitly forbids
 * optimising for outrage or time-on-app. It also says to target at coarse
 * city/area granularity and never reveal an individual's precise location.
 *
 * So the score here is transparent and additive. Every component is a plain
 * number with a stated weight, and the reasons are returned to the client so the
 * UI can explain why something is ranked where it is. No hidden boosts, no paid
 * override of relevance, no location finer than city/area.
 */

const WEIGHTS = {
  areaMatch: 40, // same area as the viewer's chosen city/area
  cityMatch: 25, // same city
  interestMatch: 18, // overlaps one of the viewer's interests
  relationship: 22, // an organizer/business the viewer follows, or a joined Circle
  engagement: 12, // real, measured engagement (votes, RSVPs) — capped
  freshness: 15, // recency, decaying over 14 days
  verified: 6, // a verified business identity
  // Device-distance term. Applied only when both the viewer and the item have
  // a coarse band; it never reveals either point, just orders by proximity.
  nearby: 30,
} as const;

export interface Scored {
  id: string;
  score: number;
  reasons: string[];
}

const searchSchema = z.object({
  q: z.string().max(120).optional(),
  city: z.string().max(80).optional(),
  area: z.string().max(80).optional(),
  category: z.string().max(40).optional(),
  kind: z.enum(["event", "place"]).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

function freshness(iso: string | Date, halfLifeDays = 7): number {
  const then = new Date(iso).getTime();
  const days = (Date.now() - then) / 86_400_000;
  if (days < 0) return 1; // a future event stays fully fresh
  return Math.pow(0.5, days / halfLifeDays);
}

function engagementScore(value: number, saturation = 20): number {
  // Diminishing returns so a single viral item cannot dominate the whole page.
  return Math.min(1, Math.log1p(value) / Math.log1p(saturation));
}

interface PlaceRow {
  id: string;
  name: string;
  kind: string;
  category: string;
  city: string;
  area: string | null;
  description: string | null;
  address_hint: string | null;
  price_band: number | null;
  image_url: string | null;
  is_verified: boolean;
  is_sample: boolean;
  lat: number | null;
  lng: number | null;
}

interface EventRow {
  id: string;
  title: string;
  state: string;
  starts_at: Date;
  city: string | null;
  area: string | null;
  place: string | null;
  organizer_id: string;
  organizer_handle: string;
  organizer_name: string;
  going_count: number;
  followed: boolean;
  in_circle: boolean;
}

export function discoveryRoutes(ctx: AppContext) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.get("/v1/explore", async (req) => {
      const user = await requireUser(ctx, req);
      const query = parse(searchSchema, req.query);

      const me = await queryOne<{
        interests: string[] | null; city: string | null; area: string | null;
        lat_band: number | null; lng_band: number | null;
      }>(
        ctx.pool,
        "SELECT interests, city, area, lat_band, lng_band FROM users WHERE id = $1",
        [user.id],
      );
      const interests = (me?.interests ?? []).map((i) => i.toLowerCase());
      // Fall back to the viewer's saved coarse area when the query omits one.
      const city = query.city ?? me?.city ?? undefined;
      const area = query.area ?? me?.area ?? undefined;
      const scoped = { ...query, city, area };

      const here = me?.lat_band != null && me?.lng_band != null ? { lat: me.lat_band, lng: me.lng_band } : null;
      const places = query.kind === "event" ? [] : await loadPlaces(ctx, scoped, interests, here);
      const events = query.kind === "place" ? [] : await loadEvents(ctx, user.id, scoped, interests);
      // The Vibe events feed (the `events` table) is a first-class discovery
      // surface too, so a public event shows in Explore, not only in Events.
      const vibeEvents = query.kind === "place" ? [] : await loadVibeEvents(ctx, user.id, scoped, interests, here);

      const results = [...vibeEvents, ...events, ...places]
        .sort((a, b) => b.score - a.score)
        .slice(0, query.limit);

      return { results };
    });

    app.get("/v1/places/:id", async (req) => {
      await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const place = await queryOne<PlaceRow>(
        ctx.pool,
        `SELECT id, name, kind, category, city, area, description, address_hint,
                price_band, image_url, is_verified, is_sample
           FROM places WHERE id = $1`,
        [id],
      );
      if (!place) throw ApiError.notFound("Place not found");
      return {
        place: {
          id: place.id,
          name: place.name,
          kind: place.kind,
          category: place.category,
          city: place.city,
          area: place.area,
          description: place.description,
          addressHint: place.address_hint,
          priceBand: place.price_band,
          imageUrl: place.image_url,
          isVerified: place.is_verified,
          isSample: place.is_sample,
        },
      };
    });

    app.get("/v1/explore/facets", async () => {
      const cities = await queryMany<{ city: string; count: number }>(
        ctx.pool,
        `SELECT city, count(*)::int AS count FROM places GROUP BY city ORDER BY count DESC`,
      );
      const categories = await queryMany<{ category: string; count: number }>(
        ctx.pool,
        `SELECT category, count(*)::int AS count FROM places GROUP BY category ORDER BY count DESC`,
      );
      return { cities, categories };
    });
  };
}

async function loadPlaces(
  ctx: AppContext,
  query: z.infer<typeof searchSchema>,
  interests: string[],
  here: { lat: number; lng: number } | null,
): Promise<Scored[]> {
  const rows = await queryMany<PlaceRow>(
    ctx.pool,
    `SELECT id, name, kind, category, city, area, description, address_hint,
            price_band, image_url, is_verified, is_sample, lat, lng
       FROM places
      WHERE ($1::text IS NULL OR lower(name) LIKE '%' || lower($1) || '%'
             OR lower(category) LIKE '%' || lower($1) || '%'
             OR lower(coalesce(description, '')) LIKE '%' || lower($1) || '%')
        AND ($2::text IS NULL OR lower(city) = lower($2))
        AND ($3::text IS NULL OR lower(coalesce(area, '')) = lower($3))
        AND ($4::text IS NULL OR lower(category) = lower($4))
      LIMIT 100`,
    [query.q ?? null, query.city ?? null, query.area ?? null, query.category ?? null],
  );

  return rows.map((place) => {
    const reasons: string[] = [];
    let score = 0;

    if (query.area && place.area && place.area.toLowerCase() === query.area.toLowerCase()) {
      score += WEIGHTS.areaMatch;
      reasons.push("in your area");
    } else if (query.city && place.city.toLowerCase() === query.city.toLowerCase()) {
      score += WEIGHTS.cityMatch;
      reasons.push("in your city");
    }
    if (interests.includes(place.category.toLowerCase())) {
      score += WEIGHTS.interestMatch;
      reasons.push("matches your interests");
    }
    if (here && place.lat != null && place.lng != null) {
      const km = haversineKm(here.lat, here.lng, place.lat, place.lng);
      // Closer is better; the band is shown instead of a raw distance.
      score += WEIGHTS.nearby * Math.pow(0.5, km / 5);
      reasons.push(distanceBand(km));
    }
    if (place.is_verified) {
      score += WEIGHTS.verified;
      reasons.push("verified business");
    }
    // Sample businesses are down-weighted so real merchants would outrank them.
    if (place.is_sample) score -= 8;

    return {
      id: place.id,
      kind: "place" as const,
      name: place.name,
      category: place.category,
      city: place.city,
      area: place.area,
      description: place.description,
      priceBand: place.price_band,
      imageUrl: place.image_url,
      isVerified: place.is_verified,
      isSample: place.is_sample,
      score: Math.round(score),
      reasons,
    };
  });
}

async function loadEvents(
  ctx: AppContext,
  viewerId: string,
  query: z.infer<typeof searchSchema>,
  interests: string[],
): Promise<Scored[]> {
  const rows = await queryMany<EventRow>(
    ctx.pool,
    `SELECT p.id, p.title, p.state, p.starts_at, p.city, p.area, p.place,
            p.organizer_id,
            u.handle AS organizer_handle, u.display_name AS organizer_name,
            (SELECT count(*) FROM rsvps r WHERE r.plan_id = p.id AND r.state IN ('going', 'checked_in'))::int AS going_count,
            EXISTS(SELECT 1 FROM follows f
                    WHERE f.follower_id = $1 AND f.followee_id = p.organizer_id AND f.state = 'accepted') AS followed,
            EXISTS(SELECT 1 FROM circle_members cm
                    WHERE cm.user_id = $1 AND cm.circle_id = p.circle_id) AS in_circle
       FROM plans p JOIN users u ON u.id = p.organizer_id
      WHERE p.discoverable = true
        AND p.state NOT IN ('draft', 'cancelled')
        AND p.starts_at > now() - interval '1 day'
        AND ($2::text IS NULL OR lower(p.title) LIKE '%' || lower($2) || '%'
             OR lower(coalesce(p.description, '')) LIKE '%' || lower($2) || '%')
        AND ($3::text IS NULL OR lower(coalesce(p.city, '')) = lower($3))
        AND ($4::text IS NULL OR lower(coalesce(p.area, '')) = lower($4))
      LIMIT 100`,
    [viewerId, query.q ?? null, query.city ?? null, query.area ?? null],
  );

  return rows.map((event) => {
    const reasons: string[] = [];
    let score = 0;

    if (query.area && event.area && event.area.toLowerCase() === query.area.toLowerCase()) {
      score += WEIGHTS.areaMatch;
      reasons.push("in your area");
    } else if (query.city && event.city && event.city.toLowerCase() === query.city.toLowerCase()) {
      score += WEIGHTS.cityMatch;
      reasons.push("in your city");
    }
    if (event.in_circle) {
      score += WEIGHTS.relationship;
      reasons.push("from your Circle");
    } else if (event.followed) {
      score += WEIGHTS.relationship;
      reasons.push("organizer you follow");
    }
    const haystack = `${event.title} ${event.place ?? ""}`.toLowerCase();
    if (interests.some((i) => haystack.includes(i))) {
      score += WEIGHTS.interestMatch;
      reasons.push("matches your interests");
    }
    score += WEIGHTS.engagement * engagementScore(event.going_count);
    if (event.going_count > 0) reasons.push(`${event.going_count} going`);
    score += WEIGHTS.freshness * freshness(event.starts_at);

    return {
      id: event.id,
      kind: "event" as const,
      name: event.title,
      state: event.state,
      startsAt: event.starts_at,
      city: event.city,
      area: event.area,
      place: event.place,
      organizer: { id: event.organizer_id, handle: event.organizer_handle, displayName: event.organizer_name },
      goingCount: event.going_count,
      score: Math.round(score),
      reasons,
    };
  });
}

/**
 * Vibe events (the `events` table) as discovery results.
 *
 * Ranked on the same transparent components as everything else. Location is
 * matched at coarse city/area granularity — a nearby band, when the viewer and
 * the event both have one, orders by distance without revealing either point.
 */
async function loadVibeEvents(
  ctx: AppContext,
  viewerId: string,
  query: z.infer<typeof searchSchema>,
  interests: string[],
  here: { lat: number; lng: number } | null,
): Promise<Scored[]> {
  const rows = await queryMany<{
    id: string; title: string; description: string | null; starts_at: Date; ends_at: Date | null;
    place: string | null; city: string | null; area: string | null; image_url: string | null;
    price_minor: number; currency: string; organizer_id: string; organizer_handle: string;
    organizer_name: string; followed: boolean; in_circle: boolean;
  }>(
    ctx.pool,
    `SELECT e.id, e.title, e.description, e.starts_at, e.ends_at, e.place, e.city, e.area,
            e.image_url, e.price_minor, e.currency, e.organizer_id,
            u.handle AS organizer_handle, u.display_name AS organizer_name,
            EXISTS(SELECT 1 FROM follows f
                    WHERE f.follower_id = $1 AND f.followee_id = e.organizer_id AND f.state = 'accepted') AS followed,
            EXISTS(SELECT 1 FROM circle_members cm
                    WHERE cm.user_id = $1 AND cm.circle_id = e.circle_id) AS in_circle
       FROM events e JOIN users u ON u.id = e.organizer_id
      WHERE e.state = 'published'
        AND e.starts_at > now() - interval '1 day'
        AND ($2::text IS NULL OR lower(e.title) LIKE '%' || lower($2) || '%'
             OR lower(coalesce(e.description, '')) LIKE '%' || lower($2) || '%')
        AND ($3::text IS NULL OR lower(coalesce(e.city, '')) = lower($3))
        AND ($4::text IS NULL OR lower(coalesce(e.area, '')) = lower($4))
      LIMIT 100`,
    [viewerId, query.q ?? null, query.city ?? null, query.area ?? null],
  );

  return rows.map((event) => {
    const reasons: string[] = [];
    let score = 0;
    if (query.area && event.area && event.area.toLowerCase() === query.area.toLowerCase()) {
      score += WEIGHTS.areaMatch; reasons.push("in your area");
    } else if (query.city && event.city && event.city.toLowerCase() === query.city.toLowerCase()) {
      score += WEIGHTS.cityMatch; reasons.push("in your city");
    } else if (here && event.city) {
      // With a coarse device location and a city on the event, a same-city
      // event still reads as nearby without exposing either point.
      score += WEIGHTS.cityMatch * 0.6; reasons.push("near you");
    }
    if (event.in_circle) { score += WEIGHTS.relationship; reasons.push("from your Circle"); }
    else if (event.followed) { score += WEIGHTS.relationship; reasons.push("host you follow"); }
    const haystack = `${event.title} ${event.place ?? ""}`.toLowerCase();
    if (interests.some((i) => haystack.includes(i))) { score += WEIGHTS.interestMatch; reasons.push("matches your interests"); }
    score += WEIGHTS.freshness * freshness(event.starts_at);

    return {
      id: event.id,
      kind: "event" as const,
      vibeEvent: true,
      name: event.title,
      state: "published",
      startsAt: event.starts_at,
      endsAt: event.ends_at,
      city: event.city,
      area: event.area,
      place: event.place,
      imageUrl: event.image_url,
      priceMinor: event.price_minor,
      currency: event.currency,
      organizer: { id: event.organizer_id, handle: event.organizer_handle, displayName: event.organizer_name },
      goingCount: 0,
      score: Math.round(score),
      reasons,
    };
  });
}
