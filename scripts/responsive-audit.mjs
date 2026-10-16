import puppeteer from "puppeteer-core";

const BASE = process.env.AUDIT_URL ?? "https://4odwboyulnfdthdlv9hzrguf.172.104.128.165.sslip.io";
const TOKEN = process.env.AUDIT_TOKEN ?? "";
const WIDTHS = [320, 360, 390, 414];

async function main() {
  const browser = await puppeteer.launch({
    executablePath: "/usr/bin/chromium",
    headless: "new",
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("  PAGE ERROR:", e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.log("  CONSOLE ERROR:", m.text().slice(0, 200));
  });

  await page.setViewport({ width: 390, height: 900 });
  await page.goto(BASE, { waitUntil: "networkidle2", timeout: 60000 });
  if (TOKEN) {
    await page.evaluate((t) => localStorage.setItem("vibe.token", t), TOKEN);
    await page.reload({ waitUntil: "networkidle2" });
  }

  const tabs = ["Home", "Explore", "Circles", "You"];
  const menuItems = [
    "View profile",
    "Edit profile",
    "Start something",
    "Events",
    "Live Now",
    "Vibe Pass",
    "Assist",
    "Wallet",
    "Orders",
    "Advertising",
    "Settings",
  ];

  const problems = [];
  let checked = 0;

  async function audit(label) {
    await new Promise((r) => setTimeout(r, 650));
    const result = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const doc = document.documentElement.scrollWidth;
      // An element is only a problem if it escapes the viewport AND no ancestor
      // is a deliberate horizontal scroller (a chip rail, the action bar).
      function inScroller(el) {
        let p = el.parentElement;
        while (p && p !== document.body) {
          const cs = getComputedStyle(p);
          if (/(auto|scroll|hidden)/.test(cs.overflowX)) return true;
          p = p.parentElement;
        }
        return false;
      }
      const offenders = [];
      for (const el of document.querySelectorAll("body *")) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        const cs = getComputedStyle(el);
        if (cs.position === "fixed") continue;
        if (r.right <= vw + 1 && r.left >= -1) continue;
        if (inScroller(el)) continue;
        offenders.push({
          tag: el.tagName.toLowerCase(),
          cls: (el.className && el.className.toString().slice(0, 50)) || "",
          left: Math.round(r.left),
          right: Math.round(r.right),
          text: (el.textContent || "").trim().slice(0, 36),
        });
      }
      const seen = new Map();
      for (const o of offenders) {
        const key = o.tag + "|" + o.cls;
        const over = Math.max(o.right - vw, -o.left);
        const prev = seen.get(key);
        if (!prev || over > prev.over) seen.set(key, { ...o, over });
      }
      return {
        vw,
        docOverflow: doc - vw,
        offenders: [...seen.values()].sort((a, b) => b.over - a.over).slice(0, 6),
      };
    });
    checked++;
    const bad = result.docOverflow > 1 || result.offenders.length > 0;
    if (bad) {
      problems.push({ label, ...result });
      console.log(`  OVERFLOW ${label}: doc+${result.docOverflow}`);
      for (const o of result.offenders) {
        console.log(`      ${o.tag}.${o.cls} [${o.left}..${o.right}] over=${o.over} "${o.text}"`);
      }
    }
  }

  for (const w of WIDTHS) {
    await page.setViewport({ width: w, height: 900 });
    console.log(`\n=== ${w}px ===`);
    for (const t of tabs) {
      await page.goto(BASE, { waitUntil: "networkidle2" });
      await clickText(page, t);
      await audit(`${w}px ${t}`);
    }
    for (const m of menuItems) {
      await page.goto(BASE, { waitUntil: "networkidle2" });
      try {
        await page.click('[aria-label="Account menu"]');
        await new Promise((r) => setTimeout(r, 250));
        await clickText(page, m);
      } catch (e) {
        console.log(`  (skip ${w}px ${m}: ${e.message.slice(0, 60)})`);
        continue;
      }
      await audit(`${w}px menu:${m}`);
    }
  }

  console.log("\n==== SUMMARY ====");
  console.log(`Screens checked: ${checked}, problems: ${problems.length}`);
  await browser.close();
  process.exit(problems.length ? 1 : 0);
}

async function clickText(page, text) {
  const clicked = await page.evaluate((t) => {
    const nodes = [...document.querySelectorAll("button, a")];
    const el = nodes.find((n) => (n.textContent || "").trim() === t);
    if (el) {
      el.click();
      return true;
    }
    return false;
  }, text);
  if (!clicked) throw new Error(`no element with text "${text}"`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
