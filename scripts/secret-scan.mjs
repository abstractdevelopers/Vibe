#!/usr/bin/env node
/**
 * Secret scan for tracked files (§11 security: "secret scanning").
 *
 * Dependency-free so it runs anywhere. It looks for the shapes of real secrets
 * in files git tracks — never in node_modules or build output. It is a guard
 * against a committed credential, not a replacement for a full scanner; the
 * patterns are deliberately narrow to avoid noise.
 *
 * Exits non-zero if anything is found, so CI fails on a real leak.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PATTERNS = [
  { name: "private key", re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "Slack token", re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { name: "GitHub token", re: /\bgh[pousr]_[0-9A-Za-z]{36,}\b/ },
  { name: "Stripe secret", re: /\bsk_(live|test)_[0-9A-Za-z]{16,}\b/ },
  { name: "Bachs live key", re: /\bbachs_(live|sk)_[0-9A-Za-z]{16,}\b/i },
  { name: "hardcoded bearer", re: /authorization:\s*["']Bearer [0-9A-Za-z._-]{20,}["']/i },
];

// A file that legitimately contains placeholder text should be skipped.
const ALLOWLIST = [/\.env\.example$/, /\.md$/, /scripts\/secret-scan\.mjs$/, /\.test\.ts$/];

const files = execSync("git ls-files", { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter((f) => !ALLOWLIST.some((re) => re.test(f)));

let findings = 0;
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const { name, re } of PATTERNS) {
      if (re.test(lines[i])) {
        console.log(`FAIL ${file}:${i + 1}  possible ${name}`);
        findings++;
      }
    }
  }
}

if (findings > 0) {
  console.error(`\nSecret scan found ${findings} possible secret(s). Remove them from history and rotate.`);
  process.exitCode = 1;
} else {
  console.log(`Secret scan clean (${files.length} tracked files checked).`);
}
