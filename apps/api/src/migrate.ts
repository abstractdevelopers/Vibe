import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "migrations");

async function run(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL);
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const sql = await readFile(join(migrationsDir, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = await client.query<{ checksum: string }>(
        "SELECT checksum FROM schema_migrations WHERE name = $1",
        [file],
      );
      if (existing.rows.length > 0) {
        if (existing.rows[0]!.checksum !== checksum) {
          throw new Error(
            `Migration ${file} was already applied but its contents changed. ` +
              "Add a new migration instead of editing an applied one.",
          );
        }
        console.log(`skip   ${file}`);
        continue;
      }
      console.log(`apply  ${file}`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [
          file,
          checksum,
        ]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    console.log("migrations complete");
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
