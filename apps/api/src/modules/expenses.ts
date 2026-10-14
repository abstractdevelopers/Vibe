import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  assertValidCurrency,
  splitByPercentage,
  splitCustom,
  splitEqual,
  splitItemized,
  sumAllocations,
  type Allocation,
  type AllocationStatus,
  type SplitMode,
} from "@vibe/shared";
import { ApiError } from "../errors.js";
import { queryMany, queryOne, withTransaction } from "../db.js";
import { newId } from "../ids.js";
import { parse, requireUser, type AppContext } from "../http.js";
import { requireCircleMember, requireCircleRole } from "./access.js";
import { requireIdempotencyKey, runIdempotent } from "../idempotency.js";
import { trackSafe } from "./analytics.js";

/**
 * Shared expense tracker. V1 is a ledger of obligations and reported/verified
 * payment events — it is not a stored-value account and Vibe never holds funds.
 */

const createExpenseSchema = z.object({
  circleId: z.string().uuid(),
  description: z.string().min(1).max(200),
  amountMinor: z.number().int().positive(),
  currency: z.string().length(3),
  payerId: z.string().uuid(),
  splitMode: z.enum(["equal", "custom", "percentage", "itemized"]),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  receiptUrl: z.string().url().max(1000).optional(),
  // exactly one of these is used, depending on splitMode
  participants: z
    .array(
      z.object({
        userId: z.string().uuid(),
        amountMinor: z.number().int().nonnegative().optional(),
        basisPoints: z.number().int().nonnegative().optional(),
      }),
    )
    .optional(),
  lines: z
    .array(z.object({ amountMinor: z.number().int().positive(), userIds: z.array(z.string().uuid()).min(1) }))
    .optional(),
});

const reportSchema = z.object({
  amountMinor: z.number().int().positive(),
  currency: z.string().length(3),
  note: z.string().max(500).optional(),
});

const verifySchema = z.object({
  verificationSource: z.string().min(1).max(120),
});

const statusSchema = z.object({
  status: z.enum(["accepted", "due", "disputed", "settled", "waived", "cancelled"]),
});

/** Allocation status transitions. Anything not listed here is rejected. */
const ALLOWED: Record<AllocationStatus, AllocationStatus[]> = {
  // "accepted" is only required when a Circle asks for it, so a participant can
  // report a payment directly from proposed.
  proposed: ["accepted", "due", "payment_reported", "cancelled"],
  accepted: ["due", "payment_reported", "cancelled"],
  due: ["payment_reported", "disputed", "waived", "cancelled"],
  payment_reported: ["payment_verified", "disputed"],
  payment_verified: ["settled", "disputed"],
  disputed: ["due", "payment_verified", "settled", "cancelled"],
  settled: [],
  waived: [],
  cancelled: [],
};

export function assertAllocationTransition(from: AllocationStatus, to: AllocationStatus): void {
  if (!ALLOWED[from].includes(to)) {
    throw ApiError.conflict(`Cannot move an allocation from ${from} to ${to}`);
  }
}

function computeAllocations(input: z.infer<typeof createExpenseSchema>): Allocation[] {
  const mode = input.splitMode as SplitMode;
  switch (mode) {
    case "equal": {
      const ids = (input.participants ?? []).map((p) => p.userId);
      if (ids.length === 0) throw ApiError.badRequest("Equal split needs at least one participant");
      return splitEqual(input.amountMinor, ids);
    }
    case "custom": {
      const amounts = (input.participants ?? []).map((p) => {
        if (p.amountMinor === undefined) throw ApiError.badRequest("Custom split needs amountMinor per participant");
        return { participantId: p.userId, amount: p.amountMinor };
      });
      return splitCustom(input.amountMinor, amounts);
    }
    case "percentage": {
      const shares = (input.participants ?? []).map((p) => {
        if (p.basisPoints === undefined) throw ApiError.badRequest("Percentage split needs basisPoints per participant");
        return { participantId: p.userId, basisPoints: p.basisPoints };
      });
      return splitByPercentage(input.amountMinor, shares);
    }
    case "itemized": {
      if (!input.lines || input.lines.length === 0) throw ApiError.badRequest("Itemized split needs lines");
      const ids = Array.from(new Set(input.lines.flatMap((line) => line.userIds)));
      return splitItemized(
        input.amountMinor,
        input.lines.map((line) => ({ amount: line.amountMinor, participantIds: line.userIds })),
        ids,
      );
    }
    default:
      throw ApiError.badRequest("Unsupported split mode");
  }
}

