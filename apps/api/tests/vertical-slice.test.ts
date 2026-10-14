import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { InjectOptions, LightMyRequestResponse } from "fastify";
import { createHarness, registerUser, resetDb, auth, type Harness } from "./helpers.js";

let h: Harness;

beforeEach(async () => {
  if (!h) h = await createHarness();
  await resetDb(h.pool);
});

afterAll(async () => {
  if (h) await h.close();
});

function inject(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  token: string,
  payload?: InjectOptions["payload"],
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  return h.app.inject({ method, url, payload, headers: { ...auth(token), ...headers } });
}

describe("vertical slice: circle -> invite -> poll -> plan -> expense", () => {
  it("runs the whole first-sprint journey end to end", async () => {
    const alice = await registerUser(h.app, "alice");
    const bob = await registerUser(h.app, "bob");
    const carol = await registerUser(h.app, "carol");

    // --- Circle + invite ---
    const circleRes = await inject("POST", "/v1/circles", alice.token, {
      name: "Weekend crew",
      privacy: "private",
    });
    expect(circleRes.statusCode).toBe(201);
    const circleId = circleRes.json().id;

    const inviteRes = await inject("POST", `/v1/circles/${circleId}/invites`, alice.token, {
      role: "member",
      maxUses: 5,
      expiresInHours: 48,
    });
    expect(inviteRes.statusCode).toBe(201);
    const inviteToken = inviteRes.json().inviteToken;

    for (const member of [bob, carol]) {
      const accept = await inject("POST", `/v1/invites/${inviteToken}/accept`, member.token);
      expect(accept.statusCode).toBe(200);
    }

    const circle = await inject("GET", `/v1/circles/${circleId}`, alice.token);
    expect(circle.json().members).toHaveLength(3);

    // --- Poll with server-enforced single vote ---
    const pollRes = await inject("POST", "/v1/activities", alice.token, {
      question: "Where should we eat?",
      options: ["Suya spot", "Noodle bar"],
      circleId,
    });
    expect(pollRes.statusCode).toBe(201);
    const poll = pollRes.json();
    const optionId = poll.options[0].id;

    const vote1 = await inject("POST", `/v1/activities/${poll.id}/votes`, bob.token, { optionId });
    expect(vote1.statusCode).toBe(200);
    expect(vote1.json().totalVotes).toBe(1);

    // Same user voting again is rejected.
    const vote2 = await inject("POST", `/v1/activities/${poll.id}/votes`, bob.token, { optionId });
    expect(vote2.statusCode).toBe(409);

    // A non-member cannot vote.
    const outsider = await registerUser(h.app, "outsider");
    const outsiderVote = await inject("POST", `/v1/activities/${poll.id}/votes`, outsider.token, { optionId });
    expect(outsiderVote.statusCode).toBe(403);

    // --- Plan with RSVP ---
    const planRes = await inject("POST", "/v1/plans", alice.token, {
      circleId,
      title: "Friday dinner",
      startsAt: new Date(Date.now() + 86400000).toISOString(),
      timezone: "Africa/Lagos",
      place: "Yaba",
      participantLimit: 1,
    });
    expect(planRes.statusCode).toBe(201);
    const planId = planRes.json().id;

    const rsvpBob = await inject("POST", `/v1/plans/${planId}/rsvps`, bob.token, { state: "going" });
    expect(rsvpBob.json().state).toBe("going");
    // The only spot is taken, so carol is waitlisted rather than going.
    const rsvpCarol = await inject("POST", `/v1/plans/${planId}/rsvps`, carol.token, { state: "going" });
    expect(rsvpCarol.json().state).toBe("waitlisted");

    // Carol receives a notification about the plan.
    const notifications = await inject("GET", "/v1/notifications", carol.token);
    expect(notifications.json().notifications.length).toBeGreaterThan(0);

    // --- Shared expense with exact-sum equal split ---
    const expenseRes = await inject(
      "POST",
      "/v1/expenses",
      alice.token,
      {
        circleId,
        description: "Dinner",
        amountMinor: 10000,
        currency: "NGN",
        payerId: alice.id,
        splitMode: "equal",
        participants: [{ userId: alice.id }, { userId: bob.id }, { userId: carol.id }],
      },
      { "idempotency-key": "expense-1" },
    );
    expect(expenseRes.statusCode).toBe(201);
    const expense = expenseRes.json();
    const allocations = expense.participants.map((p: { allocationMinor: number }) => p.allocationMinor);
    expect(allocations.reduce((a: number, b: number) => a + b, 0)).toBe(10000);

    // Replaying the same idempotency key returns the same expense, not a second one.
    const replay = await inject(
      "POST",
      "/v1/expenses",
      alice.token,
      {
        circleId,
        description: "Dinner",
        amountMinor: 10000,
        currency: "NGN",
        payerId: alice.id,
        splitMode: "equal",
        participants: [{ userId: alice.id }, { userId: bob.id }, { userId: carol.id }],
      },
      { "idempotency-key": "expense-1" },
    );
    expect(replay.json().expense.id).toBe(expense.expense.id);
    const count = await h.pool.query("SELECT count(*)::int AS n FROM expenses");
    expect(count.rows[0].n).toBe(1);

    // Bob reports a payment. It is NOT verified.
    const bobAllocation = expense.participants.find(
      (p: { userId: string }) => p.userId === bob.id,
    ).allocationMinor;
    const report = await inject(
      "POST",
      `/v1/expenses/${expense.expense.id}/payment-reports`,
      bob.token,
      { amountMinor: bobAllocation, currency: "NGN", note: "Sent by transfer" },
      { "idempotency-key": "report-1" },
    );
    expect(report.statusCode).toBe(201);
    expect(report.json().verified).toBe(false);

    let detail = await inject("GET", `/v1/expenses/${expense.expense.id}`, alice.token);
    let bobAlloc = detail.json().participants.find((p: { userId: string }) => p.userId === bob.id);
    expect(bobAlloc.status).toBe("payment_reported");

    // Alice (the payer) verifies it with a recorded source.
    const reportId = report.json().reportId;
    const verify = await inject(
      "POST",
      `/v1/expenses/${expense.expense.id}/payment-reports/${reportId}/verify`,
      alice.token,
      { verificationSource: "bank_transfer_confirmed" },
    );
    expect(verify.statusCode).toBe(200);

    detail = await inject("GET", `/v1/expenses/${expense.expense.id}`, alice.token);
    bobAlloc = detail.json().participants.find((p: { userId: string }) => p.userId === bob.id);
    expect(bobAlloc.status).toBe("payment_verified");

    // The audit trail records the whole story.
    const events = await inject("GET", `/v1/expenses/${expense.expense.id}/events`, alice.token);
    const types = events.json().events.map((e: { type: string }) => e.type);
    expect(types).toContain("expense.created");
    expect(types).toContain("payment.reported");
    expect(types).toContain("payment.verified");
  });
});
