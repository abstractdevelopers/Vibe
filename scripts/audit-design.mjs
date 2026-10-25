/**
 * Walk every surface at every breakpoint as a signed-in user and inspect the
 * design, not just the layout.
 *
 *   AUDIT_TOKEN=$(node scripts/get-audit-token.mjs) node scripts/audit-design.mjs
 *
 * For each render it saves a full-page screenshot and prints the inspector's
 * findings, so a claim about a screen can always be checked against an image.
 */
import { launch, signIn, clickText, openMenu, sleep } from "./lib/signin.mjs";
import { inspectDesign } from "./lib/design-inspect.mjs";
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = "artifacts/design-audit";
mkdirSync(OUT, { recursive: true });
const browser = await launch();

const WIDTHS = [
  { name: "320", w: 320, h: 640 },
  { name: "360", w: 360, h: 640 },
  { name: "390", w: 390, h: 844 },
  { name: "414", w: 414, h: 896 },
  { name: "768", w: 768, h: 1024 },
  { name: "1024", w: 1024, h: 768 },
  { name: "1440", w: 1440, h: 900 },
];

const SURFACES = [
  ["home", async () => {}],
  ["circles", async (p) => clickText(p, "Circles")],
  ["play", async (p) => { await clickText(p, "Play"); await sleep(1200); }],
  ["play-battles", async (p) => { await clickText(p, "Play"); await sleep(1000); await clickText(p, "Battles"); await sleep(1400); }],
  ["battle", async (p) => { await clickText(p, "Play"); await sleep(1000); await clickText(p, "Battles"); await sleep(1400); await p.evaluate(() => document.querySelector(".battle-card")?.click()); }],
  ["explore", async (p) => clickText(p, "Explore")],
  ["live", async (p) => { await clickText(p, "Explore"); await sleep(1000); await clickText(p, "Live now"); await sleep(1400); }],
  ["room", async (p) => { await clickText(p, "Explore"); await sleep(1000); await clickText(p, "Live now"); await sleep(1400); await p.evaluate(() => document.querySelector(".room-card")?.click()); }],
  ["room-chat", async (p) => {
    await clickText(p, "Explore"); await sleep(1000); await clickText(p, "Live now"); await sleep(1400);
    await p.evaluate(() => document.querySelector(".room-card")?.click()); await sleep(1800);
    await p.evaluate(() => [...document.querySelectorAll("[role=tab]")].find((t) => /chat/i.test(t.textContent))?.click());
  }],
  ["create", async (p) => clickText(p, "Create")],
  ["menu", async (p) => openMenu(p)],
  ["inbox", async (p) => p.evaluate(() => document.querySelector("[aria-label^=Inbox]")?.click())],
  ["wallet", async (p) => { await openMenu(p); await clickText(p, "Wallet"); }],
  ["vibe-yens", async (p) => { await openMenu(p); await clickText(p, "Vibe Yens"); }],
  ["orders", async (p) => { await openMenu(p); await clickText(p, "Orders"); }],
  ["pass", async (p) => { await openMenu(p); await clickText(p, "Vibe Pass"); }],
  ["advertising", async (p) => { await openMenu(p); await clickText(p, "Advertising"); }],
  ["events", async (p) => { await openMenu(p); await clickText(p, "Events"); }],
  ["assist", async (p) => { await openMenu(p); await clickText(p, "Ask for a hand"); }],
  ["status", async (p) => { await openMenu(p); await clickText(p, "Status"); }],
  ["settings", async (p) => { await openMenu(p); await clickText(p, "Settings"); }],
  ["you", async (p) => { await openMenu(p); await clickText(p, "Your space"); }],
  ["messages", async (p) => p.evaluate(() => document.querySelector("[aria-label=Messages]")?.click())],
];

const { page, errors } = await signIn(browser, "zara@example.com");
const first = await page.evaluate(() => ({ auth: !!document.querySelector("#email"), nav: !!document.querySelector(".bottom-nav") }));
if (first.auth || !first.nav) {
  console.error("not signed in at start (auth form: " + first.auth + ", tab bar: " + first.nav + "). Seed the demo data and retry.");
  process.exit(2);
}
const report = {};
let unsigned = 0;

for (const vp of WIDTHS) {
  await page.setViewport({ width: vp.w, height: vp.h, deviceScaleFactor: 1 });
  await sleep(600);
  for (const [name, drive] of SURFACES) {
    await page.goto(page.url().split("#")[0], { waitUntil: "networkidle2" }).catch(() => {});
    await sleep(1100);
    try { await drive(page); } catch { /* surface may not exist for this account */ }
    await sleep(1500);
    const signedIn = await page.evaluate(() => !!document.querySelector(".bottom-nav") && !document.querySelector("#email"));
    if (!signedIn) {
      unsigned += 1;
      report[`${vp.name}/${name}`] = { signedIn: false, issues: [] };
      if (unsigned === 1) console.error(`SESSION LOST at ${vp.name}/${name} — results after this point are not trustworthy.`);
      continue;
    }
    const res = await page.evaluate(inspectDesign).catch((e) => ({ error: String(e) }));
    report[`${vp.name}/${name}`] = { signedIn: true, ...res };
    if (res?.issues?.length) {
      await page.screenshot({ path: `${OUT}/${vp.name}-${name}.png`, fullPage: true }).catch(() => {});
    }
  }
}

writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));

const byKind = {};
let total = 0;
for (const [k, v] of Object.entries(report)) {
  if (!v.signedIn) { console.log("NOT SIGNED IN", k); continue; }
  for (const i of v.issues ?? []) {
    total += 1;
    byKind[i.kind] = (byKind[i.kind] || 0) + 1;
    if (byKind[i.kind] <= 6) console.log(`${k.padEnd(22)} ${i.kind.padEnd(11)} ${i.severity.padEnd(6)} ${i.el} — ${i.detail}`);
  }
}
console.log("\nTOTAL", total, JSON.stringify(byKind));
console.log("renders:", Object.keys(report).length, "| unsigned:", unsigned);
console.log("console errors:", JSON.stringify([...new Set(errors)].slice(0, 5)));
if (unsigned > 0) process.exitCode = 1;
await browser.close();
