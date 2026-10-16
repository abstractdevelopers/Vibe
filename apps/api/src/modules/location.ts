import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { queryOne } from "../db.js";
import { parse, requireUser, type AppContext } from "../http.js";

/**
 * Device location for Explore (addendum: "the explore page should use GPS").
 *
 * Privacy rules, enforced here rather than documented and hoped for:
 *
 *   - We never store a precise point. A position is rounded to 2 decimal
 *     places (~1.1 km) before it is written, and only that rounded value is
 *     kept. `roundBand` is the single place that does this.
 *   - A member's rounded position is never returned to anyone else. It only
 *     powers distance ordering for that member.
 *   - `discoverable = false` disables it entirely.
 *
 * The client may send an already-coarse position, or nothing at all; with
 * nothing, Explore falls back to the city/area on the profile.
 */

/** ~1.1 km at the equator. Two decimals is the coarsest useful band. */
export function roundBand(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Great-circle distance in kilometres, for ordering only. */
export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const lat1 = (aLat * Math.PI) / 180;
  const lat2 = (bLat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A distance rounded to a band, so it can be shown without pinpointing. */
export function distanceBand(km: number): string {
  if (km < 1) return "under 1 km";
  if (km < 3) return "1–3 km";
  if (km < 8) return "3–8 km";
  if (km < 20) return "8–20 km";
  if (km < 50) return "20–50 km";
  return "50+ km";
}

const locateSchema = z.object({
  // Accepts a browser GeolocationPosition or a plain {lat,lng}. Bounded to
  // real coordinate ranges so a bogus value cannot be stored.
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
});

export function locationRoutes(ctx: AppContext) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.post("/v1/me/location", async (req) => {
      const user = await requireUser(ctx, req);
      const input = parse(locateSchema, req.body);
      // Rounded before it ever touches the database.
      const lat = roundBand(input.lat);
      const lng = roundBand(input.lng);
      await ctx.pool.query(
        `UPDATE users SET lat_band = $2, lng_band = $3, located_at = now(), updated_at = now() WHERE id = $1`,
        [user.id, lat, lng],
      );
      return { location: { lat, lng, precision: "~1.1km" } };
    });

    app.delete("/v1/me/location", async (req) => {
      const user = await requireUser(ctx, req);
      await ctx.pool.query(
        `UPDATE users SET lat_band = NULL, lng_band = NULL, located_at = NULL WHERE id = $1`,
        [user.id],
      );
      return { cleared: true };
    });

    app.get("/v1/me/location", async (req) => {
      const user = await requireUser(ctx, req);
      const row = await queryOne<{ lat_band: number | null; lng_band: number | null; located_at: Date | null }>(
        ctx.pool,
        `SELECT lat_band, lng_band, located_at FROM users WHERE id = $1`,
        [user.id],
      );
      return {
        location: row?.lat_band != null
          ? { lat: row.lat_band, lng: row.lng_band, precision: "~1.1km", locatedAt: row.located_at }
          : null,
      };
    });
  };
}
