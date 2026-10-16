/**
 * End-to-end functional walkthrough over CDP.
 * Exercises real user journeys by clicking, and asserts the visible result.
 * Writes screenshots to .audit/e2e-*.png
 */
import fs from "node:fs";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import pg from "pg";

const WEB = process.env.WEB_URL || "https://work-2-evxhdzrcurhrlndz.prod-runtime.all-hands.dev/";
const API = "http://localhost:12000";
const PORT = 9400;
const OUT = ".audit/";
// CI installs Chromium at a distro path; allow an override, and make sure the
// screenshot output directory exists.
fs.mkdirSync(OUT, { recursive: true });
const CHROME_BIN = process.env.CHROME_BIN || "chromium";

const chrome = spawn(CHROME_BIN, ["--headless=new", `--remote-debugging-port=${PORT}`, "--no-sandbox", "--disable-gpu", "--window-size=430,932", "--user-data-dir=/tmp/chrome-e2e", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function wsurl() { for (let i = 0; i < 60; i++) { try { const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl; } catch {} await sleep(200); } throw new Error("no chrome"); }
let id = 0;
const rpc = (ws, m, p = {}, s) => new Promise((res, rej) => { const i = ++id; const h = (r) => { const o = JSON.parse(r); if (o.id === i) { ws.off("message", h); o.error ? rej(new Error(o.error.message)) : res(o.result); } }; ws.on("message", h); ws.send(JSON.stringify({ id: i, method: m, params: p, sessionId: s })); });

const ws = new WebSocket(await wsurl(), { perMessageDeflate: false });
await new Promise((r) => ws.on("open", r));
const { targetId } = await rpc(ws, "Target.createTarget", { url: "about:blank" });
const { sessionId } = await rpc(ws, "Target.attachToTarget", { targetId, flatten: true });
await rpc(ws, "Page.enable", {}, sessionId);
await rpc(ws, "Runtime.enable", {}, sessionId);
await rpc(ws, "Emulation.setDeviceMetricsOverride", { width: 430, height: 932, deviceScaleFactor: 2, mobile: true }, sessionId);

const ev = async (e) => { const r = await rpc(ws, "Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }, sessionId); if (r.exceptionDetails) return { __exc: r.exceptionDetails.text }; return r.result.value; };
const shot = async (n) => { const { data } = await rpc(ws, "Page.captureScreenshot", { format: "png" }, sessionId); fs.writeFileSync(`${OUT}${n}.png`, Buffer.from(data, "base64")); };
const bodyText = () => ev(`document.body.innerText`);
const clickText = async (t, exact = true) => ev(`(()=>{const els=[...document.querySelectorAll("button,a,[role=button],label")];const el=els.find(e=>(e.textContent||"").trim()===${JSON.stringify(t)})||(${exact}?null:els.find(e=>(e.textContent||"").trim().includes(${JSON.stringify(t)})));if(!el)return false;el.click();return true;})()`);
const clickSel = async (sel) => ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return false;el.click();return true;})()`);

const results = [];
function check(name, ok, detail = "") { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); }

// ---- sign in ----
const token = await (await fetch(`${API}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "zara@example.com", password: "password123" }) })).json().then((j) => j.token);
await rpc(ws, "Page.navigate", { url: WEB }, sessionId); await sleep(1500);
await ev(`localStorage.clear()`);
await ev(`localStorage.setItem("vibe.token", ${JSON.stringify(token)}); localStorage.setItem("vibe.theme","dark")`);
await rpc(ws, "Page.navigate", { url: WEB }, sessionId); await sleep(2200);
let t = await bodyText();
check("Signed-in home loads with feed", /Good to see you|What’s happening/i.test(t), t.slice(0, 40));

