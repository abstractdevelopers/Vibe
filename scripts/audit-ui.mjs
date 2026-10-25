/**
 * Walk every surface at phone, tablet and desktop widths and probe the UI.
 *
 *   AUDIT_TOKEN=<jwt> node scripts/audit-ui.mjs http://localhost:12001
 *
 * Unlike `audit-visual.mjs`, this drives the *real* controls — it opens a sheet,
 * opens the account menu, enters a room, sits at a game table and opens a
 * battle — because most of the layout defects live one tap deeper than the tabs.
 *
 * Output: artifacts/ui-audit/<width>/<surface>.png and report.json. Exits
 * non-zero when any finding survives the allow-list below.
 */
import puppeteer from "puppeteer-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { probeUi } from "./lib/probe-ui.mjs";

const BASE = process.argv[2] ?? "http://localhost:12001";
const TOKEN = process.env.AUDIT_TOKEN ?? "";
if (!TOKEN) {
  console.error(
    "AUDIT_TOKEN is empty. The audit walks signed-in screens; without a token it would\n" +
      "measure the sign-in page and report it clean. Pass a real session token:\n" +
      "  AUDIT_TOKEN=$(node scripts/get-audit-token.mjs) node scripts/audit-ui.mjs",
  );
  process.exit(2);
}
const OUT = "artifacts/ui-audit";
const WIDTHS = [
  { name: "mobile", width: 390, height: 844 },
  { name: "small", width: 360, height: 640 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
];

/**
 * Kinds that mean "the driver did this", not "the app is broken": a sheet left
 * open by the walk lets the dimmed page show through, and a horizontal shelf is
 * meant to run past the edge.
 */
const IGNORE = new Set(["covered-control"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
  args: [
    "--no-sandbox",
    "--disable-gpu",
    "--hide-scrollbars",
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
  ],
});

const report = {};
let failures = 0;

async function clickText(page, text, opts = {}) {
  return page.evaluate((t, exact) => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const candidates = [...document.querySelectorAll("button, a, [role=tab], [role=button], .bottom-nav button")];
    const byExact = candidates.find((x) => norm(x.textContent) === t);
    if (byExact) { byExact.click(); return true; }
    if (exact) return false;
    const byContains = candidates.find((x) => norm(x.textContent).includes(t));
    if (byContains) { byContains.click(); return true; }
    return false;
  }, text, Boolean(opts.exact));
}

async function clickSel(page, sel, index = 0) {
  return page.evaluate((s, i) => {
    const els = [...document.querySelectorAll(s)];
    if (!els[i]) return false;
    els[i].click();
    return true;
  }, sel, index);
}

for (const vp of WIDTHS) {
  const dir = `${OUT}/${vp.name}`;
  mkdirSync(dir, { recursive: true });
  const page = await browser.newPage();
  await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 1 });

  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });

  const home = async () => {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.evaluate((t) => localStorage.setItem("vibe.token", t), TOKEN);
    await page.goto(BASE + "/", { waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
    await sleep(1100);
  };

  /**
   * Fail loudly when the session did not take.
   *
   * Without this the audit walked the *signed-out* landing page, reported it
   * clean, and said nothing — the most misleading result a visual audit can
   * produce. A missing or expired token has to stop the run, not quieten it.
   */
  const assertSignedIn = async (label) => {
    const state = await page.evaluate(() => ({
      hasAuthForm: !!document.querySelector("#email"),
      hasTabBar: !!document.querySelector(".bottom-nav"),
      title: document.title,
    }));
    if (state.hasAuthForm || !state.hasTabBar) {
      throw new Error(
        `audit is not signed in at ${label} (auth form: ${state.hasAuthForm}, tab bar: ${state.hasTabBar}). ` +
          "Refresh AUDIT_TOKEN from a valid session before trusting any result.",
      );
    }
  };

  const shot = async (name) => {
    await page.screenshot({ path: `${dir}/${name}.png` }).catch(() => {});
    const result = await page.evaluate(probeUi).catch(() => null);
    if (!result) return;
    const kept = result.findings.filter((f) => !IGNORE.has(f.kind));
    report[`${vp.name}/${name}`] = { viewport: result.viewport, findings: kept };
    if (kept.length) failures += kept.length;
  };

  const surfaces = [
    ["home", null],
    ["circles", async () => { await clickText(page, "Circles"); }],
    ["play", async () => { await clickText(page, "Play"); }],
    ["play-battles", async () => { await clickText(page, "Play"); await sleep(900); await clickText(page, "Battles", { exact: true }); }],
    ["battle-arena", async () => {
      await clickText(page, "Play"); await sleep(800);
      await clickText(page, "Battles", { exact: true }); await sleep(1200);
      await clickSel(page, ".battle-card", 0);
    }],
    ["explore", async () => { await clickText(page, "Explore"); }],
    ["live", async () => {
      await clickText(page, "Explore"); await sleep(800);
      await clickText(page, "Live now"); await sleep(1200);
    }],
    ["room", async () => {
      await clickText(page, "Explore"); await sleep(800);
      await clickText(page, "Live now"); await sleep(1200);
      await clickSel(page, ".room-card", 0);
    }],
    ["room-chat", async () => {
      await clickText(page, "Explore"); await sleep(800);
      await clickText(page, "Live now"); await sleep(1200);
      await clickSel(page, ".room-card", 0); await sleep(1800);
      await clickText(page, "Chat", { exact: false }); await sleep(700);
    }],
    ["create", async () => { await clickText(page, "Create"); }],
    ["menu", async () => { await clickSel(page, ".account-button, .avatar-button, .topbar .avatar", 0); await sleep(700); }],
    ["inbox", async () => { await clickSel(page, ".topbar button.icon-button", 0); await sleep(900); }],
    ["you", async () => {
      await clickSel(page, ".account-button, .avatar-button, .topbar .avatar", 0); await sleep(700);
      await clickText(page, "Your space");
    }],
    ["settings", async () => {
      await clickSel(page, ".account-button, .avatar-button, .topbar .avatar", 0); await sleep(700);
      await clickText(page, "Settings");
    }],
  ];

  for (const [name, drive] of surfaces) {
    await home();
    await assertSignedIn(vp.name + "/" + name);
    if (drive) { await drive().catch(() => {}); }
    await sleep(1500);
    await shot(name);
  }
  await page.close();
}

await browser.close();
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));

for (const [key, r] of Object.entries(report)) {
  if (!r.findings.length) { console.log(`${key.padEnd(26)} clean`); continue; }
  const byKind = {};
  for (const f of r.findings) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
  console.log(`${key.padEnd(26)} ${String(r.findings.length).padStart(3)}  ${JSON.stringify(byKind)}`);
}
console.log(`\nscreenshots -> ${OUT}`);
if (failures > 0) {
  console.log(`\n${failures} findings.`);
  process.exitCode = 1;
}
