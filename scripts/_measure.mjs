/**
 * Generic mobile measurement + overflow probe for one screen.
 *   node scripts/_measure.mjs "<BottomNavLabel>" [waitMs]
 * Assumes the audit user is seeded and /tmp/audit_token.txt holds the token.
 */
import puppeteer from "puppeteer-core";
import { readFileSync } from "node:fs";
import { probeOverflow } from "./lib/probe-overflow.mjs";

const BASE = process.env.AUDIT_URL || "http://localhost:12001";
const LABEL = process.argv[2];
const WAIT = Number(process.argv[3] ?? 2600);
const TOKEN = readFileSync("/tmp/audit_token.txt", "utf8").trim();
const b = await puppeteer.launch({ executablePath: "/usr/bin/chromium", headless: "new", args: ["--no-sandbox","--disable-gpu","--disable-dev-shm-usage"] });

for (const [W, H] of [[390,844],[360,640],[320,568]]) {
  const p = await b.newPage();
  await p.setViewport({ width: W, height: H, deviceScaleFactor: 2 });
  await p.goto(BASE, { waitUntil: "networkidle2" });
  await p.evaluate((t) => localStorage.setItem("vibe.token", t), TOKEN);
  await p.goto(BASE + "/", { waitUntil: "networkidle2" });
  await new Promise(r=>setTimeout(r,WAIT));
  const ok = await p.evaluate((label)=>{
    const el=[...document.querySelectorAll(".bottom-nav button")].find(x=>(x.textContent||"").trim()===label);
    if(el){el.click();return true;} return false;
  }, LABEL);
  await new Promise(r=>setTimeout(r,WAIT));
  const info = await p.evaluate(()=>{
    const shelves=[...document.querySelectorAll(".shelf")];
    const gaps=shelves.map((s,i)=>{ if(i===0)return null; const prev=shelves[i-1].getBoundingClientRect(); return Math.round(s.getBoundingClientRect().top-prev.bottom); });
    return {
      title:(document.querySelector(".screen-title")?.textContent||"").trim(),
      shelves: shelves.map(s=>(s.querySelector(".section-title")?.textContent||"").trim()),
      shelfGaps: gaps,
      rows: document.querySelectorAll(".result-row").length,
      docH: document.documentElement.scrollHeight,
      docW: document.documentElement.scrollWidth, vw: window.innerWidth,
    };
  });
  const probe = await p.evaluate(probeOverflow);
  const findings = probe.findings.filter(f=>!f.el.includes("svg"));
  console.log(`\n=== ${W}x${H} (${LABEL}, clicked: ${ok}) ===`);
  console.log(JSON.stringify(info));
  console.log("overflow:", findings.length? JSON.stringify(findings.slice(0,6)) : "none");
  await p.screenshot({ path: `/tmp/${LABEL.toLowerCase()}-${W}.png`, fullPage: true });
  await p.close();
}
await b.close();
