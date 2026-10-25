/**
 * Sign in through the real form, then hand back the page.
 * Reused by the voice tests and the walkthrough.
 */
import puppeteer from "puppeteer-core";

export const BASE = process.env.BASE ?? "http://localhost:12001";
export const CHROME = process.env.CHROME_PATH ?? "/usr/bin/chromium";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch(browser) {
  const b = browser ?? await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-gpu", "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  });
  await b.defaultBrowserContext().overridePermissions(BASE, ["microphone"]);
  return b;
}

export async function signIn(browser, email, password = "password123", { init } = {}) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 390, height: 844 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 200)));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon/.test(m.text())) errors.push(m.text().slice(0, 200)); });
  if (init) await page.evaluateOnNewDocument(init);
  await page.goto(BASE + "/", { waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
  await sleep(700);

  // The landing screen offers "Log in"; the form only exists once that opens.
  if (!(await page.$("#email"))) {
    await clickText(page, "Log in", { exact: true });
    await page.waitForSelector("#email", { timeout: 10000 }).catch(() => {});
  }
  await page.waitForSelector("#email", { timeout: 10000 });
  await page.type("#email", email);
  await page.type("#password", password);

  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/v1/auth/login"), { timeout: 20000 }).catch(() => null),
    page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((b) => /^log in$/i.test(b.textContent.trim()));
      btn?.click();
    }),
  ]);
  if (res) {
    const body = await res.json().catch(() => null);
    if (res.status() !== 200) errors.push(`login ${res.status()}: ${JSON.stringify(body).slice(0, 160)}`);
  } else {
    errors.push("login request never fired");
  }
  await page.waitForFunction(() => !document.querySelector("#email"), { timeout: 15000 }).catch(() => {});
  await sleep(1500);
  return { page, errors };
}

export async function clickText(page, text, opts = {}) {
  return page.evaluate((t, exact) => {
    const els = [...document.querySelectorAll("button, a, [role=button], [role=menuitem], [role=tab]")];
    const el = els.find((e) => (exact ? e.textContent.trim() === t : e.textContent.includes(t)));
    if (!el) return false;
    el.click();
    return true;
  }, text, !!opts.exact);
}

export async function openMenu(page) {
  await page.evaluate(() => {
    const el = document.querySelector(".account-button, .avatar-button, .topbar .avatar");
    el?.click();
  });
  await sleep(700);
}

export async function enterRoom(page, title) {
  await clickText(page, "Explore"); await sleep(900);
  await clickText(page, "Live now"); await sleep(1400);
  return page.evaluate((t) => {
    const cards = [...document.querySelectorAll(".room-card")];
    const target = cards.find((c) => c.textContent.includes(t)) ?? cards[0];
    if (!target) return false;
    target.click();
    return true;
  }, title);
}
