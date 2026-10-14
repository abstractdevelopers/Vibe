#!/usr/bin/env node
/**
 * Bundle budget gate (§5 "Set explicit JS/app bundle budgets for the chosen
 * stack and enforce in CI").
 *
 * Reads the built assets and fails if any exceeds its budget. Budgets are
 * gzip-aware because that is what a phone on a constrained network actually
 * downloads.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";

const ASSETS = "apps/web/dist/assets";

// Budgets in bytes. JS is checked both raw and gzipped; CSS only gzipped.
const BUDGET = {
  jsGzip: 120 * 1024,
  jsRaw: 400 * 1024,
  cssGzip: 20 * 1024,
};

let files;
try {
  files = readdirSync(ASSETS);
} catch {
  console.error(`No build found at ${ASSETS}. Run "npm run build" first.`);
  process.exit(1);
}

let worst = { label: "", pct: 0 };
function check(label, size, budget) {
  const pct = size / budget;
  const ok = size <= budget;
  const flag = ok ? "ok  " : "FAIL";
  console.log(`${flag} ${label.padEnd(28)} ${(size / 1024).toFixed(1)}kB / ${(budget / 1024).toFixed(0)}kB budget`);
  if (pct > worst.pct) worst = { label, pct };
  return ok;
}

let allOk = true;
for (const file of files) {
  const path = join(ASSETS, file);
  const raw = readFileSync(path);
  const gz = gzipSync(raw).length;
  if (file.endsWith(".js")) {
    allOk = check(`${file} (gzip)`, gz, BUDGET.jsGzip) && allOk;
    allOk = check(`${file} (raw)`, statSync(path).size, BUDGET.jsRaw) && allOk;
  } else if (file.endsWith(".css")) {
    allOk = check(`${file} (gzip)`, gz, BUDGET.cssGzip) && allOk;
  }
}

console.log(`\nPeak usage: ${worst.label} at ${(worst.pct * 100).toFixed(0)}% of budget`);
if (!allOk) {
  console.error("\nBundle budget exceeded.");
  process.exit(1);
}
console.log("Bundle budget satisfied.");
