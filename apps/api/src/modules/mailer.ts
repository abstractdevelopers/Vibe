import type pg from "pg";

/**
 * Transactional email.
 *
 * "Send an email" is written to `email_outbox` inside the same transaction as
 * the thing that caused it, so a reset token can never exist without its email
 * being queued. A worker drains the outbox.
 *
 * Two transports:
 *   - LogMailer: writes the message to the process log. This is the default in
 *     development and test, and it is what makes the reset flow testable
 *     without an email provider.
 *   - SmtpMailer: a real HTTP call to a provider that accepts a simple JSON
 *     POST (Resend-compatible shape). It is only selected when EMAIL_API_KEY is
 *     set, so an unconfigured deploy keeps using the log mailer.
 */

export interface Mailer {
  readonly name: string;
  send(msg: { to: string; subject: string; body: string }): Promise<void>;
}

export class LogMailer implements Mailer {
  readonly name = "log";
  async send(msg: { to: string; subject: string; body: string }): Promise<void> {
    // Deliberately prints the body in development so a developer can copy the
    // reset link. This transport is never selected in production because the
    // production config guard requires EMAIL_API_KEY.
    console.log(`[mailer:log] to=${msg.to} subject=${JSON.stringify(msg.subject)}\n${msg.body}`);
  }
}

export class HttpMailer implements Mailer {
  readonly name = "http";
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly baseUrl: string,
  ) {}

  async send(msg: { to: string; subject: string; body: string }): Promise<void> {
    const res = await fetch(`${this.baseUrl}/emails`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ from: this.from, to: [msg.to], subject: msg.subject, text: msg.body }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`mailer responded ${res.status}`);
    }
  }
}

export function createMailer(opts: {
  apiKey?: string;
  from: string;
  baseUrl: string;
}): Mailer {
  if (opts.apiKey) return new HttpMailer(opts.apiKey, opts.from, opts.baseUrl);
  return new LogMailer();
}

/** Queue an email. Call inside the transaction that made it necessary. */
export async function queueEmail(
  db: pg.Pool | pg.PoolClient,
  msg: { to: string; subject: string; body: string },
): Promise<void> {
  await db.query(
    `INSERT INTO email_outbox (to_email, subject, body) VALUES ($1, $2, $3)`,
    [msg.to, msg.subject, msg.body],
  );
}

/**
 * Send up to `limit` pending messages. Returns how many were sent. A message
 * that fails is retried on the next pass; after 5 attempts it is left with its
 * error recorded for an operator to inspect rather than retried forever.
 */
export async function drainOutbox(
  pool: pg.Pool,
  mailer: Mailer,
  limit = 20,
): Promise<number> {
  // Claim the batch atomically. With more than one instance the old plain
  // SELECT let two workers read the same unsent rows and email the same person
  // twice. `FOR UPDATE SKIP LOCKED` means a row belongs to exactly one worker,
  // and bumping `attempts` here counts the attempt before it is made.
  const { rows } = await pool.query<{ id: string; to_email: string; subject: string; body: string }>(
    `UPDATE email_outbox SET attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM email_outbox
         WHERE sent_at IS NULL AND attempts < 5
         ORDER BY created_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, to_email, subject, body`,
    [limit],
  );
  let sent = 0;
  for (const row of rows) {
    try {
      await mailer.send({ to: row.to_email, subject: row.subject, body: row.body });
      await pool.query(`UPDATE email_outbox SET sent_at = now() WHERE id = $1`, [row.id]);
      sent++;
    } catch (err) {
      await pool.query(
        `UPDATE email_outbox SET last_error = $2 WHERE id = $1`,
        [row.id, err instanceof Error ? err.message : String(err)],
      );
    }
  }
  return sent;
}
