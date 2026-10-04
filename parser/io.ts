// Writing is JSON.stringify. Reading checks every field, because a file on
// disk is a trust boundary: a stale or hand-edited result must fail here, by
// field path, not three layers later as a blank map.

import { readFileSync, writeFileSync } from "node:fs";
import { SCHEMA_VERSION, type Coverage, type Edge, type EdgeKind, type FileNode, type ImportRecord, type ParseResult, type Resolution, type SkipReason } from "./types.ts";

export function writeParseResult(file: string, result: ParseResult): void {
  writeFileSync(file, JSON.stringify(result));
}

export function readParseResult(file: string): ParseResult {
  return parseResult(JSON.parse(readFileSync(file, "utf8")), "$");
}

const EDGE_KINDS = ["import", "re-export", "dynamic-import"] as const satisfies readonly EdgeKind[];
const SKIP_REASONS = ["declaration-file", "syntax-error", "unreadable", "symlink"] as const satisfies readonly SkipReason[];

function fail(at: string, expected: string): never {
  throw new Error(`Invalid parse result at ${at}: expected ${expected}`);
}

function obj(v: unknown, at: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(at, "object");
  return Object.fromEntries(Object.entries(v));
}
function arr<T>(v: unknown, at: string, item: (x: unknown, at: string) => T): T[] {
  if (!Array.isArray(v)) fail(at, "array");
  return v.map((x, i) => item(x, `${at}[${i}]`));
}
function str(v: unknown, at: string): string {
  if (typeof v !== "string") fail(at, "string");
  return v;
}
function num(v: unknown, at: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) fail(at, "non-negative integer");
  return v;
}
function oneOf<const T extends string>(v: unknown, at: string, options: readonly T[]): T {
  const match = options.find((o) => o === v);
  if (match === undefined) fail(at, options.join(" | "));
  return match;
}

function parseResult(v: unknown, at: string): ParseResult {
  const o = obj(v, at);
  if (o.version !== SCHEMA_VERSION) fail(`${at}.version`, String(SCHEMA_VERSION));
  return {
    version: SCHEMA_VERSION,
    adapter: str(o.adapter, `${at}.adapter`),
    files: arr(o.files, `${at}.files`, fileNode),
    edges: arr(o.edges, `${at}.edges`, edge),
    coverage: coverage(o.coverage, `${at}.coverage`),
  };
}

function fileNode(v: unknown, at: string): FileNode {
  const o = obj(v, at);
  return {
    path: str(o.path, `${at}.path`),
    folder: str(o.folder, `${at}.folder`),
    lines: num(o.lines, `${at}.lines`),
    hash: str(o.hash, `${at}.hash`),
    imports: arr(o.imports, `${at}.imports`, importRecord),
    fanIn: num(o.fanIn, `${at}.fanIn`),
    fanOut: num(o.fanOut, `${at}.fanOut`),
  };
}

function importRecord(v: unknown, at: string): ImportRecord {
  const o = obj(v, at);
  return {
    specifier: str(o.specifier, `${at}.specifier`),
    kind: oneOf(o.kind, `${at}.kind`, EDGE_KINDS),
    line: num(o.line, `${at}.line`),
    resolution: resolution(o.resolution, `${at}.resolution`),
  };
}

function resolution(v: unknown, at: string): Resolution {
  const o = obj(v, at);
  const status = oneOf(o.status, `${at}.status`, ["internal", "external", "excluded", "unresolved"]);
  switch (status) {
    case "internal":
      return { status, target: str(o.target, `${at}.target`) };
    case "external":
      return { status, reason: oneOf(o.reason, `${at}.reason`, ["package", "builtin", "declared-dependency", "outside-root"]) };
    case "excluded":
      return {
        status,
        target: str(o.target, `${at}.target`),
        reason: oneOf(o.reason, `${at}.reason`, ["skipped-file", "ignored-directory", "not-source"]),
      };
    case "unresolved":
      return { status, reason: oneOf(o.reason, `${at}.reason`, ["file-not-found", "package-not-found", "non-literal-specifier"]) };
  }
}

function edge(v: unknown, at: string): Edge {
  const o = obj(v, at);
  return {
    from: str(o.from, `${at}.from`),
    to: str(o.to, `${at}.to`),
    kinds: arr(o.kinds, `${at}.kinds`, (k, a) => oneOf(k, a, EDGE_KINDS)),
  };
}

function coverage(v: unknown, at: string): Coverage {
  const o = obj(v, at);
  const files = obj(o.files, `${at}.files`);
  const imports = obj(o.imports, `${at}.imports`);
  return {
    files: {
      found: num(files.found, `${at}.files.found`),
      parsed: num(files.parsed, `${at}.files.parsed`),
      skipped: arr(files.skipped, `${at}.files.skipped`, (s, a) => {
        const x = obj(s, a);
        return { path: str(x.path, `${a}.path`), reason: oneOf(x.reason, `${a}.reason`, SKIP_REASONS), detail: str(x.detail, `${a}.detail`) };
      }),
    },
    ignoredDirectories: arr(o.ignoredDirectories, `${at}.ignoredDirectories`, (d, a) => {
      const x = obj(d, a);
      return { path: str(x.path, `${a}.path`), reason: str(x.reason, `${a}.reason`) };
    }),
    imports: {
      total: num(imports.total, `${at}.imports.total`),
      internal: num(imports.internal, `${at}.imports.internal`),
      external: num(imports.external, `${at}.imports.external`),
      excluded: num(imports.excluded, `${at}.imports.excluded`),
      unresolved: num(imports.unresolved, `${at}.imports.unresolved`),
    },
  };
}