async function expenseDetail(ctx: AppContext, expenseId: string, viewerId: string) {
  const expense = await queryOne<Record<string, unknown> & { circle_id: string }>(
    ctx.pool,
    `SELECT id, circle_id, creator_id, payer_id, amount_minor, currency, description, split_mode,
            due_date, receipt_url, status, created_at
       FROM expenses WHERE id = $1`,
    [expenseId],
  );
  if (!expense) throw ApiError.notFound("Expense not found");
  await requireCircleMember(ctx.pool, expense.circle_id, viewerId);

  const participants = await queryMany<{
    user_id: string;
    allocation_minor: number;
    status: AllocationStatus;
    handle: string;
    display_name: string;
  }>(
    ctx.pool,
    `SELECT ep.user_id, ep.allocation_minor, ep.status, u.handle, u.display_name
       FROM expense_participants ep JOIN users u ON u.id = ep.user_id
      WHERE ep.expense_id = $1 ORDER BY ep.allocation_minor DESC`,
    [expenseId],
  );

  const reports = await queryMany<{
    id: string;
    participant_id: string;
    amount_minor: number;
    status: string;
    verification_source: string | null;
    created_at: Date;
    verified_at: Date | null;
  }>(
    ctx.pool,
    `SELECT id, participant_id, amount_minor, status, verification_source, created_at, verified_at
       FROM payment_reports WHERE expense_id = $1 ORDER BY created_at`,
    [expenseId],
  );

  return {
    expense: {
      id: expense.id,
      circleId: expense.circle_id,
      creatorId: expense.creator_id,
      payerId: expense.payer_id,
      amountMinor: expense.amount_minor,
      currency: expense.currency,
      description: expense.description,
      splitMode: expense.split_mode,
      dueDate: expense.due_date,
      receiptUrl: expense.receipt_url,
      status: expense.status,
      createdAt: expense.created_at,
    },
    participants: participants.map((p) => ({
      userId: p.user_id,
      handle: p.handle,
      displayName: p.display_name,
      allocationMinor: p.allocation_minor,
      status: p.status,
    })),
    paymentReports: reports.map((r) => ({
      id: r.id,
      participantId: r.participant_id,
      amountMinor: r.amount_minor,
      status: r.status,
      verificationSource: r.verification_source,
      createdAt: r.created_at,
      verifiedAt: r.verified_at,
    })),
  };
}