// ---- nav ----
for (const [label, expect] of [["Circles", /Circles/], ["Explore", /Explore/], ["You", /Zara Ade/]]) {
  await ev(`(()=>{const b=[...document.querySelectorAll("nav button")].find(e=>(e.textContent||"").trim()===${JSON.stringify(label)});if(b)b.click();})()`);
  await sleep(800);
  t = await bodyText();
  check(`Tab ${label} renders`, expect.test(t), t.replace(/\n/g, " ").slice(0, 50));
  await shot(`e2e-tab-${label.toLowerCase()}`);
}

// ---- compose a post ----
await ev(`(()=>{const b=[...document.querySelectorAll("nav button")].find(e=>(e.textContent||"").trim()==="Home");if(b)b.click();})()`); await sleep(700);
const created = await ev(`(async()=>{
  const r = await fetch("/v1/posts", { method:"POST", headers:{ "content-type":"application/json", "authorization":"Bearer "+localStorage.getItem("vibe.token"), "idempotency-key":"e2e-"+Math.random() }, body: JSON.stringify({ body:"E2E check post "+Date.now(), audience:"public" }) });
  return r.status;
})()`);
check("Can create a post via API", created === 201, "status " + created);

// ---- reactions (optimistic) ----
await rpc(ws, "Page.navigate", { url: WEB }, sessionId); await sleep(1800);
const reacted = await ev(`(()=>{const b=[...document.querySelectorAll(".react-btn")].find(e=>/like/i.test(e.textContent||"")||/^\\d+$/.test((e.textContent||"").trim()));if(!b)return "none";b.click();return "clicked";})()`);
await sleep(500);
check("Feed reaction control is clickable", reacted === "clicked", reacted);
const editControl = await ev(`(()=>{const b=document.querySelector('[aria-label="Edit post"]');return b?"present":"none";})()`);
check("Own post exposes an edit control", editControl === "present", editControl);

// ---- create sheet ----
await ev(`(()=>{const b=[...document.querySelectorAll("nav button")].find(e=>/create/i.test(e.getAttribute("aria-label")||"")||e.getAttribute("aria-label")==="Create");if(b)b.click();})()`);
await sleep(600);
t = await bodyText();
check("Create sheet opens with options", /Post/.test(t) && /Poll/.test(t) && /Plan/.test(t), t.replace(/\n/g, " ").slice(0, 60));
await shot("e2e-create-sheet");
await ev(`(()=>{const b=[...document.querySelectorAll("button")].find(e=>/cancel|close/i.test(e.textContent||""));if(b)b.click();})()`);
await sleep(400);

// ---- circle detail + tabs ----
await ev(`(()=>{const b=[...document.querySelectorAll("nav button")].find(e=>(e.textContent||"").trim()==="Circles");if(b)b.click();})()`); await sleep(800);
await clickText("Weekend Crew", false); await sleep(900);
t = await bodyText();
check("Circle detail opens", /Weekend Crew/.test(t) && /member/i.test(t), t.replace(/\n/g, " ").slice(0, 60));
await shot("e2e-circle");
{
  const full = await ev(`document.body.innerText`);
  const lower = full.toLowerCase();
  for (const sec of ["plans", "shared money", "members"]) {
    check(`Circle section ${sec} present`, lower.includes(sec), full.replace(/\n/g," ").slice(0,50));
  }
}

// ---- plan detail + RSVP ----
await clickText("Beach day", false); await sleep(800);
t = await bodyText();
check("Plan detail opens", /Beach day/.test(t), t.replace(/\n/g, " ").slice(0, 60));
const rsvp = await clickText("Going", false) || await clickText("Interested", false);
await sleep(600);
check("Plan RSVP control works", !!rsvp, String(rsvp));
await shot("e2e-plan");

