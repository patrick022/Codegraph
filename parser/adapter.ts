// Framework knowledge lives behind this interface so the parser never asks
// which framework it is looking at. Only the no-framework fallback exists so far.

export interface FrameworkAdapter {
  name: string;
  // Directory names the framework generates, skipped like node_modules. The
  // generic ones (dot-directories, dist, build, out, coverage) are skipped by
  // the walker regardless of adapter.
  ignoredDirectories: readonly string[];
  // What reaches this file other than an import, said as a phrase: a tool
  // loading its config, a runner collecting its tests, a framework mounting its
  // pages. Null when imports are the only way in.
  reachedBy: (path: string) => string | null;
}

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

// Conventions that hold whatever the framework: tools that load their config
// by file name, and test runners that collect files by pattern.
export const fallbackAdapter: FrameworkAdapter = {
  name: "none",
  ignoredDirectories: [],
  reachedBy: (path) => {
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (CONFIG_FILE.test(name) || RC_FILE.test(name)) return "config file, loaded by its tool";
    if (TEST_FILE.test(name) || TEST_DIR.test(path)) return "test file, collected by the test runner";
    return null;
  },
};

const adapters = [fallbackAdapter];

// A parse result records its adapter by name; this gets the conventions back.
export function adapterNamed(name: string): FrameworkAdapter {
  const adapter = adapters.find((a) => a.name === name);
  if (!adapter) throw new Error(`No adapter named ${JSON.stringify(name)}`);
  return adapter;
}
