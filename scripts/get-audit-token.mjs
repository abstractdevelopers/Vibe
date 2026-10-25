/**
 * Print a real session token for the audit.
 *
 *   AUDIT_TOKEN=$(node scripts/get-audit-token.mjs) node scripts/audit-ui.mjs
 *
 * Exits non-zero with a readable message when the login fails, so a mistyped
 * password or an unseeded database cannot quietly produce an unauthenticated
 * audit run.
 */
const API = process.env.API_URL ?? "http://localhost:12000";
const email = process.env.AUDIT_EMAIL ?? "zara@example.com";
const password = process.env.AUDIT_PASSWORD ?? "password123";

const res = await fetch(`${API}/v1/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password }),
}).catch((e) => {
  console.error(`could not reach the API at ${API}: ${e.message}`);
  process.exit(3);
});

const body = await res.json().catch(() => null);
if (!res.ok || !body?.token) {
  console.error(
    `login failed for ${email} (${res.status}). ` +
      `Seed the demo data first: python3 scripts/seed-demo.py\n` +
      `${JSON.stringify(body).slice(0, 200)}`,
  );
  process.exit(1);
}
process.stdout.write(body.token);