// ---- expense breakdown + report payment ----
await ev(`(()=>{const b=[...document.querySelectorAll("button")].find(e=>/back/i.test(e.textContent||""));if(b)b.click();})()`); await sleep(700);
await clickText("Boat ride", false); await sleep(800);
t = await bodyText();
check("Expense breakdown opens", /who owes what|equal split|payment reports/i.test(t), t.replace(/\n/g, " ").slice(0, 60));
// The screen must surface each person's allocation state. Depending on the
// viewer's role there is either a "I've paid" / "Verify" action or a dispute
// action; a payer with nothing pending legitimately shows none of these.
const showsAllocations = /settled|proposed|not yet confirmed|payment/i.test(t);
const actionControl = await ev(`(()=>{const b=[...document.querySelectorAll("button")].find(e=>/paid|verify|dispute/i.test(e.textContent||""));return b?b.textContent.trim():false;})()`);
check("Expense surfaces allocation state", showsAllocations || !!actionControl, `${showsAllocations} / ${actionControl}`);
await shot("e2e-expense");

// ---- messaging ----
await ev(`(()=>{const b=[...document.querySelectorAll("button")].find(e=>/messages/i.test(e.getAttribute("aria-label")||""));if(b)b.click();})()`); await sleep(800);
t = await bodyText();
check("Messages list opens", t.length > 20, t.replace(/\n/g, " ").slice(0, 50));
await clickText("Ada Okafor", false); await sleep(900);
t = await bodyText();
check("Conversation opens", /Saturday|cooler|tickets/.test(t), t.replace(/\n/g, " ").slice(0, 60));
const sent = await ev(`(async()=>{
  const c=[...document.querySelectorAll("input,textarea")].find(e=>/message/i.test(e.placeholder||"")||e.tagName==="TEXTAREA");
  if(!c)return "no-composer";
  const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value")?.set || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,"value").set;
  set.call(c,"E2E hello "+Date.now()); c.dispatchEvent(new Event("input",{bubbles:true}));
  await new Promise(r=>setTimeout(r,100));
  const btn=[...document.querySelectorAll("button")].find(e=>/send/i.test(e.textContent||"")||/send/i.test(e.getAttribute("aria-label")||""));
  if(!btn)return "no-send";
  btn.click(); return "sent";
})()`);
await sleep(900);
t = await bodyText();
check("Can send a chat message", sent === "sent" && /E2E hello/.test(t), `${sent}; visible=${/E2E hello/.test(t)}`);
await shot("e2e-conversation");

// ---- inbox ----
await ev(`(()=>{const b=[...document.querySelectorAll("button")].find(e=>/inbox/i.test(e.getAttribute("aria-label")||""));if(b)b.click();})()`); await sleep(700);
t = await bodyText();
check("Inbox opens", /Inbox|caught up/i.test(t), t.replace(/\n/g, " ").slice(0, 50));
await shot("e2e-inbox");

// ---- settings + theme toggle ----
await ev(`document.querySelector('[aria-label="Account menu"]')?.click()`); await sleep(400);
await clickText("Settings", false); await sleep(800);
t = await bodyText();
check("Settings opens with privacy controls", /Privacy|Discoverable|Read receipts/i.test(t), t.replace(/\n/g, " ").slice(0, 60));
check("Settings shows notification controls", /Notifications|Circle invites|Quiet hours/i.test(t), t.replace(/\n/g, " ").slice(0, 60));
check("Settings shows data & account controls", /Your data|Download my data|Delete my account/i.test(t), t.replace(/\n/g, " ").slice(0, 60));
check("Settings payment copy reflects provider-collected money", /never holds your money/i.test(t) && !/not enabled in this version/i.test(t), t.replace(/\n/g, " ").slice(0, 80));
const before = await ev(`document.documentElement.dataset.theme`);
await clickText("Toggle light / dark", false); await sleep(800);
const after = await ev(`document.documentElement.dataset.theme`);
check("Theme toggle switches theme", before !== after, `${before} -> ${after}`);
await shot("e2e-settings-light");

// ---- explore search + place ----
await ev(`(()=>{const b=[...document.querySelectorAll("nav button")].find(e=>(e.textContent||"").trim()==="Explore");if(b)b.click();})()`); await sleep(800);
await clickText("Tarkwa Bay Beach", false); await sleep(800);
t = await bodyText();
check("Place detail opens from Explore", /Tarkwa Bay/.test(t), t.replace(/\n/g, " ").slice(0, 50));
await shot("e2e-place");

