/** Create a voice room and a broadcast room for manual QA. Idempotent-ish. */
const API = process.env.API_URL ?? "http://localhost:12000";
async function call(p, b, t) {
  const r = await fetch(API + p, {
    method: b ? "POST" : "GET",
    headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}) },
    body: b ? JSON.stringify(b) : undefined,
  });
  const x = await r.text();
  let j = null;
  try { j = JSON.parse(x); } catch {}
  return { status: r.status, json: j };
}

const login = await call("/v1/auth/login", { email: "zara@example.com", password: "password123" });
if (login.status !== 200) {
  console.error("seed the demo users first: python3 scripts/seed-demo.py");
  process.exit(1);
}
const token = login.json.token;
const existing = await call("/v1/activities/rooms", null, token);

for (const [title, layout] of [["Late Night Frequencies", "stage"], ["The Slow Room", "broadcast"]]) {
  if (existing.json?.rooms?.some((r) => r.title === title)) {
    console.log("exists:", title);
    continue;
  }
  const room = await call("/v1/activities/rooms", {
    kind: "voice", title, topic: "Open mic, low light.",
    startsAt: new Date().toISOString(), durationMinutes: 480, city: "Lagos", layout,
  }, token);
  const id = room.json?.room?.id;
  console.log(room.status, title, id);
  if (id) {
    await call(`/v1/activities/rooms/${id}/join`, {}, token);
    await call(`/v1/activities/rooms/${id}/posts`, { body: "First one in. Mic is warm." }, token);
  }
}
