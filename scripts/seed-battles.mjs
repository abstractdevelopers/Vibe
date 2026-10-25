/** Seed a few open battles across stadiums so the map has content. */
const API = process.env.API_URL ?? "http://localhost:12000";
async function call(path, body, token) {
  const r = await fetch(API + path, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch {}
  return { status: r.status, json: j };
}

const token = (await call("/v1/auth/login", { email: "zara@example.com", password: "password123" })).json.token;
const existing = await call("/v1/battles?status=open&limit=20", null, token);
const have = existing.json?.battles?.length ?? 0;
console.log("open battles:", have);
if (have >= 4) process.exit(0);

const seeds = [
  ["Jollof vs Fried rice", "Jollof", "Fried rice", "colosseum", 300],
  ["Burna vs Wizkid", "Burna", "Wizkid", "neon", 600],
  ["Lagos vs Abuja", "Lagos", "Abuja", "rooftop", 900],
  ["Suya vs Shawarma", "Suya", "Shawarma", "dunes", 600],
  ["Android vs iPhone", "Android", "iPhone", "lagoon", 300],
];
for (const [title, sideA, sideB, stadiumId, intervalSeconds] of seeds) {
  const r = await call("/v1/battles", { title, sideA, sideB, stadium: stadiumId, intervalSeconds }, token);
  console.log(r.status, title, r.json?.battle?.id ?? r.json?.id ?? JSON.stringify(r.json).slice(0, 80));
}
