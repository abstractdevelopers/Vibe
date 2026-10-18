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
];

const probe = () => {
  const vw = window.innerWidth;
  const findings = [];
  const desc = (el) => {
    const cls = (el.className || "").toString().slice(0, 60);
    const id = el.id ? `#${el.id}` : "";
    return `${el.tagName.toLowerCase()}${id}.${cls}`;
  };

  // 1. Anything overflowing the viewport on the x axis.
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.position === "fixed") continue;
    if (r.right > vw + 1) {
      findings.push({ kind: "overflow-right", el: desc(el), detail: `right=${Math.round(r.right)} vw=${vw}` });
    }
    if (r.left < -1) {
      findings.push({ kind: "overflow-left", el: desc(el), detail: `left=${Math.round(r.left)}` });
    }
  }

  // 2. A child wider than its parent's content box.
  for (const el of document.querySelectorAll("body *")) {
    const p = el.parentElement;
    if (!p || p === document.body) continue;
    const r = el.getBoundingClientRect();
    const pr = p.getBoundingClientRect();
    if (r.width === 0 || pr.width === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.position === "absolute" || cs.position === "fixed") continue;
    if (r.width > pr.width + 2 && pr.width > 0) {
      findings.push({ kind: "child-overflows-parent", el: desc(el), detail: `${Math.round(r.width)} > parent ${Math.round(pr.width)}` });
    }
  }

  // 3. Interactive elements with no visible surface: transparent background,
  //    no border, and no background image. These render but cannot be seen.
  for (const el of document.querySelectorAll("button, a, input, select, textarea")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0") continue;
    const bg = cs.backgroundColor;
    const transparent = bg === "rgba(0, 0, 0, 0)" || bg === "transparent";
    const noBorder = cs.borderTopWidth === "0px" && cs.borderBottomWidth === "0px";
    const noImage = cs.backgroundImage === "none";
    const hasText = (el.textContent || "").trim().length > 0;
    if (transparent && noBorder && noImage && hasText && el.tagName === "BUTTON") {
      findings.push({ kind: "invisible-button", el: desc(el), detail: el.textContent.trim().slice(0, 30) });
    }
  }

  // 4. Text overlapping other text (collision).
  const texts = [...document.querySelectorAll("body *")].filter((el) => {
    if (el.children.length > 0) return false;
    const t = (el.textContent || "").trim();
    if (!t) return false;
    const r = el.getBoundingClientRect();
    return r.width > 4 && r.height > 4;
  });
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i].getBoundingClientRect();
      const b = texts[j].getBoundingClientRect();
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ox > 3 && oy > 3) {
        // Ignore when one contains the other (normal nesting).
        if (texts[i].contains(texts[j]) || texts[j].contains(texts[i])) continue;
        findings.push({
          kind: "text-overlap",
          el: `${desc(texts[i])} <> ${desc(texts[j])}`,
          detail: `${Math.round(ox)}x${Math.round(oy)}`,
        });
      }
    }
  }

  return { url: location.href, viewport: { w: vw, h: window.innerHeight }, findings };
};

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
    // Click the bottom-nav button with this label, then wait for the screen.
    await page.evaluate((lbl) => {
      const btns = [...document.querySelectorAll("nav.bottom-nav button, .bottom-nav button")];
      const b = btns.find((x) => (x.textContent || "").trim() === lbl);
      if (b) b.click();
    }, label);
    await new Promise((r) => setTimeout(r, 2200));
  }
  report[name] = await page.evaluate(probe);
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
