import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, resetDb, registerUser, auth, type Harness, type TestUser } from "./helpers.js";

/**
 * Auth hardening: password reset, the email outbox, and rate limiting.
 *
 * The point of these tests is the failure modes, not the happy path alone:
 * a reset link must not work twice, must not survive a password change, must
 * not reveal whether an email exists, and a reset must kill stolen sessions.
 */
let h: Harness;
let user: TestUser;

beforeAll(async () => {
  h = await createHarness();
  await resetDb(h.pool);
  user = await registerUser(h.app, "resetter");
});
afterAll(async () => h.close());

/** Pull the most recent reset token out of the outbox by reading the link. */
async function latestResetToken(): Promise<string | null> {
  const { rows } = await h.pool.query<{ body: string }>(
    `SELECT body FROM email_outbox ORDER BY created_at DESC LIMIT 1`,
  );
  const match = /token=([A-Za-z0-9_-]+)/.exec(rows[0]?.body ?? "");
  return match?.[1] ?? null;
}

describe("password reset", () => {
  it("accepts a request and queues exactly one email", async () => {
    const res = await h.app.inject({
      method: "POST", url: "/v1/auth/forgot", payload: { email: "resetter@example.com" },
    });
    expect(res.statusCode).toBe(202);
    const { rows } = await h.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM email_outbox WHERE to_email = 'resetter@example.com'`,
    );
    expect(rows[0]?.count).toBe("1");
  });

  it("gives the same response for an unknown email, so accounts cannot be enumerated", async () => {
    const known = await h.app.inject({ method: "POST", url: "/v1/auth/forgot", payload: { email: "resetter@example.com" } });
    const unknown = await h.app.inject({ method: "POST", url: "/v1/auth/forgot", payload: { email: "nobody@example.com" } });
    expect(unknown.statusCode).toBe(known.statusCode);
    expect(unknown.body).toBe(known.body);
  });

  it("stores only a hash of the token, never the token itself", async () => {
    const token = await latestResetToken();
    expect(token).toBeTruthy();
    const { rows } = await h.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM password_resets WHERE token_hash = $1`,
      [token],
    );
    // The raw token must not appear in the table.
    expect(rows[0]?.count).toBe("0");
  });

  it("changes the password, and the new password works", async () => {
    const token = await latestResetToken();
    const res = await h.app.inject({
      method: "POST", url: "/v1/auth/reset", payload: { token, password: "brand-new-password" },
    });
    expect(res.statusCode).toBe(204);
    const login = await h.app.inject({
      method: "POST", url: "/v1/auth/login",
      payload: { email: "resetter@example.com", password: "brand-new-password" },
    });
    expect(login.statusCode).toBe(200);
  });

  it("revokes existing sessions on reset, so a stolen token stops working", async () => {
    const victim = await registerUser(h.app, "sessionvictim");
    // The victim has a live session.
    const before = await h.app.inject({ method: "GET", url: "/v1/me", headers: auth(victim.token) });
    expect(before.statusCode).toBe(200);

    await h.app.inject({ method: "POST", url: "/v1/auth/forgot", payload: { email: "sessionvictim@example.com" } });
    const token = await latestResetToken();
    await h.app.inject({ method: "POST", url: "/v1/auth/reset", payload: { token, password: "another-password" } });

    const after = await h.app.inject({ method: "GET", url: "/v1/me", headers: auth(victim.token) });
    expect(after.statusCode).toBe(401);
  });

  it("refuses to reuse a reset token", async () => {
    // Make a fresh reset for this test, so it does not depend on an earlier
    // test's state (an earlier test deliberately expires every pending token).
    await h.app.inject({ method: "POST", url: "/v1/auth/forgot", payload: { email: "resetter@example.com" } });
    const token = await latestResetToken();
    const first = await h.app.inject({ method: "POST", url: "/v1/auth/reset", payload: { token, password: "one-password-here" } });
    expect(first.statusCode).toBe(204);
    const second = await h.app.inject({ method: "POST", url: "/v1/auth/reset", payload: { token, password: "two-password-here" } });
    expect(second.statusCode).toBe(400);
  });

  it("refuses an expired token", async () => {
    await h.app.inject({ method: "POST", url: "/v1/auth/forgot", payload: { email: "resetter@example.com" } });
    const token = await latestResetToken();
    await h.pool.query(`UPDATE password_resets SET expires_at = now() - interval '1 minute' WHERE used_at IS NULL`);
    const res = await h.app.inject({ method: "POST", url: "/v1/auth/reset", payload: { token, password: "late-password-xx" } });
    expect(res.statusCode).toBe(400);
  });

  it("refuses a made-up token", async () => {
    const res = await h.app.inject({
      method: "POST", url: "/v1/auth/reset", payload: { token: "not-a-real-token-value", password: "whatever-123" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("rate limiting", () => {
  it("blocks a login spray after the limit", async () => {
    await resetDb(h.pool);
    await registerUser(h.app, "target");
    let blocked = 0;
    for (let i = 0; i < 12; i++) {
      const res = await h.app.inject({
        method: "POST", url: "/v1/auth/login",
        payload: { email: "target@example.com", password: "wrong-password" },
        remoteAddress: "203.0.113.9",
      });
      if (res.statusCode === 429) blocked++;
    }
    expect(blocked).toBeGreaterThan(0);
  });

  it("does not lock out a correct password after earlier typos", async () => {
    await resetDb(h.pool);
    const u = await registerUser(h.app, "typoer");
    for (let i = 0; i < 3; i++) {
      await h.app.inject({
        method: "POST", url: "/v1/auth/login",
        payload: { email: "typoer@example.com", password: "nope-nope-nope" },
        remoteAddress: "203.0.113.10",
      });
    }
    const ok = await h.app.inject({
      method: "POST", url: "/v1/auth/login",
      payload: { email: "typoer@example.com", password: "password123" },
      remoteAddress: "203.0.113.10",
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().token).toBeTruthy();
    expect(u.token).toBeTruthy();
  });

  it("limits signup bursts from one address", async () => {
    await resetDb(h.pool);
    let blocked = 0;
    for (let i = 0; i < 14; i++) {
      const res = await h.app.inject({
        method: "POST", url: "/v1/auth/register",
        payload: { email: `burst${i}@example.com`, handle: `burst${i}`, displayName: `B${i}`, password: "password123" },
        remoteAddress: "198.51.100.7",
      });
      if (res.statusCode === 429) blocked++;
    }
    expect(blocked).toBeGreaterThan(0);
  });
});
