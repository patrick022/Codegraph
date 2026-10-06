// Conventions every adapter shares. Apart from index.ts so the adapters
// and the list of them don't import each other.

import type { RouteReport } from "../adapter.ts";

// Named rather than matching any "*.config.*", so a module someone happened to
// call app.config.ts isn't claimed to be loaded by a tool.
const CONFIG_TOOLS = [
  "astro",
  "babel",
  "commitlint",
  "cypress",
  "eslint",
  "jest",
  "next",
  "playwright",
  "postcss",
  "prettier",
  "rollup",
  "stylelint",
  "svelte",
  "tailwind",
  "tsup",
  "vite",
  "vitest",
  "webpack",
];
const CONFIG_FILE = new RegExp(`^(${CONFIG_TOOLS.join("|")})\\.config\\.[cm]?[jt]s$`);
const RC_FILE = /^\.(babel|eslint|lintstaged|mocha|prettier|stylelint|commitlint)rc\.[cm]?js$/;
// The default include patterns of Jest and Vitest.
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const TEST_DIR = /(^|\/)__tests__\//;

export const NO_ROUTES: RouteReport = { routes: [], omitted: [], withheld: null };

/** Last path segment. */
export const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** What reaches a file by a tool convention, said as a phrase; null when none applies. */
export function toolConventions(path: string): string | null {
  const role = toolRole(path);
  if (role === "config") return "config file, loaded by its tool";
  if (role === "test") return "test file, collected by the test runner";
  return null;
}

/**
 * Conventions that hold whatever the framework: tools that load their config
 * by file name, and test runners that collect files by pattern.
 */
export function toolRole(path: string): "config" | "test" | null {
  const name = fileName(path);
  if (CONFIG_FILE.test(name) || RC_FILE.test(name)) return "config";
  if (TEST_FILE.test(name) || TEST_DIR.test(path)) return "test";
  return null;
}