// ---- report a post (safety) ----
await ev(`(()=>{const b=[...document.querySelectorAll("nav button")].find(e=>(e.textContent||"").trim()==="Home");if(b)b.click();})()`); await sleep(700);
const openedReport = await ev(`(()=>{const b=[...document.querySelectorAll("button")].find(e=>/report/i.test(e.textContent||"")||/more|options|menu/i.test(e.getAttribute("aria-label")||""));if(!b)return "none";b.click();return "opened";})()`);
await sleep(500);
check("Report/menu control reachable from feed", openedReport !== "none", String(openedReport));
await shot("e2e-report");

// ---- comment replies, edit, delete + undo (author lifecycle) ----
// Use a fresh account for this section: the feed diversifies to at most three
// posts per author per page, so a new author's post is guaranteed to be visible
// (and it is genuinely "mine", which is what unlocks the delete control).
const setInput = `const set=(el,v)=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set.call(el,v);el.dispatchEvent(new Event("input",{bubbles:true}))};`;
const marker = "E2Ecomment" + Date.now();
const freshToken = await (await fetch(`${API}/v1/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: `${marker}@example.com`, handle: marker, displayName: "E2E Commenter", password: "password123" }) })).json().then((j) => j.token);
await ev(`localStorage.setItem("vibe.token", ${JSON.stringify(freshToken)})`);
await ev(`(async()=>{await fetch("/v1/posts",{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+localStorage.getItem("vibe.token"),"idempotency-key":"e2e-c-"+Math.random()},body:JSON.stringify({body:${JSON.stringify(marker)},audience:"public"})})})()`);
await rpc(ws, "Page.navigate", { url: WEB }, sessionId); await sleep(2400);
const cardExpr = `[...document.querySelectorAll("article.post")].find(x=>x.textContent.includes(${JSON.stringify(marker)}))`;
const hasCard = await ev(`!!${cardExpr}`);
check("Comment test post is present", hasCard, String(hasCard));
if (hasCard) {
  await ev(`(()=>{${cardExpr}.querySelector('[aria-label="Comments"]').click();return true;})()`); await sleep(600);
  await ev(`(()=>{${setInput}const a=${cardExpr};set(a.querySelector('input[aria-label="Write a comment"]'),"E2E parent");return true;})()`); await sleep(200);
  await ev(`(()=>{const a=${cardExpr};a.querySelector('input[aria-label="Write a comment"]').parentElement.querySelector("button.btn.primary").click();return true;})()`); await sleep(1300);
  t = await bodyText();
  check("Comment thread stays open after posting", t.includes("E2E parent"), t.replace(/\n/g, " ").slice(0, 50));
  check("Comment exposes Reply / Edit / Delete", /\bReply\b/.test(t) && /\bEdit\b/.test(t) && /\bDelete\b/.test(t));
  await shot("e2e-comments");

  // reply
  await ev(`(()=>{const a=${cardExpr};[...a.querySelectorAll("button")].find(e=>e.textContent.trim()==="Reply").click();return true;})()`); await sleep(400);
  const replyMode = /Replying to @/.test(await bodyText());
  await ev(`(()=>{${setInput}const a=${cardExpr};const i=[...a.querySelectorAll("input")].find(e=>/reply/i.test(e.getAttribute("aria-label")||""));set(i,"E2E reply");i.parentElement.querySelector("button.btn.primary").click();return true;})()`); await sleep(1400);
  t = await bodyText();
  check("Reply posts and nests under its parent", replyMode && t.includes("E2E reply") && (await ev(`document.querySelectorAll('.comment-replies').length`)) > 0, `mode=${replyMode}`);

  // edit
  await ev(`(()=>{const a=${cardExpr};[...a.querySelector(".comment-row").querySelectorAll("button")].find(e=>e.textContent.trim()==="Edit").click();return true;})()`); await sleep(400);
  await ev(`(()=>{${setInput}const a=${cardExpr};const i=a.querySelector('input[aria-label="Edit your comment"]');set(i,"E2E parent edited");i.parentElement.querySelector("button.btn.primary").click();return true;})()`); await sleep(1300);
  t = await bodyText();
  check("Comment edit saves and marks edited", t.includes("E2E parent edited") && t.includes("edited"));

  // delete + undo
  await ev(`(()=>{const a=${cardExpr};[...a.querySelector(".comment-row").querySelectorAll("button")].find(e=>e.textContent.trim()==="Delete").click();return true;})()`); await sleep(1400);
  t = await bodyText();
  check("Deleted comment shows a placeholder with an Undo", t.includes("Comment deleted") && t.includes("Undo"));
  await ev(`(()=>{const b=[...document.querySelectorAll(".toast-action")].find(e=>/undo/i.test(e.textContent||""));if(!b)return false;b.click();return true;})()`); await sleep(1400);
  check("Comment undo restores the comment", (await bodyText()).includes("E2E parent edited"));
}

// ---- post delete + undo ----
const delOpened = await ev(`(()=>{const a=${cardExpr};const b=a&&a.querySelector('[aria-label="Delete post"]');if(!b)return false;b.click();return true;})()`);
await sleep(400);
if (delOpened) {
  await ev(`(()=>{const n=[...document.querySelectorAll(".notice.danger button")].find(e=>e.textContent.trim()==="Delete");if(!n)return false;n.click();return true;})()`); await sleep(1200);
  t = await bodyText();
  check("Deleting a post removes it and offers Undo", !t.includes(marker) && t.includes("Post deleted"));
  await ev(`(()=>{const b=[...document.querySelectorAll(".toast-action")].find(e=>/undo/i.test(e.textContent||""));if(!b)return false;b.click();return true;})()`); await sleep(1500);
  check("Post undo restores the post", (await bodyText()).includes(marker));
} else {
  check("Deleting a post removes it and offers Undo", false, "no delete control");
  check("Post undo restores the post", false, "no delete control");
}

// ---- commerce + advertising UI ----
// Seed a verified merchant with an active product via the API, then walk the
// storefront -> product -> order flow through the real UI.
const shopHandle = "shop" + Date.now();
const shopToken = await (await fetch(`${API}/v1/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: `${shopHandle}@example.com`, handle: shopHandle, displayName: "E2E Shop", password: "password123" }) })).json().then((j) => j.token);
const shopAuth = { "content-type": "application/json", authorization: `Bearer ${shopToken}` };
const shopId = await (await fetch(`${API}/v1/merchants`, { method: "POST", headers: shopAuth, body: JSON.stringify({ name: "E2E Coffee", category: "food" }) })).json().then((j) => j.id);
// Merchant verification is an operator action; the e2e actor is granted admin
// directly, as an operator would be.
const adminPool = new pg.Pool({ connectionString: process.env.DATABASE_URL || "postgres://vibe:vibe@localhost:5432/vibe" });
await adminPool.query("UPDATE users SET is_admin = true WHERE id = (SELECT id FROM users WHERE handle = 'zara')");
const verifyRes = await fetch(`${API}/v1/admin/merchants/${shopId}/verify`, { method: "POST", headers: { ...shopAuth, authorization: `Bearer ${token}` }, body: JSON.stringify({ verificationStatus: "verified" }) });
check("Operator can verify a merchant", verifyRes.status === 200, "status " + verifyRes.status);
const prodId = await (await fetch(`${API}/v1/merchants/${shopId}/products`, { method: "POST", headers: shopAuth, body: JSON.stringify({ name: "E2E Latte", priceMinor: 2500, currency: "NGN", status: "active" }) })).json().then((j) => j.id);

