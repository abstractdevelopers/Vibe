/**
 * Grant or revoke operator (admin) access.
 *
 * There is no in-product way to become an operator: `users.is_admin` is only
 * ever read, never set, and no route writes it. Without this script the operator
 * console — merchant verification, campaign review, report handling, launch
 * seeding — is unreachable, and nothing can be approved.
 *
 * Run it against the deployed database, from inside the app container or a
 * machine that can reach it:
 *
 *   npm run operator -- --grant you@example.com
 *   npm run operator -- --revoke you@example.com
 *   npm run operator -- --list
 *
 * Deliberately a CLI, not an endpoint: an API route that grants admin is a
 * privilege-escalation surface. Whoever can run this already has database
 * access, which is the same authority.
 */
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const grant = args.includes("--grant");
  const revoke = args.includes("--revoke");
  const list = args.includes("--list");

  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL);
  try {
    if (list || (!grant && !revoke)) {
      const rows = await pool.query<{ email: string; handle: string; is_admin: boolean }>(
        "SELECT email, handle, is_admin FROM users WHERE deleted_at IS NULL ORDER BY created_at",
      );
      if (rows.rowCount === 0) {
        console.log("No users yet.");
        return;
      }
      for (const r of rows.rows) {
        console.log(`${r.is_admin ? "operator" : "member  "}  ${r.email}  (@${r.handle})`);
      }
      return;
    }

    const flagIndex = grant ? args.indexOf("--grant") : args.indexOf("--revoke");
    const email = args[flagIndex + 1];
    if (!email || email.startsWith("--")) {
      throw new Error(`Usage: --${grant ? "grant" : "revoke"} <email>`);
    }

    const result = await pool.query<{ id: string; handle: string }>(
      `UPDATE users SET is_admin = $2, updated_at = now()
        WHERE lower(email) = lower($1) AND deleted_at IS NULL
        RETURNING id, handle`,
      [email, grant],
    );
    if (result.rowCount === 0) {
      throw new Error(`No active user with email ${email}`);
    }
    const user = result.rows[0]!;
    // Operators are privileged; keep a record of who was made one and when.
    await pool.query(
      `INSERT INTO audit_events (actor_id, action, entity_type, entity_id, metadata)
       VALUES ($1, $2, 'user', $1, $3)`,
      [user.id, grant ? "operator.grant" : "operator.revoke", JSON.stringify({ email })],
    );
    console.log(`${grant ? "Granted" : "Revoked"} operator access for ${email} (@${user.handle}).`);
  } finally {
    await pool.end();
  }
}

run().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
