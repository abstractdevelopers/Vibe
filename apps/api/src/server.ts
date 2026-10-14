import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { buildApp } from "./app.js";
import { RealtimeHub } from "./realtime.js";
import { createPaymentProvider } from "./payments/provider.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL);
  const hub = new RealtimeHub();
  const provider = createPaymentProvider(config.PAYMENTS_PROVIDER, config.PAYMENTS_WEBHOOK_SECRET);

  const app = await buildApp({ pool, config, hub, provider });
  await app.listen({ port: config.PORT, host: "0.0.0.0" });

  const shutdown = async () => {
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
