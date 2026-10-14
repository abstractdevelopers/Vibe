import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// Load the repo-root .env if present. Existing environment variables win, and a
// missing file is fine (production supplies real env vars).
const repoRootEnv = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env");
if (existsSync(repoRootEnv)) {
  process.loadEnvFile(repoRootEnv);
}

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(12000),
  CORS_ORIGIN: z.string().default("*"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().optional(),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 7),
  SESSION_SECRET: z.string().min(16).default("dev-session-secret-change-me-please"),
  PAYMENTS_PROVIDER: z.enum(["stub"]).default("stub"),
  PAYMENTS_WEBHOOK_SECRET: z.string().min(1).default("dev-only-stub-secret"),
  PUBLIC_API_URL: z.string().default("http://localhost:12000"),
});

export type Config = z.infer<typeof schema> & { isProduction: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid configuration: ${detail}`);
  }
  const config = parsed.data;
  if (config.NODE_ENV === "production") {
    if (config.SESSION_SECRET === "dev-session-secret-change-me-please") {
      throw new Error("SESSION_SECRET must be set to a strong value in production");
    }
    if (config.PAYMENTS_PROVIDER === "stub") {
      throw new Error(
        "PAYMENTS_PROVIDER=stub is not permitted in production; a provider must be approved first",
      );
    }
  }
  return { ...config, isProduction: config.NODE_ENV === "production" };
}
