// The shape the parser writes. Everything downstream reads this, so a change
// here is a contract change: bump SCHEMA_VERSION and the reader in io.ts.

import type { Role } from "../lib/roles.ts";

export const SCHEMA_VERSION = 4;

export type EdgeKind = "import" | "re-export" | "dynamic-import" | "require";

export type Resolution =
  // A real file inside the repository that is also a node in `files`.
  | { status: "internal"; target: string }
  // Points outside the repository: an installed package, a Node builtin, a
  // package a package.json declares but isn't installed, or a path above root.
  | { status: "external"; reason: "package" | "builtin" | "declared-dependency" | "outside-root" }
  // A real file inside the repository that is deliberately not a node.
  | { status: "excluded"; target: string; reason: "skipped-file" | "ignored-directory" | "not-source" }
  | { status: "unresolved"; reason: "file-not-found" | "package-not-found" | "non-literal-specifier" };

export type ImportRecord = {
  specifier: string;
  kind: EdgeKind;
  line: number;
  resolution: Resolution;
};

export type FileNode = {
  path: string; // repo-relative, forward slashes
  folder: string; // directory of `path`, "." at the root; the unit everything groups by
  lines: number;
  hash: string; // sha256 of the raw bytes
  imports: ImportRecord[];
  fanIn: number;
  fanOut: number;
  // How something other than an import reaches this file, from the adapter of
  // the project it sits in: "Next.js page", "test file, …". Null when only an
  // import would.
  reachedBy: string | null;
  // The role a convention of its project's adapter gives it. Null when none does; never a guess.
  role: Role | null;
  // The names this file exports, ESM and CommonJS alike, as written in it, in
  // source order. `export * from` adds nothing here: which names it passes on
  // lives in the other file, a re-export edge away.
  exports: string[];
};

// One per (from, to) pair, however many times or ways `from` imports `to`.
export type Edge = { from: string; to: string; kinds: EdgeKind[] };

export type SkipReason = "declaration-file" | "syntax-error" | "unreadable" | "symlink";

export type Coverage = {
  files: {
    found: number;
    parsed: number;
    skipped: { path: string; reason: SkipReason; detail: string }[];
  };
  ignoredDirectories: { path: string; reason: string }[];
  imports: Record<Resolution["status"], number> & { total: number };
  routes: {
    omitted: OmittedRoute[];
    // Projects where something sets every pattern at runtime, such as a
    // computed prefix, so none of their routes is listed.
    withheld: { project: string; reason: string }[];
  };
};

// One method on one pattern, both read from the syntax. `path` is the full
// pattern in the framework's own syntax: /users/:id, /blog/[slug]. `line` is
// the export or decorator that declares it.
export type Route = { file: string; line: number; method: string; path: string };

// The repository root, and every folder below it whose package.json a
// framework adapter detected. `adapter` is the one that detected it; "none" is
// the fallback.
export type DetectedProject = { path: string; adapter: string };

// Declared as a route, but left out because its method or full pattern isn't written in the syntax.
export type OmittedRoute = { file: string; line: number; reason: string };

export type ParseResult = {
  version: typeof SCHEMA_VERSION;
  // The root first, then nested projects in walk order.
  projects: DetectedProject[];
  files: FileNode[];
  edges: Edge[];
  // Sorted by pattern, then method.
  routes: Route[];
  coverage: Coverage;
};
