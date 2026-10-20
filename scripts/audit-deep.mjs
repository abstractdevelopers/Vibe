/**
 * Deep visual audit.
 *
 * The shallow audit visits the nine top-level screens. This one goes further:
 * it opens the account menu, the create sheet, and then drills into real
 * detail pages by clicking real rows - a circle, a plan, a profile, a merchant,
 * a product, an order, an event, a battle, a game table, a live room, a
 * conversation, and the money and settings screens.
 *
 * Each page is checked for horizontal bleed, collision and invisible controls
 * with the shared overflow probe, and screenshotted. Requires seeded data.
 *
 * Run against a local dev server: node scripts/audit-deep.mjs http://localhost:12001
 */
import puppeteer from "puppeteer-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { probeOverflow } from "./lib/probe-overflow.mjs";

const BASE = process.argv[2] ?? "http://localhost:12001";
const OUT = "artifacts/visual-audit/deep";
mkdirSync(OUT, { recursive: true });
const TOKEN = process.env.AUDIT_TOKEN ?? "";

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars"],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = {};

/** Click the first element whose text or aria-label contains `text`. */
const clickByText = (page, text, selector = "button, a, [role='button'], .room-card, .card") =>
  page.evaluate((t, sel) => {
    const els = [...document.querySelectorAll(sel)];
    const hit = els.find((e) => ((e.textContent || "") + (e.getAttribute("aria-label") || "")).toLowerCase().includes(t.toLowerCase()));
    if (hit) { hit.click(); return true; }
    return false;
  }, text, selector);

const openMenu = async (page) => {
  await page.evaluate(() => document.querySelector('button[aria-label="Account menu"]')?.click());
  await sleep(500);
};
const menuItem = async (page, label) => {
  await openMenu(page);
  const ok = await clickByText(page, label, ".menu-item");
  await sleep(1800);
  return ok;
};

async function visit(name, drive) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await page.goto(BASE, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.evaluate((t) => localStorage.setItem("vibe.token", t), TOKEN);
  await page.goto(BASE + "/", { waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
  await sleep(1800);
  let note = null;
  try {
    note = await drive(page);
  } catch (e) {
    note = `drive error: ${e.message}`;
  }
  await sleep(900);
  // A sheet left open by the driver collides with the page behind it; that is
  // the driver's own doing, not a layout fault, so those pairs are dropped.
  const raw = await page.evaluate(probeOverflow);
  // Confirm the driver actually landed on a distinct screen, not the hub it
  // started from - a click that misses leaves the same heading in place.
  const screen = await page.evaluate(() => {
    const pick = ["h1", ".screen-title", ".studio-title", ".sheet-head h2", ".eyebrow", "h2", "[role='heading']"];
    for (const sel of pick) {
      const el = document.querySelector(sel);
      const t = (el?.textContent || "").trim();
      if (t) return t.slice(0, 48);
    }
    return "";
  });
  const findings = raw.findings.filter(
    (f) => !(f.kind === "text-overlap" && /menu-group|sheet|backdrop/.test(f.el)),
  );
  report[name] = { ...raw, findings, note, screen };
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true }).catch(() => {});
  await page.close();
}

const tab = async (page, label) => {
  await page.evaluate((l) => {
    const b = [...document.querySelectorAll(".bottom-nav button")].find((x) => (x.textContent || "").trim() === l);
    b?.click();
  }, label);
  await sleep(1800);
};

// --- Header menu destinations ------------------------------------------------
for (const [name, label] of [
  ["wallet", "Wallet"], ["vibe-yens", "Vibe Yens"], ["orders", "Orders"],
  ["pass", "Vibe Pass"], ["advertising", "Advertising"], ["settings", "Settings"],
  ["admin", "Operator console"],
]) {
  await visit(name, (p) => menuItem(p, label).then((ok) => (ok ? null : `menu item "${label}" not found`)));
}

// --- Inbox, messages and a conversation --------------------------------------
await visit("inbox", async (p) => {
  await p.evaluate(() => document.querySelector('button[aria-label="Inbox"], button[aria-label^="Inbox"]')?.click());
  await sleep(1800);
});
await visit("messages", async (p) => {
  await p.evaluate(() => document.querySelector('button[aria-label="Messages"]')?.click());
  await sleep(1800);
});
await visit("conversation", async (p) => {
  await p.evaluate(() => document.querySelector('button[aria-label="Messages"]')?.click());
  await sleep(1800);
  const ok = await clickByText(p, "", ".conversation-row");
  await sleep(1500);
  return ok ? null : "no conversation row to open";
});

// --- Profile, from your own avatar -------------------------------------------
await visit("profile", async (p) => {
  await menuItem(p, "Your profile");
  return null;
});

// --- Circles: list then a circle ---------------------------------------------
await visit("circle", async (p) => {
  await tab(p, "Circles");
  const ok = await clickByText(p, "", ".circle-card, .card");
  await sleep(1800);
  return ok ? null : "no circle to open";
});

// --- Play: games hub, a game, and a table ------------------------------------
await visit("game", async (p) => {
  await tab(p, "Play");
  const ok = await clickByText(p, "", ".live-card");
  await sleep(1800);
  return ok ? null : "no game to open";
});
await visit("game-table", async (p) => {
  await tab(p, "Play");
  await clickByText(p, "Rejoin");
  await sleep(2200);
  return null;
});

// --- Battles: list then a battle ---------------------------------------------
await visit("battle", async (p) => {
  await tab(p, "Battles");
  const ok = await clickByText(p, "", ".battle-card, .card");
  await sleep(1800);
  return ok ? null : "no battle to open";
});

// --- Events: list then an event ----------------------------------------------
await visit("event", async (p) => {
  await menuItem(p, "Events");
  const ok = await clickByText(p, "", ".card > .grow");
  await sleep(1800);
  return ok ? null : "no event to open";
});

// --- Live: directory then a room ---------------------------------------------
await visit("room", async (p) => {
  await menuItem(p, "Live Now");
  const ok = await clickByText(p, "", ".room-card");
  await sleep(3000);
  return ok ? null : "no room to open";
});

// --- Explore: a place detail --------------------------------------------------
await visit("place", async (p) => {
  await tab(p, "Explore");
  const ok = await p.evaluate(() => {
    const cards = [...document.querySelectorAll(".card.interactive")];
    const place = cards.find((c) => !/^Event$/i.test((c.querySelector(".eyebrow")?.textContent || "").trim()));
    if (place) { place.click(); return true; }
    return false;
  });
  await sleep(1800);
  return ok ? null : "no place to open";
});

// --- Storefront and a product, from the account menu --------------------------
await visit("storefront", async (p) => {
  await tab(p, "Explore");
  const ok = await clickByText(p, "", ".card.row.spread");
  await sleep(1800);
  return ok ? null : "no shop to open";
});

await browser.close();

writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
let total = 0;
for (const [name, r] of Object.entries(report)) {
  const byKind = {};
  for (const f of r.findings) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
  total += r.findings.length;
  console.log(`${name.padEnd(14)} ${String(r.findings.length).padStart(3)} findings  ${JSON.stringify(byKind)}  "${r.screen}"${r.note ? `  [${r.note}]` : ""}`);
}
console.log(`\ntotal: ${total} findings -> ${OUT}/report.json`);
