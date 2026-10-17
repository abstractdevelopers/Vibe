import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { GAME_RAKE_BPS, PLATFORM_FEE_BPS } from "@vibe/shared";

/**
 * The platform cut has drifted twice: the gift sheet kept saying 70/30 after the
 * gift fee moved to 15%, and the ticket toggle still said 30% after the ticket
 * fee did. Both were copy that repeated a number the code owned.
 *
 * These tests hold the line: the shared table is the only place a rate is
 * written down, and no user-facing sentence states a cut the code does not
 * charge.
 */

const ROOT = join(import.meta.dirname, "..", "..", "..");
const WEB_SRC = join(ROOT, "apps", "web", "src");
const API_SRC = join(ROOT, "apps", "api", "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

function filesMatching(dir: string, pattern: RegExp): string[] {
  return sourceFiles(dir).filter((f) => pattern.test(readFileSync(f, "utf8")));
}

describe("platform fee rates", () => {
  it("takes 15% on gifts, tickets and orders, and 5% on a staked pot", () => {
    expect(PLATFORM_FEE_BPS.gift).toBe(1500);
    expect(PLATFORM_FEE_BPS.ticket).toBe(1500);
    expect(PLATFORM_FEE_BPS.order).toBe(1500);
    expect(GAME_RAKE_BPS).toBe(500);
  });

  it("writes the gift, ticket and order rates down in exactly one place", () => {
    const literal = /=\s*1500\b|:\s*1500\b/;
    expect(filesMatching(API_SRC, literal), "a fee is hardcoded outside the shared table").toEqual([]);
    expect(filesMatching(WEB_SRC, literal), "a fee is hardcoded outside the shared table").toEqual([]);
  });

  it("never hardcodes a platform cut in copy", () => {
    const copy = /Vibe (keeps|takes) \d+%/;
    expect(filesMatching(WEB_SRC, copy), "hardcoded cut in web copy").toEqual([]);
    expect(filesMatching(API_SRC, copy), "hardcoded cut in API copy").toEqual([]);
  });

  it("never states the old 30/70 split", () => {
    const stale = /Vibe keeps 30%|earns \(?70%\)?|30% of a ticket/;
    expect(filesMatching(WEB_SRC, stale), "web copy still says 30/70").toEqual([]);
    expect(filesMatching(API_SRC, stale), "API copy still says 30/70").toEqual([]);
  });
});
