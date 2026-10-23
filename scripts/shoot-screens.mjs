/**
 * Screenshot every top-level surface at three widths, so a layout review can be
 * done by looking at the product instead of reading its CSS.
 *
 *   AUDIT_TOKEN=<jwt> node scripts/shoot-screens.mjs http://localhost:12001
 *
 * Output: artifacts/screens/<width>/<screen>.png plus report.json with the
 * overflow/lap findings for the same pass (scripts/lib/probe-overflow.mjs).
 */
import puppeteer from "puppeteer-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { probeOverflow } from "./lib/probe-overflow.mjs";

const BASE = process.argv[2] ?? "http://localhost:12001";
const TOKEN = process.env.AUDIT_TOKEN ?? "";
const OUT = "artifacts/screens";
const WIDTHS = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
];

// [id, label to click, screen to open first]
const PAGES = [
  ["home", null],
  ["circles", "Circles"],
  ["play", "Play"],
  ["battles", "Battles", "Play"],
  ["explore", "Explore"],
  ["live", "Live"],
  ["you", "You"],
  ["status", "Standing", "You"],
  ["menu", "Menu"],
  ["create", "Create"],
];

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars"],
});

const report = {};

for (const vp of WIDTHS) {
  const dir = `${OUT}/${vp.name}`;
  mkdirSync(dir, { recursive: true });
  const page = await browser.newPage();
  await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 1 });

  const clickLabel = async (lbl) => {
    await page.evaluate((l) => {
      const navBtns = [...document.querySelectorAll("nav.bottom-nav button, .bottom-nav button")];
      const nav = navBtns.find((x) => (x.textContent || "").trim() === l);
      if (nav) { nav.click(); return; }
      const all = [...document.querySelectorAll("button")];
      const byAria = all.find((x) => (x.getAttribute("aria-label") || "").trim() === l);
      if (byAria) { byAria.click(); return; }
      const byText = all.find((x) => (x.textContent || "").trim() === l);
      byText?.click();
    }, lbl);
  };

  for (const [name, label, first] of PAGES) {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.evaluate((t) => localStorage.setItem("vibe.token", t), TOKEN);
    await page.goto(BASE + "/", { waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1400));
    if (first) { await clickLabel(first); await new Promise((r) => setTimeout(r, 1200)); }
    if (label) { await clickLabel(label); await new Promise((r) => setTimeout(r, 1600)); }
    await page.screenshot({ path: `${dir}/${name}.png`, fullPage: false }).catch(() => {});
    await page.screenshot({ path: `${dir}/${name}-full.png`, fullPage: true }).catch(() => {});
    report[`${vp.name}/${name}`] = await page.evaluate(probeOverflow).catch(() => null);
  }
  await page.close();
}

await browser.close();
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
for (const [key, r] of Object.entries(report)) {
  if (!r || !r.findings?.length) { console.log(`${key.padEnd(24)} clean`); continue; }
  const byKind = {};
  for (const f of r.findings) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
  console.log(`${key.padEnd(24)} ${String(r.findings.length).padStart(3)}  ${JSON.stringify(byKind)}`);
}
console.log(`\nscreenshots -> ${OUT}`);
