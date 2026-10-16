import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { buildApp } from "./app.js";
import { RealtimeHub } from "./realtime.js";
import { createPaymentProvider } from "./payments/provider.js";
import { createMailer, drainOutbox } from "./modules/mailer.js";
import { prune as pruneRateLimits } from "./modules/ratelimit.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL, config.PGPOOL_MAX);
  const hub = new RealtimeHub();
  const provider = createPaymentProvider(config.PAYMENTS_PROVIDER, config.PAYMENTS_WEBHOOK_SECRET, {
    apiKey: config.BACHS_API_KEY,
    baseUrl: config.BACHS_BASE_URL,
    webUrl: config.PUBLIC_WEB_URL,
    apiUrl: config.PUBLIC_API_URL,
  });

  const mailer = createMailer({
    apiKey: config.EMAIL_API_KEY,
    from: config.EMAIL_FROM,
    baseUrl: config.EMAIL_BASE_URL,
  });

  const app = await buildApp({ pool, config, hub, provider, mailer });
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
  app.log.info({ mailer: mailer.name }, "mailer selected");

  // Drain the email outbox and prune old rate-limit windows. On a single
  // instance a small interval timer is enough; a multi-instance deployment
  // moves this to the worker tier (see the scale plan, Part A §7).
  const outboxTimer = setInterval(() => {
    void drainOutbox(pool, mailer).catch((err) => app.log.error({ err }, "outbox drain failed"));
    void pruneRateLimits(pool).catch(() => undefined);
  }, 15_000);
  outboxTimer.unref();

  const shutdown = async () => {
    clearInterval(outboxTimer);
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
