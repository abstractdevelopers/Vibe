import type { FastifyInstance } from "fastify";
import { createPool } from "../src/db.js";
import { buildApp } from "../src/app.js";
import { RealtimeHub } from "../src/realtime.js";
import { createPaymentProvider } from "../src/payments/provider.js";
import type { Config } from "../src/config.js";
import type pg from "pg";

export const testConfig: Config = {
  NODE_ENV: "test",
  PORT: 0,
  CORS_ORIGIN: "*",
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://vibe:vibe@localhost:5432/vibe",
  REDIS_URL: undefined,
  SESSION_TTL_SECONDS: 3600,
  SESSION_SECRET: "test-session-secret-value",
  PAYMENTS_PROVIDER: "stub",
  PAYMENTS_WEBHOOK_SECRET: "test-webhook-secret",
  PUBLIC_API_URL: "http://localhost:12000",
  isProduction: false,
};

export interface Harness {
  app: FastifyInstance;
  pool: pg.Pool;
  close(): Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  const pool = createPool(testConfig.DATABASE_URL);
  const hub = new RealtimeHub();
  const provider = createPaymentProvider("stub", testConfig.PAYMENTS_WEBHOOK_SECRET);
  const app = await buildApp({ pool, config: testConfig, hub, provider });
  await app.ready();
  return {
    app,
    pool,
    async close() {
      await app.close();
      await pool.end();
    },
  };
}

/** Wipe all data between tests. Order-independent because of CASCADE. */
export async function resetDb(pool: pg.Pool): Promise<void> {
  await pool.query(`
    TRUNCATE users, circles, posts, activities, poll_options, votes, plans, rsvps,
             expenses, expense_participants, expense_events, payment_reports,
             provider_webhook_events, idempotency_keys, reports, moderation_cases,
             moderation_actions, audit_events, notifications, sessions, follows,
             blocks, mutes, comments, reactions, circle_members, circle_invites
    RESTART IDENTITY CASCADE
  `);
}

export interface TestUser {
  id: string;
  token: string;
  handle: string;
}

export async function registerUser(
  app: FastifyInstance,
  handle: string,
  email = `${handle}@example.com`,
): Promise<TestUser> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/register",
    payload: { email, handle, displayName: handle, password: "password123" },
  });
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.statusCode} ${res.body}`);
  const body = res.json();
  return { id: body.user.id, token: body.token, handle };
}

export function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}
