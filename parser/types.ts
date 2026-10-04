// The shape the parser writes. Everything downstream reads this, so a change
// here is a contract change: bump SCHEMA_VERSION and the reader in io.ts.

export const SCHEMA_VERSION = 1;

export type EdgeKind = "import" | "re-export" | "dynamic-import";

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
};

export type ParseResult = {
  version: typeof SCHEMA_VERSION;
  adapter: string;
  files: FileNode[];
  edges: Edge[];
  coverage: Coverage;
};