export function expensesRoutes(ctx: AppContext) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.post("/v1/expenses", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const key = requireIdempotencyKey(req.headers["idempotency-key"] as string | undefined);
      const input = parse(createExpenseSchema, req.body);
      assertValidCurrency(input.currency);
      await requireCircleMember(ctx.pool, input.circleId, user.id);

      const allocations = computeAllocations(input);
      if (sumAllocations(allocations) !== input.amountMinor) {
        throw ApiError.badRequest("Allocations must sum exactly to the total");
      }

      const result = await runIdempotent(
        ctx.pool,
        { userId: user.id, route: "POST /v1/expenses", key, requestBody: req.body },
        async () => {
          const expenseId = await withTransaction(ctx.pool, async (tx) => {
            const payerIsParticipant = await queryOne(
              tx,
              "SELECT 1 FROM circle_members WHERE circle_id = $1 AND user_id = $2",
              [input.circleId, input.payerId],
            );
            if (!payerIsParticipant) throw ApiError.badRequest("The payer must be a Circle member");
            for (const allocation of allocations) {
              const member = await queryOne(
                tx,
                "SELECT 1 FROM circle_members WHERE circle_id = $1 AND user_id = $2",
                [input.circleId, allocation.participantId],
              );
              if (!member) throw ApiError.badRequest(`Participant ${allocation.participantId} is not in this Circle`);
            }

            const created = await queryOne<{ id: string }>(
              tx,
              `INSERT INTO expenses (id, circle_id, creator_id, payer_id, amount_minor, currency, description,
                                     split_mode, due_date, receipt_url)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
              [
                newId(),
                input.circleId,
                user.id,
                input.payerId,
                input.amountMinor,
                input.currency.toUpperCase(),
                input.description,
                input.splitMode,
                input.dueDate ?? null,
                input.receiptUrl ?? null,
              ],
            );
            for (const allocation of allocations) {
              // The payer's own share is already covered, so it starts settled.
              const initial: AllocationStatus = allocation.participantId === input.payerId ? "settled" : "proposed";
              await tx.query(
                `INSERT INTO expense_participants (expense_id, user_id, allocation_minor, status)
                 VALUES ($1, $2, $3, $4)`,
                [created!.id, allocation.participantId, allocation.amount, initial],
              );
            }
            await tx.query(
              `INSERT INTO expense_events (id, expense_id, actor_id, type, note, metadata)
               VALUES ($1, $2, $3, 'expense.created', $4, $5)`,
              [
                newId(),
                created!.id,
                user.id,
                "Expense created",
                JSON.stringify({ amountMinor: input.amountMinor, currency: input.currency, splitMode: input.splitMode }),
              ],
            );
            return created!.id;
          });
          const body = await expenseDetail(ctx, expenseId, user.id);
          return { statusCode: 201, body };
        },
      );

      if (result.statusCode === 201) {
        trackSafe(ctx.pool, { name: "expense_created", userId: user.id, properties: { entityType: "expense", entityId: String((result.body as { id?: string }).id ?? "") } });
      }
      reply.code(result.statusCode);
      return result.body;
    });

    app.get("/v1/expenses/:id", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      return await expenseDetail(ctx, id, user.id);
    });

    app.get("/v1/expenses/:id/events", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const expense = await queryOne<{ circle_id: string }>(
        ctx.pool,
        "SELECT circle_id FROM expenses WHERE id = $1",
        [id],
      );
      if (!expense) throw ApiError.notFound("Expense not found");
      await requireCircleMember(ctx.pool, expense.circle_id, user.id);
      const events = await queryMany(
        ctx.pool,
        `SELECT id, actor_id, type, from_status, to_status, note, metadata, created_at
           FROM expense_events WHERE expense_id = $1 ORDER BY created_at`,
        [id],
      );
      return { events };
    });

    // Reporting a payment is not verification. The report is recorded and the
    // participant's allocation moves to payment_reported, never to verified.
    app.post("/v1/expenses/:id/payment-reports", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const key = requireIdempotencyKey(req.headers["idempotency-key"] as string | undefined);
      const input = parse(reportSchema, req.body);
      assertValidCurrency(input.currency);

      const result = await runIdempotent(
        ctx.pool,
        { userId: user.id, route: `POST /v1/expenses/${id}/payment-reports`, key, requestBody: req.body },
        async () => {
          const reportId = await withTransaction(ctx.pool, async (tx) => {
            const expense = await queryOne<{ circle_id: string; currency: string; amount_minor: number }>(
              tx,
              "SELECT circle_id, currency, amount_minor FROM expenses WHERE id = $1 FOR UPDATE",
              [id],
            );
            if (!expense) throw ApiError.notFound("Expense not found");
            await requireCircleMember(tx, expense.circle_id, user.id);
            const participant = await queryOne<{ allocation_minor: number; status: AllocationStatus }>(
              tx,
              "SELECT allocation_minor, status FROM expense_participants WHERE expense_id = $1 AND user_id = $2",
              [id, user.id],
            );
            if (!participant) throw ApiError.forbidden("You are not a participant in this expense");
            if (input.currency.toUpperCase() !== expense.currency) {
              throw ApiError.badRequest("Currency does not match the expense");
            }
            if (input.amountMinor > participant.allocation_minor) {
              throw ApiError.badRequest("Reported amount exceeds your allocation");
            }
            assertAllocationTransition(participant.status, "payment_reported");

            const created = await queryOne<{ id: string }>(
              tx,
              `INSERT INTO payment_reports (id, expense_id, participant_id, amount_minor, currency, status, note)
               VALUES ($1, $2, $3, $4, $5, 'reported', $6) RETURNING id`,
              [newId(), id, user.id, input.amountMinor, input.currency.toUpperCase(), input.note ?? null],
            );
            await tx.query(
              "UPDATE expense_participants SET status = 'payment_reported', updated_at = now() WHERE expense_id = $1 AND user_id = $2",
              [id, user.id],
            );
            await tx.query(
              `INSERT INTO expense_events (id, expense_id, actor_id, type, from_status, to_status, note)
               VALUES ($1, $2, $3, 'payment.reported', $4, 'payment_reported', $5)`,
              [newId(), id, user.id, participant.status, "Reported by participant — unverified"],
            );
            return created!.id;
          });
          trackSafe(ctx.pool, { name: "payment_reported", userId: user.id, properties: { entityType: "expense", entityId: id } });
          return {
            statusCode: 201,
            body: { reportId, status: "reported", verified: false, message: "Reported by participant — unverified" },
          };
        },
      );
      reply.code(result.statusCode);
      return result.body;
    });

    // Only the payer (or a Circle admin) can verify, and verification records
    // its source. This is the only path to payment_verified.
    app.post("/v1/expenses/:id/payment-reports/:reportId/verify", async (req) => {
      const user = await requireUser(ctx, req);
      const { id, reportId } = req.params as { id: string; reportId: string };
      const input = parse(verifySchema, req.body);
      await withTransaction(ctx.pool, async (tx) => {
        const expense = await queryOne<{ circle_id: string; payer_id: string }>(
          tx,
          "SELECT circle_id, payer_id FROM expenses WHERE id = $1",
          [id],
        );
        if (!expense) throw ApiError.notFound("Expense not found");
        const role = await requireCircleMember(tx, expense.circle_id, user.id);
        if (expense.payer_id !== user.id && role !== "owner" && role !== "admin") {
          throw ApiError.forbidden("Only the payer or a Circle admin can verify a payment");
        }
        const report = await queryOne<{ participant_id: string; status: string; amount_minor: number }>(
          tx,
          "SELECT participant_id, status, amount_minor FROM payment_reports WHERE id = $1 AND expense_id = $2 FOR UPDATE",
          [reportId, id],
        );
        if (!report) throw ApiError.notFound("Payment report not found");
        if (report.status !== "reported") {
          throw ApiError.conflict(`This report is already ${report.status}`);
        }
        await tx.query(
          `UPDATE payment_reports SET status = 'verified', verification_source = $1, verified_at = now()
            WHERE id = $2`,
          [input.verificationSource, reportId],
        );
        await tx.query(
          `UPDATE expense_participants SET status = 'payment_verified', updated_at = now()
            WHERE expense_id = $1 AND user_id = $2`,
          [id, report.participant_id],
        );
        await tx.query(
          `INSERT INTO expense_events (id, expense_id, actor_id, type, from_status, to_status, note, metadata)
           VALUES ($1, $2, $3, 'payment.verified', 'payment_reported', 'payment_verified', $4, $5)`,
          [newId(), id, user.id, "Verified", JSON.stringify({ verificationSource: input.verificationSource })],
        );
      });
      trackSafe(ctx.pool, { name: "payment_verified", userId: user.id, properties: { entityType: "expense", entityId: id } });
      return { status: "verified" };
    });

    app.post("/v1/expenses/:id/participants/:userId/status", async (req) => {
      const user = await requireUser(ctx, req);
      const { id, userId } = req.params as { id: string; userId: string };
      const input = parse(statusSchema, req.body);
      await withTransaction(ctx.pool, async (tx) => {
        const expense = await queryOne<{ circle_id: string; payer_id: string }>(
          tx,
          "SELECT circle_id, payer_id FROM expenses WHERE id = $1",
          [id],
        );
        if (!expense) throw ApiError.notFound("Expense not found");
        const role = await requireCircleMember(tx, expense.circle_id, user.id);
        const isSubject = userId === user.id;
        const isPrivileged = expense.payer_id === user.id || role === "owner" || role === "admin";
        if (!isSubject && !isPrivileged) throw ApiError.forbidden("You cannot change another member's status");

        const participant = await queryOne<{ status: AllocationStatus }>(
          tx,
          "SELECT status FROM expense_participants WHERE expense_id = $1 AND user_id = $2 FOR UPDATE",
          [id, userId],
        );
        if (!participant) throw ApiError.notFound("Participant not found");
        // Only the payer/admin may settle, waive or cancel.
        if (["settled", "waived", "cancelled"].includes(input.status) && !isPrivileged) {
          throw ApiError.forbidden("Only the payer or a Circle admin can do that");
        }
        assertAllocationTransition(participant.status, input.status);
        await tx.query(
          "UPDATE expense_participants SET status = $1, updated_at = now() WHERE expense_id = $2 AND user_id = $3",
          [input.status, id, userId],
        );
        await tx.query(
          `INSERT INTO expense_events (id, expense_id, actor_id, type, from_status, to_status)
           VALUES ($1, $2, $3, 'allocation.status_changed', $4, $5)`,
          [newId(), id, user.id, participant.status, input.status],
        );
      });
      return { ok: true };
    });
  };
}