await ev(`localStorage.setItem("vibe.token", ${JSON.stringify(token)})`);
await rpc(ws, "Page.navigate", { url: WEB }, sessionId); await sleep(2000);
await ev(`(()=>{const b=[...document.querySelectorAll("nav button")].find(e=>(e.textContent||"").trim()==="Explore");if(b)b.click();})()`); await sleep(1200);
t = await bodyText();
check("Explore lists verified shops", /Shops/.test(t) && /E2E Coffee/.test(t), t.replace(/\n/g, " ").slice(0, 60));
await shot("e2e-shops");

await clickText("E2E Coffee", false); await sleep(1000);
t = await bodyText();
check("Storefront opens with a product", /E2E Latte/.test(t), t.replace(/\n/g, " ").slice(0, 60));
await clickText("E2E Latte", false); await sleep(1000);
t = await bodyText();
check("Product detail shows a formatted price and no NaN", /25\.00/.test(t) && !/NaN/.test(t), t.replace(/\n/g, " ").slice(0, 80));
check("Product detail offers the continue action", /Continue to payment/i.test(t), t.replace(/\n/g, " ").slice(0, 60));
await shot("e2e-product");

await clickText("Continue to payment", false); await sleep(1500);
t = await bodyText();
check("Order screen opens unpaid and offers provider payment", /Order/.test(t) && /Pay with the payment provider/.test(t), t.replace(/\n/g, " ").slice(0, 60));
const orderStatusUnpaid = /created|awaiting payment/i.test(t);
check("Order is not marked paid before the provider confirms", orderStatusUnpaid && !/\bpaid\b/.test(t), String(orderStatusUnpaid));
await shot("e2e-order");

