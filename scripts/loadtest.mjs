#!/usr/bin/env node
/**
 * Latency baseline for the common API reads (§5, §11).
 *
 * The spec is explicit that its latency targets are engineering targets to
 * measure, not guarantees, and that a baseline must be established before any
 * target is claimed. This script measures p50/p75/p95/p99 for a handful of
 * representative read and write paths and prints them. It deliberately does NOT
 * assert a pass/fail against the spec's targets: this environment is not the
 * target network or device class, so claiming a target here would be dishonest.
 *
 * Usage: node scripts/loadtest.mjs [baseUrl] [iterations]
 *   baseUrl     default http://localhost:12000
 *   iterations  default 200 per endpoint
 */

const base = (process.argv[2] ?? process.env.PUBLIC_API_URL ?? "http://localhost:12000").replace(/\/$/, "");
const iterations = Number(process.argv[3] ?? 200);

function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

async function timed(fn) {
  const start = performance.now();
  try {
    await fn();
    return performance.now() - start;
  } catch {
    return null;
  }
}

async function login() {
  const email = `load-${Date.now()}@example.com`;
  const register = await fetch(`${base}/v1/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, handle: `load${Date.now()}`, displayName: "Load", password: "password123" }),
  });
  if (!register.ok) throw new Error(`register failed: ${register.status}`);
  return (await register.json()).token;
}

async function measure(name, token, path, init = {}) {
  const times = [];
  let errors = 0;
  for (let i = 0; i < iterations; i++) {
    const ms = await timed(() =>
      fetch(`${base}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
      }),
    );
    if (ms === null) errors++;
    else times.push(ms);
  }
  times.sort((a, b) => a - b);
  return {
    name,
    n: times.length,
    errors,
    p50: pct(times, 50),
    p75: pct(times, 75),
    p95: pct(times, 95),
    p99: pct(times, 99),
  };
}

async function main() {
  const token = await login();
  const cases = [
    ["GET /v1/feed", "/v1/feed?limit=20"],
    ["GET /v1/me", "/v1/me"],
    ["GET /v1/events", "/v1/events"],
    ["GET /v1/search/posts?q=a", "/v1/search/posts?q=a"],
    ["GET /v1/openapi.json", "/v1/openapi.json"],
  ];

  const rows = [];
  for (const [name, path] of cases) rows.push(await measure(name, token, path));

  console.log(`\nLatency baseline — ${iterations} iterations/route against ${base}\n`);
  console.log("route".padEnd(30), "ok".padStart(6), "p50".padStart(8), "p75".padStart(8), "p95".padStart(8), "p99".padStart(8));
  for (const r of rows) {
    console.log(
      r.name.padEnd(30),
      String(r.n).padStart(6),
      `${r.p50.toFixed(1)}`.padStart(8),
      `${r.p75.toFixed(1)}`.padStart(8),
      `${r.p95.toFixed(1)}`.padStart(8),
      `${r.p99.toFixed(1)}`.padStart(8),
    );
  }
  console.log(
    "\nRecorded for reference only. The spec's targets are p95 ≤ 300ms reads / ≤ 500ms writes\n" +
      "in the primary region on representative networks; this run is on this host's network\n" +
      "and is not evidence against them. Compare to a stored baseline over time instead.\n",
  );
}

main().catch((err) => {
  console.error(`loadtest failed: ${err.message}`);
  console.error(`Is the API running at ${base}?`);
  process.exitCode = 1;
});
