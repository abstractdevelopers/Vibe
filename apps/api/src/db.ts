import pg from "pg";

/**
 * Money columns are BIGINT minor units. Postgres returns int8 as a string by
 * default; every amount we store is a safe integer, so parse it back to a
 * number once here instead of sprinkling Number() conversions through the code.
 */
pg.types.setTypeParser(20, (value: string) => Number(value));

export function createPool(databaseUrl: string, maxConnections = 10): pg.Pool {
  // A bounded pool. On a single server the ceiling that matters is the
  // database's own `max_connections`; keep this comfortably below it and
  // reserve headroom for migrations and an operator session.
  return new pg.Pool({ connectionString: databaseUrl, max: maxConnections });
}

export type Db = pg.Pool | pg.PoolClient;

export async function withTransaction<T>(pool: pg.Pool, fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function queryOne<T extends pg.QueryResultRow>(
  db: Db,
  text: string,
  values: unknown[] = [],
): Promise<T | null> {
  const result = await db.query<T>(text, values);
  return result.rows[0] ?? null;
}

export async function queryMany<T extends pg.QueryResultRow>(
  db: Db,
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const result = await db.query<T>(text, values);
  return result.rows;
}
