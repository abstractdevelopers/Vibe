import puppeteer from "puppeteer-core";
const BASE = process.env.AUDIT_URL;
const TOKEN = process.env.AUDIT_TOKEN;
const sizes = [[320, 568], [360, 640], [390, 844], [414, 896]];
const b = await puppeteer.launch({ executablePath: "/usr/bin/chromium", headless: "new", args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
const p = await b.newPage();
await p.setViewport({ width: 390, height: 900 });
await p.goto(BASE, { waitUntil: "networkidle2" });
await p.evaluate((t) => localStorage.setItem("vibe.token", t), TOKEN);
for (const [w, h] of sizes) {
  await p.setViewport({ width: w, height: h });
  await p.goto(BASE, { waitUntil: "networkidle2" });
  await p.click('[aria-label="Account menu"]');
  await new Promise((r) => setTimeout(r, 400));
  const m = await p.evaluate(() => {
    const el = document.querySelector(".menu");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height), vh: window.innerHeight,
      maxH: cs.maxHeight, overflowY: cs.overflowY,
      parentOverflow: getComputedStyle(el.parentElement).overflow,
      scrollable: el.scrollHeight > el.clientHeight,
    };
  });
  console.log(`${w}x${h}`, JSON.stringify(m));
}
await b.close();
