// Framework knowledge lives behind this interface so the parser never asks
// which framework it is looking at. Only the no-framework fallback exists so far.

export interface FrameworkAdapter {
  name: string;
  // Directory names the framework generates, skipped like node_modules. The
  // generic ones (dot-directories, dist, build, out, coverage) are skipped by
  // the walker regardless of adapter.
  ignoredDirectories: readonly string[];
}

export const fallbackAdapter: FrameworkAdapter = {
  name: "none",
  ignoredDirectories: [],
};
