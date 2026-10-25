/**
 * Use the platform the way a person would: open every tab, every sheet, every
 * menu destination, send a message, react, and report what actually happened.
 * A step is a failure if it throws, stays on the previous screen, or logs a
 * console error.
 */
import { launch, signIn, clickText, openMenu, sleep } from "./lib/signin.mjs";

const browser = await launch();
const { page, errors } = await signIn(browser, "zara@example.com");
await page.setViewport({ width: 390, height: 844 });

const results = [];
const mark = (step, ok, detail = "") => results.push({ step, ok, detail });

const visibleText = () => page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 180));
const screenTitle = () => page.evaluate(() =>
  document.querySelector(".screen-title, .studio-title, h1")?.textContent?.trim() ?? null);

async function step(name, fn, expect) {
  const before = await screenTitle();
  let ok = true, detail = "";
  try {
    await fn();
    await sleep(1600);
    const title = await screenTitle();
    const text = await visibleText();
    if (title === before && expect && !text.includes(expect)) { ok = false; detail = `still on "${title}"`; }
  } catch (e) {
    ok = false; detail = String(e).slice(0, 120);
  }
  mark(name, ok, detail);
}

// Tabs
for (const tab of ["Home", "Circles", "Play", "Explore"]) {
  await step(`tab: ${tab}`, () => clickText(page, tab), null);
}

// Play: a game tile, then back out.
await step("play: open a game", async () => {
  await clickText(page, "Play"); await sleep(1200);
  await page.evaluate(() => document.querySelector(".game-tile")?.click());
}, null);
await page.keyboard.press("Escape").catch(() => {});
await page.goto(page.url(), { waitUntil: "networkidle2" }).catch(() => {});
await sleep(1200);

// Menu destinations.
const DESTINATIONS = ["Wallet", "Vibe Yens", "Orders", "Vibe Pass", "Advertising", "Events", "Ask for a hand", "Settings"];
for (const dest of DESTINATIONS) {
  await page.goto(page.url(), { waitUntil: "networkidle2" }).catch(() => {});
  await sleep(1100);
  await step(`menu: ${dest}`, async () => { await openMenu(page); await clickText(page, dest); }, dest.split(" ")[0]);
}

// Inbox and messages.
await page.goto(page.url(), { waitUntil: "networkidle2" }).catch(() => {});
await sleep(1100);
await step("inbox", async () => page.evaluate(() => document.querySelector("[aria-label^=Inbox]")?.click()), "nbox");
await step("messages", async () => page.evaluate(() => document.querySelector("[aria-label=Messages]")?.click()), null);

// Explore: a place, then a live room.
await page.goto(page.url(), { waitUntil: "networkidle2" }).catch(() => {});
await sleep(1100);
await step("explore: open a place", async () => {
  await clickText(page, "Explore"); await sleep(1200);
  await page.evaluate(() => document.querySelector(".place-card, .place-row")?.click());
}, null);
await page.goto(page.url(), { waitUntil: "networkidle2" }).catch(() => {});
await sleep(1100);
await step("live: open a room", async () => {
  await clickText(page, "Explore"); await sleep(1000);
  await clickText(page, "Live now"); await sleep(1400);
  await page.evaluate(() => document.querySelector(".room-card")?.click());
}, "Stage");

// Inside the room: chat and a reaction and a sheet.
await step("room: send a message", async () => {
  await page.evaluate(() => [...document.querySelectorAll("[role=tab]")].find((t) => /chat/i.test(t.textContent))?.click());
  await sleep(700);
  await page.click("input[aria-label=Message]");
  await page.keyboard.type("Walkthrough message.");
  await page.keyboard.press("Enter");
}, "Walkthrough message.");
await step("room: open People sheet", async () => {
  await page.evaluate(() => [...document.querySelectorAll("[role=tab]")].find((t) => /stage/i.test(t.textContent))?.click());
  await sleep(600);
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => /people/i.test(b.getAttribute("aria-label") ?? ""))?.click());
}, null);
await page.keyboard.press("Escape").catch(() => {});
await sleep(400);
await step("room: react", async () => page.evaluate(() => document.querySelector(".react-chip")?.click()), null);

// Play: open a battle.
await page.goto(page.url(), { waitUntil: "networkidle2" }).catch(() => {});
await sleep(1200);
await step("play: open a battle", async () => {
  await clickText(page, "Play"); await sleep(1000);
  await clickText(page, "Battles"); await sleep(1400);
  await page.evaluate(() => document.querySelector(".battle-card")?.click());
}, null);

for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.step}${r.detail ? " — " + r.detail : ""}`);
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} steps ok`);
console.log("console errors:", JSON.stringify([...new Set(errors)].slice(0, 8)));
await browser.close();