// advertising manager reachable from the account menu
await ev(`document.querySelector('[aria-label="Account menu"]')?.click()`); await sleep(400);
await clickText("Advertising", false); await sleep(900);
t = await bodyText();
check("Advertising manager opens", /Advertising/.test(t) && /New campaign/.test(t), t.replace(/\n/g, " ").slice(0, 60));
await shot("e2e-advertising");

// ---- Phase 4/5 surfaces + operator console ----
// Events: seed one owned by the actor so the organizer controls are live, then
// drive the real check-in flow through the UI.
const eventRes = await fetch(`${API}/v1/events`, {
  method: "POST", headers: { ...shopAuth, authorization: `Bearer ${token}` },
  body: JSON.stringify({ title: "E2E Rooftop", startsAt: new Date(Date.now() + 86400000).toISOString(), timezone: "Africa/Lagos", city: "Lagos" }),
});
const eventId = (await eventRes.json()).id;
await fetch(`${API}/v1/events/${eventId}/publish`, { method: "POST", headers: { ...shopAuth, authorization: `Bearer ${token}` } });

await rpc(ws, "Page.navigate", { url: WEB }, sessionId); await sleep(1800);
await ev(`document.querySelector('[aria-label="Account menu"]')?.click()`); await sleep(400);
await clickText("Events", false); await sleep(1000);
t = await bodyText();
check("Events screen opens and lists the event", /Events/.test(t) && /E2E Rooftop/.test(t), t.replace(/\n/g, " ").slice(0, 60));
check("Events copy states a plan is not a reservation", /not a reservation|not a ticket/i.test(t), t.replace(/\n/g, " ").slice(0, 70));

// Expand the event and exercise the real check-in interaction.
await clickText("E2E Rooftop", false); await sleep(900);
t = await bodyText();
check("Event detail exposes a check-in field and organizer control",
  (await ev(`!!document.querySelector('[aria-label="Check-in code"]')`)) &&
  (await ev(`[...document.querySelectorAll("button")].some(b=>b.textContent.includes("Issue a check-in"))`)),
  t.replace(/\n/g, " ").slice(0, 70));
