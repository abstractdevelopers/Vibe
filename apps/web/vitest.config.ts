import { defineConfig } from "vitest/config";

/**
 * The web workspace had no test runner, so a theme-resolution defect (every
 * game silently wearing the board environment) shipped unnoticed. This is a
 * plain node environment: the catalogue and the runtime are pure modules, so
 * they need no DOM to be exercised.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
