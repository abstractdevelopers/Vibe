import type { FastifyInstance } from "fastify";
import { createPool } from "../src/db.js";
import { buildApp } from "../src/app.js";
import { RealtimeHub } from "../src/realtime.js";
import { createPaymentProvider, type PaymentProvider } from "../src/payments/provider.js";
import { LogMailer } from "../src/modules/mailer.js";
import { createPayoutProvider, type PayoutProvider } from "../src/payments/payouts.js";
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
  BACHS_API_KEY: undefined,
  BACHS_WEBHOOK_SECRET: undefined,
  BACHS_BASE_URL: "https://sandbox-api.bachs.io",
  PAYOUTS_PROVIDER: "disabled",
  // The wallet is exercised by its own test with the flag on; the default test
  // config keeps it off so the rest of the suite sees the feature absent.
  WALLET_ENABLED: false,
  PUBLIC_API_URL: "http://localhost:12000",
  PUBLIC_WEB_URL: "http://localhost:12001",
  EMAIL_API_KEY: undefined,
  EMAIL_FROM: "Vibe <no-reply@test.local>",
  EMAIL_BASE_URL: "https://api.resend.com",
  PGPOOL_MAX: 10,
  isProduction: false,
};

export interface Harness {
  app: FastifyInstance;
  pool: pg.Pool;
  close(): Promise<void>;
}

export async function createHarness(
  providerOverride?: PaymentProvider,
  payoutsOverride?: PayoutProvider,
): Promise<Harness> {
  const pool = createPool(testConfig.DATABASE_URL);
  const hub = new RealtimeHub();
  const provider = providerOverride ?? createPaymentProvider("stub", testConfig.PAYMENTS_WEBHOOK_SECRET);
  const payouts = payoutsOverride ?? createPayoutProvider(testConfig.PAYOUTS_PROVIDER);
  const app = await buildApp({ pool, config: testConfig, hub, provider, payouts, mailer: new LogMailer() });
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
             blocks, mutes, comments, reactions, circle_members, circle_invites,
             conversations, conversation_members, messages, post_gifts,
             post_revisions, comment_revisions, account_deletion_requests, analytics_events,
             order_items, order_events, orders, products, merchants, campaigns,
             ad_deliveries, ad_impressions, ad_clicks, ad_preferences,
             events, checkin_codes, checkins, vibe_passes, loyalty_redemptions,
             device_tokens, ai_suggestions,
             activity_rooms, room_members, room_posts, room_polls, room_poll_votes,
             activity_reminders, activity_links, room_moderation_actions, activity_link_visits,
             password_resets, email_outbox, rate_limit_counters,
             paid_gifts, gift_purchases, payouts, payout_events, payout_destinations,
             wallet_topups, wallet_transfers,
             game_sessions, game_players, game_moves,
             money_audit, ledger_entries, ledger_journals, ledger_accounts
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