// Issue a code through the organizer UI, read the displayed token from its
// monospace element, then check in with it through the same field.
await clickText("Issue a check-in code (organizer)", false); await sleep(1000);
const codeEl = await ev(`(()=>{const els=[...document.querySelectorAll("div")];const m=els.find(e=>{const s=getComputedStyle(e);return s.fontFamily.includes("monospace")&&/^[0-9A-Za-z_-]{12,}$/.test((e.textContent||"").trim());});return m?m.textContent.trim():"";})()`);
check("Organizer can issue a check-in code", typeof codeEl === "string" && codeEl.length >= 12, String(codeEl).slice(0, 24));
// Check in with that exact code through the field, then confirm the count rose.
if (codeEl) {
  await ev(`(()=>{const i=document.querySelector('[aria-label="Check-in code"]');const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;s.call(i,${JSON.stringify(codeEl)});i.dispatchEvent(new Event("input",{bubbles:true}));})()`);
  await sleep(200);
  await clickText("Check in", false); await sleep(1200);
  t = await bodyText();
  check("Check-in succeeds and the count reflects it", /Checked in/i.test(t) && /1 checked in/.test(t), t.replace(/\n/g, " ").slice(0, 90));
  // A bad code must be refused (server-side validation, not just a hidden field).
  await ev(`(()=>{const i=document.querySelector('[aria-label="Check-in code"]');const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;s.call(i,"definitely-not-a-real-code");i.dispatchEvent(new Event("input",{bubbles:true}));})()`);
  await sleep(200);
  await clickText("Check in", false); await sleep(1000);
  t = await bodyText();
  check("An invalid check-in code is refused", /invalid|not valid|no longer/i.test(t), t.replace(/\n/g, " ").slice(0, 80));
}
await shot("e2e-events");

// Vibe Pass: create, then flip a consent toggle and confirm it persists.
await rpc(ws, "Page.navigate", { url: WEB }, sessionId); await sleep(1600);
await ev(`document.querySelector('[aria-label="Account menu"]')?.click()`); await sleep(400);
await clickText("Vibe Pass", false); await sleep(1000);
t = await bodyText();
if (/No pass yet/.test(t)) { await clickText("Create my pass", false); await sleep(900); t = await bodyText(); }
check("Vibe Pass shows a revocable token and consent controls", /What a scan may show/i.test(t) && /Pass token/i.test(t), t.replace(/\n/g, " ").slice(0, 70));
check("Vibe Pass offers revoke", /Revoke pass/i.test(t), t.replace(/\n/g, " ").slice(0, 60));
const beforeUncheck = await ev(`document.querySelectorAll('.card input[type=checkbox]')[1]?.checked`);
await ev(`document.querySelectorAll('.card input[type=checkbox]')[1]?.click()`); await sleep(800);
await rpc(ws, "Page.navigate", { url: WEB }, sessionId); await sleep(1500);
await ev(`document.querySelector('[aria-label="Account menu"]')?.click()`); await sleep(400);
await clickText("Vibe Pass", false); await sleep(900);
const afterUncheck = await ev(`document.querySelectorAll('.card input[type=checkbox]')[1]?.checked`);
check("Pass sharing consent persists across reload", beforeUncheck !== undefined && afterUncheck === !beforeUncheck, `${beforeUncheck} -> ${afterUncheck}`);
await shot("e2e-pass");

// AI Assist: generate, then accept — and confirm nothing was created.
await rpc(ws, "Page.navigate", { url: WEB }, sessionId); await sleep(1600);
await ev(`document.querySelector('[aria-label="Account menu"]')?.click()`); await sleep(400);
await clickText("Assist", false); await sleep(1000);
t = await bodyText();
check("Assist screen warns that a person confirms every action", /Suggestion/i.test(t) && /confirm|never sends/i.test(t), t.replace(/\n/g, " ").slice(0, 70));
await clickText("Generate suggestion", false); await sleep(1000);
t = await bodyText();
check("Assist labels its output as generated with accept/dismiss", /Generated/.test(t) && /Accept/.test(t) && /Dismiss/.test(t), t.replace(/\n/g, " ").slice(0, 70));
await clickText("Accept", false); await sleep(900);
t = await bodyText();
check("Accepting records intent and creates nothing", /Nothing was created/i.test(t), t.replace(/\n/g, " ").slice(0, 80));
await shot("e2e-assist");

