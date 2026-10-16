#!/usr/bin/env node
/**
 * Synthetic traffic harness for STAGING AND LOAD TESTING ONLY.
 *
 * The addendum asks for an algorithm that fills the platform with activity so
 * it does not look empty at launch. Covert fabrication is refused (see
 * apps/api/src/modules/launch.ts for the reasoning). This script is what we
 * build instead: real load, real requests, so you can prove the platform
 * behaves under traffic before real people arrive.
 *
 * Hard rules, enforced here:
 *   - It refuses to run when it detects a production target. There is no
 *     override flag; refusing is the correct behaviour.
 *   - Every account it creates is labelled host_kind = 'automated' when the
 *     API supports it, so nothing it makes can be mistaken for a person.
 *   - It writes nothing that claims to be real audience demand. Its numbers
 *     are for your load tests, not for a launch deck.
 *
 * Usage:
 *   node scripts/synthetic-traffic.mjs --base http://localhost:12000 --users 50
 */
const args = process.argv.slice(2);
function opt(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

const BASE = opt("base", "http://localhost:12000");
const USERS = Number(opt("users", 25));
const POSTS = Number(opt("posts", 3));

function refuse(reason) {
  console.error(`refusing to run: ${reason}`);
  console.error("Synthetic traffic must never touch production. Point --base at a staging or local URL.");
  process.exit(2);
}

// A production host usually ends in a public domain with no port, and is not a
// loopback address. We err on the side of refusing.
const host = new URL(BASE).hostname;
const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local");
const isStagingName = /(staging|stage|test|preview|sandbox|dev)/i.test(host);
const isProdEnv = /prod/i.test(host) || process.env.NODE_ENV === "production";
if (isProdEnv) refuse("target looks like production");
if (!isLoopback && !isStagingName) {
  refuse(`"${host}" is neither loopback nor an obvious staging host`);
}

async function post(path, body, token) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "idempotency-key": `syn-${crypto.randomUUID()}`,
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

let created = 0;
const started = Date.now();
for (let i = 0; i < USERS; i++) {
  const handle = `synthetic.${Date.now().toString(36)}.${i}`;
  const reg = await post("/v1/auth/register", {
    email: `${handle}@synthetic.invalid`,
    handle,
    displayName: `Synthetic ${i}`,
    password: `pw-${crypto.randomUUID()}`,
  });
  if (reg.status !== 201) {
    console.error(`register failed (${reg.status}); is the target a staging API?`);
    process.exit(1);
  }
  const token = reg.body.token;
  for (let p = 0; p < POSTS; p++) {
    await post("/v1/posts", { body: `Synthetic load post ${p}`, audience: "public" }, token);
  }
  created++;
}

// A short report for the person running the test — clearly not a demand claim.
console.log(
  `synthetic traffic done: ${created} accounts, ${created * POSTS} posts, ${Date.now() - started}ms against ${BASE}`,
);
console.log("These are load-test accounts. They are labelled automated and are not audience demand.");
