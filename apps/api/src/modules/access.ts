import type { CircleRole } from "@vibe/shared";
import type { Db } from "../db.js";
import { ApiError } from "../errors.js";
import { queryOne } from "../db.js";

const RANK: Record<CircleRole, number> = { member: 0, moderator: 1, admin: 2, owner: 3 };

export async function circleRoleFor(
  db: Db,
  circleId: string,
  userId: string,
): Promise<CircleRole | null> {
  const row = await queryOne<{ role: CircleRole }>(
    db,
    "SELECT role FROM circle_members WHERE circle_id = $1 AND user_id = $2",
    [circleId, userId],
  );
  return row?.role ?? null;
}

/** Every Circle-scoped route goes through this: never trust client filtering. */
export async function requireCircleMember(
  db: Db,
  circleId: string,
  userId: string,
): Promise<CircleRole> {
  const role = await circleRoleFor(db, circleId, userId);
  if (!role) throw ApiError.forbidden("You are not a member of this Circle");
  return role;
}

export function atLeast(role: CircleRole, minimum: CircleRole): boolean {
  return RANK[role] >= RANK[minimum];
}

export async function requireCircleRole(
  db: Db,
  circleId: string,
  userId: string,
  minimum: CircleRole,
): Promise<CircleRole> {
  const role = await requireCircleMember(db, circleId, userId);
  if (!atLeast(role, minimum)) {
    throw ApiError.forbidden(`This action requires the ${minimum} role or higher`);
  }
  return role;
}

/** IDs of every Circle the user belongs to, for realtime subscription scoping. */
export async function circleIdsFor(db: Db, userId: string): Promise<string[]> {
  const result = await db.query<{ circle_id: string }>(
    "SELECT circle_id FROM circle_members WHERE user_id = $1",
    [userId],
  );
  return result.rows.map((row) => row.circle_id);
}
