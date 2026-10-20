import { probeOverflow } from "./lib/probe-overflow.mjs";
/**
 * Visual bleed audit.
 *
 * Visits every screen in the running app and reports, per page:
 *  - elements that overflow the viewport horizontally (bleeding out)
 *  - elements wider than their parent's content box (collision / bad layout)
 *  - text nodes overlapping another element's text (collision)
 *  - interactive elements with zero effective background and no border where a
 *    fill is expected (the "invisible element" bleed)
 *
 * Run against a local dev server: node scripts/audit-visual.mjs http://localhost:5173
 */
import puppeteer from "puppeteer-core";
import { writeFileSync, mkdirSync } from "node:fs";

const BASE = process.argv[2] ?? "http://localhost:5173";
const OUT = "artifacts/visual-audit";
mkdirSync(OUT, { recursive: true });

const TOKEN = process.env.AUDIT_TOKEN ?? "";

// The app has no URL routing for tabs, so drive the real nav buttons.
const PAGES = [
  ["home", null],
  ["circles", "Circles"],
  ["play", "Play"],
  ["explore", "Explore"],
  ["live", "Live"],
  ["battles", "Battles"],
  ["you", "You"],
  // The header menu, where "Start something" and Settings live.
  ["menu", "Menu"],
  // The composer hub, reached from the centre create button.
  ["create", "Create"],
];



const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars"],
});

const report = {};
for (const [name, label] of PAGES) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  if (TOKEN) {
    await page.goto(BASE, { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.evaluate((t) => localStorage.setItem("vibe.token", t), TOKEN);
  }
  await page.goto(BASE + "/", { waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  if (label) {
    // Prefer the bottom nav; fall back to any button whose label or aria-label
    // matches, which is how the header menu and the centre create button open.
    await page.evaluate((lbl) => {
      const navBtns = [...document.querySelectorAll("nav.bottom-nav button, .bottom-nav button")];
      const nav = navBtns.find((x) => (x.textContent || "").trim() === lbl);
      if (nav) { nav.click(); return; }
      const all = [...document.querySelectorAll("button")];
      const byAria = all.find((x) => (x.getAttribute("aria-label") || "").trim() === lbl);
      if (byAria) { byAria.click(); return; }
      const byText = all.find((x) => (x.textContent || "").trim() === lbl);
      byText?.click();
    }, label);
    await new Promise((r) => setTimeout(r, 2200));
  }
  report[name] = await page.evaluate(probeOverflow);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true }).catch(() => {});
  await page.close();
}
await browser.close();

writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
let total = 0;
for (const [name, r] of Object.entries(report)) {
  const byKind = {};
  for (const f of r.findings) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
  total += r.findings.length;
  console.log(`${name.padEnd(10)} ${String(r.findings.length).padStart(3)} findings  ${JSON.stringify(byKind)}`);
}
console.log(`\ntotal: ${total} findings -> ${OUT}/report.json`);