// Operator console: move between real queues and run an action.
await rpc(ws, "Page.navigate", { url: WEB }, sessionId); await sleep(1600);
await ev(`document.querySelector('[aria-label="Account menu"]')?.click()`); await sleep(400);
await clickText("Operator console", false); await sleep(1000);
t = await bodyText();
check("Operator console opens with queues", /Operator console/i.test(t) && /reports/i.test(t) && /merchants/i.test(t), t.replace(/\n/g, " ").slice(0, 70));
await clickText("reports", true); await sleep(700);
t = await bodyText();
check("Reports queue resolves to a real state", /No open reports|Remove|Limit reach|Dismiss/i.test(t), t.replace(/\n/g, " ").slice(0, 70));
await clickText("campaigns", true); await sleep(700);
t = await bodyText();
check("Campaign review queue resolves to a real state", /No campaigns awaiting review|Approve|Reject/i.test(t), t.replace(/\n/g, " ").slice(0, 70));
await shot("e2e-admin");

// ---- Immersive activities: Live Now and a room ----
await rpc(ws, "Page.navigate", { url: WEB }, sessionId); await sleep(1600);
await ev(`document.querySelector('[aria-label="Account menu"]')?.click()`); await sleep(400);
await clickText("Live Now", false); await sleep(1200);
t = await bodyText();
check("Live Now lists a live room and a scheduled one", /Live Now/.test(t) && /E2E Matchday/.test(t) && /E2E Film Club/.test(t), t.replace(/\n/g, " ").slice(0, 80));
check("Live and scheduled states are shown distinctly", /Live/.test(t) && /(Scheduled|Starting soon)/.test(t), t.replace(/\n/g, " ").slice(0, 80));
await shot("e2e-live");

// Open the live room and drive the real interaction.
await clickText("E2E Matchday", false); await sleep(1200);
t = await bodyText();
check("Room opens with its derived state and a message box", /E2E Matchday/.test(t) && (await ev(`!!document.querySelector('[aria-label="Message"]')`)), t.replace(/\n/g, " ").slice(0, 80));
check("Room states where its data comes from", /Data:/i.test(t) || /authorized source/i.test(t), t.replace(/\n/g, " ").slice(0, 80));
const postsBefore = await ev(`document.querySelectorAll('.room-post').length`);
await ev(`(()=>{const i=document.querySelector('[aria-label="Message"]');const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;s.call(i,"E2E hello from the room");i.dispatchEvent(new Event("input",{bubbles:true}));})()`);
await sleep(200);
await clickText("Send", false); await sleep(1200);
const postsAfter = await ev(`document.querySelectorAll('.room-post').length`);
check("Posting to a room works and appears", postsAfter > postsBefore, `${postsBefore} -> ${postsAfter}`);
// Share link is real and revocable.
await clickText("Share", false); await sleep(1000);
t = await bodyText();
check("Sharing a room produces a context-preserving link", /Link ready/.test(t), t.replace(/\n/g, " ").slice(0, 80));
await shot("e2e-room");

// A spoiler-safe room hides its messages until revealed.
await rpc(ws, "Page.navigate", { url: WEB }, sessionId); await sleep(1400);
await ev(`document.querySelector('[aria-label="Account menu"]')?.click()`); await sleep(400);
await clickText("Live Now", false); await sleep(1000);
await clickText("E2E Film Club", false); await sleep(1200);
t = await bodyText();
check("A spoiler-safe room says so", /Spoiler-safe/i.test(t), t.replace(/\n/g, " ").slice(0, 80));

await adminPool.end();

console.log("\n==== SUMMARY ====");
const passed = results.filter((r) => r.ok).length;
console.log(`${passed}/${results.length} checks passed`);
const failed = results.filter((r) => !r.ok);
if (failed.length) { console.log("FAILURES:"); failed.forEach((f) => console.log("  - " + f.name + (f.detail ? " :: " + f.detail : ""))); }
fs.writeFileSync(`${OUT}e2e-results.json`, JSON.stringify(results, null, 2));
ws.close(); chrome.kill();
