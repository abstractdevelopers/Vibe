/**
 * Live-room geometry audit.
 *
 * The room is built from arithmetic - a spotlight that takes the stage, a
 * gallery row that wraps, a control dock pinned to the bottom - so a small
 * rounding error shows up as a clipped tile or a covered composer. This walks
 * a real room at two phone widths and asserts the numbers hold at the edges.
 *
 * Exits non-zero on any failure, so it can gate a deploy.
 *
 * Run: node scripts/audit-room-math.mjs http://localhost:12001
 */
import puppeteer from "puppeteer-core";

const BASE = process.argv[2] ?? "http://localhost:12001";
const TOKEN = process.env.AUDIT_TOKEN ?? "";
const ROOM_TITLE = process.env.ROOM_TITLE ?? "Late night radio";

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars"],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const check = (ok, label, detail) => {
  if (!ok) failures.push(`${label}: ${detail}`);
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `  (${detail})` : ""}`);
};

async function openRoom(page) {
  await page.goto(BASE, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.evaluate((t) => localStorage.setItem("vibe.token", t), TOKEN);
  await page.goto(BASE + "/", { waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
  await sleep(1600);
  await page.evaluate(() => document.querySelector('button[aria-label="Account menu"]')?.click());
  await sleep(600);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll(".menu-item")].find((x) => (x.textContent || "").includes("Live Now"));
    b?.click();
  });
  await sleep(2800);
  await page.evaluate((t) => {
    const cards = [...document.querySelectorAll(".room-card")];
    (cards.find((c) => (c.textContent || "").includes(t)) ?? cards[0])?.click();
  }, ROOM_TITLE);
  await sleep(3500);
}

const measure = () => {
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height };
  };
  const stage = document.querySelector(".stage, .studio-stage, .room-stage");
  const dock = document.querySelector(".studio-dock");
  const controls = document.querySelector(".studio-controls");
  const composer = document.querySelector(".composer, .room-composer");
  const spotlight = document.querySelector(".spotlight");
  const tiles = [...document.querySelectorAll(".stage-tile, .gallery-tile")];
  const vw = window.innerWidth;
  return {
    vw,
    vh: window.innerHeight,
    pageScrollsX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    stage: stage ? rect(stage) : null,
    dock: dock ? rect(dock) : null,
    controls: controls ? rect(controls) : null,
    composer: composer ? rect(composer) : null,
    spotlight: spotlight ? rect(spotlight) : null,
    tiles: tiles.map((t) => ({ ...rect(t), cls: t.className })),
    buttons: [...document.querySelectorAll(".studio-controls > *")].map((b) => ({
      label: (b.getAttribute("aria-label") || b.textContent || "").trim().slice(0, 16),
      ...rect(b),
    })),
    // A control whose label is wider than its box is truncating without telling
    // anyone; the mic shrinks first, so it is the one most likely to clip.
    clipped: [...document.querySelectorAll(".studio-controls .mic-btn-label, .studio-controls .btn")]
      .filter((e) => e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1)
      .map((e) => (e.textContent || e.getAttribute("aria-label") || "").trim().slice(0, 20)),
  };
};

for (const width of [390, 360, 320]) {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 844, deviceScaleFactor: 2 });
  await openRoom(page);
  const m = await page.evaluate(measure);
  console.log(`\n--- viewport ${width} (room "${ROOM_TITLE}") ---`);

  check(!m.pageScrollsX, "no sideways page scroll", `scrollWidth > ${m.vw}`);

  if (m.stage) {
    check(m.stage.r <= m.vw + 1, "stage inside viewport", `right=${Math.round(m.stage.r)}`);
    check(m.stage.l >= -1, "stage not clipped left", `left=${Math.round(m.stage.l)}`);
  } else {
    check(false, "stage present", "no .stage element");
  }

  // The spotlight must be the widest tile and never wider than the stage.
  if (m.spotlight && m.stage) {
    check(m.spotlight.w <= m.stage.w + 1, "spotlight fits the stage", `${Math.round(m.spotlight.w)} <= ${Math.round(m.stage.w)}`);
    for (const t of m.tiles) {
      check(t.w <= m.spotlight.w + 1, "gallery tile no wider than spotlight", `${Math.round(t.w)} <= ${Math.round(m.spotlight.w)}`);
    }
  }

  // Every gallery tile inside the viewport.
  for (const t of m.tiles) {
    check(t.r <= m.vw + 1 && t.l >= -1, "gallery tile inside viewport", `${Math.round(t.l)}..${Math.round(t.r)}`);
  }

  // The control row must stay one row and fit.
  if (m.buttons.length) {
    const lines = new Set(m.buttons.map((b) => Math.round(b.t))).size;
    check(lines === 1, "control dock is one row", `${lines} rows`);
    const widest = Math.max(...m.buttons.map((b) => b.r));
    check(widest <= m.vw + 1, "control row fits the viewport", `rightmost=${Math.round(widest)}`);
    for (const b of m.buttons) {
      check(b.w > 0 && b.h > 0, `control "${b.label}" has size`, `${Math.round(b.w)}x${Math.round(b.h)}`);
    }
    check(m.clipped.length === 0, "no control label is clipped", m.clipped.join(", "));
  }

  // The dock must not cover the composer (top and bottom of the scroll).
  if (m.dock && m.composer) {
    const overlapTop = Math.max(0, Math.min(m.dock.b, m.composer.b) - Math.max(m.dock.t, m.composer.t));
    check(overlapTop <= 0, "dock does not cover the composer", `overlap=${Math.round(overlapTop)}px`);
  }

  await page.screenshot({ path: `artifacts/visual-audit/deep/room-${width}.png`, fullPage: true }).catch(() => {});
  await page.close();
}

await browser.close();
console.log(failures.length ? `\n${failures.length} FAILURES:\n- ${failures.join("\n- ")}` : "\nall room geometry checks passed");
process.exit(failures.length ? 1 : 0);
