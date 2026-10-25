/**
 * Signed-in sweep of every sub-page, with a screenshot and a probe per page.
 * Uses the real sign-in form, so a page that fails to render shows up as a
 * finding or a console error rather than as a quietly blank shot.
 */
import { launch, signIn, clickText, openMenu, sleep } from "./lib/signin.mjs";
import { probeUi } from "./lib/probe-ui.mjs";
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = "artifacts/ui-audit-sub";
mkdirSync(OUT, { recursive: true });
const browser = await launch();

const SUBPAGES = [
  ["wallet", async (p) => { await openMenu(p); await clickText(p, "Wallet"); }],
  ["vibe-yens", async (p) => { await openMenu(p); await clickText(p, "Vibe Yens"); }],
  ["orders", async (p) => { await openMenu(p); await clickText(p, "Orders"); }],
  ["seller-orders", async (p) => { await openMenu(p); await clickText(p, "Seller"); }],
  ["pass", async (p) => { await openMenu(p); await clickText(p, "Vibe Pass"); }],
  ["advertising", async (p) => { await openMenu(p); await clickText(p, "Advertising"); }],
  ["events", async (p) => { await openMenu(p); await clickText(p, "Events"); }],
  ["assist", async (p) => { await openMenu(p); await clickText(p, "Ask for a hand"); }],
  ["status", async (p) => { await openMenu(p); await clickText(p, "Status"); }],
  ["edit-profile", async (p) => { await openMenu(p); await clickText(p, "Edit profile"); }],
  ["messages", async (p) => { await p.evaluate(() => document.querySelector("[aria-label=Messages]")?.click()); }],
  ["profile", async (p) => { await openMenu(p); await clickText(p, "Your space"); }],
  ["circle-detail", async (p) => { await clickText(p, "Circles"); await sleep(1200); await p.evaluate(() => document.querySelector(".circle-card, .circle-row")?.click()); }],
  ["place-detail", async (p) => { await clickText(p, "Explore"); await sleep(1200); await p.evaluate(() => document.querySelector(".place-card, .place-row")?.click()); }],
  ["event-detail", async (p) => { await openMenu(p); await clickText(p, "Events"); await sleep(1400); await p.evaluate(() => document.querySelector(".event-card, .event-row")?.click()); }],
  ["store", async (p) => { await openMenu(p); await clickText(p, "Orders"); await sleep(1200); await p.evaluate(() => document.querySelector(".store-card, .merchant-card")?.click()); }],
];

const report = {};
const errors = {};

for (const width of [390, 360, 1440]) {
  const { page, errors: pageErrors } = await signIn(browser, "zara@example.com");
  await page.setViewport({ width, height: width > 800 ? 900 : 844, deviceScaleFactor: 1 });
  await sleep(800);
  for (const [name, drive] of SUBPAGES) {
    await page.goto(page.url().split("#")[0], { waitUntil: "networkidle2" }).catch(() => {});
    await sleep(1200);
    try { await drive(page); } catch { /* a route may not exist for this account */ }
    await sleep(1600);
    const signedIn = await page.evaluate(() => !!document.querySelector(".bottom-nav") && !document.querySelector("#email"));
    if (!signedIn) { report[`${width}/${name}`] = { signedIn: false, findings: [] }; continue; }
    const res = await page.evaluate(probeUi).catch(() => null);
    const kept = res ? res.findings.filter((f) => f.kind !== "covered-control") : [];
    report[`${width}/${name}`] = { signedIn: true, findings: kept, url: page.url() };
    if (kept.length) await page.screenshot({ path: `${OUT}/${width}-${name}.png` }).catch(() => {});
  }
  errors[width] = pageErrors.slice(0, 5);
  await page.close();
}

writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
let total = 0;
for (const [k, v] of Object.entries(report)) {
  if (!v.signedIn) { console.log(k.padEnd(26), "NOT SIGNED IN"); continue; }
  if (v.findings.length) {
    total += v.findings.length;
    console.log(k.padEnd(26), v.findings.length, JSON.stringify(v.findings.map((f) => `${f.kind} ${f.el} ${f.detail ?? ""}`)).slice(0, 260));
  }
}
console.log(`\n${total} findings across ${Object.keys(report).length} renders`);
console.log("console errors:", JSON.stringify(errors));
await browser.close();
