// Writing is JSON.stringify. Reading checks every field, because a file on
// disk is a trust boundary: a stale or hand-edited result must fail here, by
// field path, not three layers later as a blank map.

import { readFileSync, writeFileSync } from "node:fs";
import { ROLE_IDS } from "../lib/roles.ts";
import { SCHEMA_VERSION, type Coverage, type Edge, type EdgeKind, type FileNode, type ImportRecord, type DetectedProject, type ParseResult, type Resolution, type Route, type SkipReason } from "./types.ts";

/** Write a parse result as compact JSON, propagating filesystem errors. */
export function writeParseResult(file: string, result: ParseResult): void {
  writeFileSync(file, JSON.stringify(result));
}

/** Read JSON and validate its schema, reporting invalid fields by their path. */
export function readParseResult(file: string): ParseResult {
  return parseResult(JSON.parse(readFileSync(file, "utf8")), "$");
}

const EDGE_KINDS = ["import", "re-export", "dynamic-import"] as const satisfies readonly EdgeKind[];
const SKIP_REASONS = ["declaration-file", "syntax-error", "unreadable", "symlink"] as const satisfies readonly SkipReason[];

/** Throw a validation error identifying the field path and expected value. */
function fail(at: string, expected: string): never {
  throw new Error(`Invalid parse result at ${at}: expected ${expected}`);
}

/** Require a non-null, non-array object and copy its own enumerable properties. */
function obj(v: unknown, at: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(at, "object");
  return Object.fromEntries(Object.entries(v));
}
/** Require an array and validate each item with its indexed field path. */
function arr<T>(v: unknown, at: string, item: (x: unknown, at: string) => T): T[] {
  if (!Array.isArray(v)) fail(at, "array");
  return v.map((x, i) => item(x, `${at}[${i}]`));
}
/** Require a string, reporting its field path on failure. */
function str(v: unknown, at: string): string {
  if (typeof v !== "string") fail(at, "string");
  return v;
}
/** Require a non-negative integer, reporting its field path on failure. */
function num(v: unknown, at: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) fail(at, "non-negative integer");
  return v;
}
/** Require one of the allowed string literals and return its narrowed value. */
function oneOf<const T extends string>(v: unknown, at: string, options: readonly T[]): T {
  const match = options.find((o) => o === v);
  if (match === undefined) fail(at, options.join(" | "));
  return match;
}

/** Validate the schema version and reconstruct the typed parse result. */
function parseResult(v: unknown, at: string): ParseResult {
  const o = obj(v, at);
  if (o.version !== SCHEMA_VERSION) fail(`${at}.version`, String(SCHEMA_VERSION));
  return {
    version: SCHEMA_VERSION,
    projects: readProjects(o.projects, `${at}.projects`),
    files: arr(o.files, `${at}.files`, fileNode),
    edges: arr(o.edges, `${at}.edges`, edge),
    routes: arr(o.routes, `${at}.routes`, route),
    coverage: coverage(o.coverage, `${at}.coverage`),
  };
}

/** Validate a file node and its imports, preserving field paths in errors. */
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
    reachedBy: o.reachedBy === null ? null : str(o.reachedBy, `${at}.reachedBy`),
    role: o.role === null ? null : oneOf(o.role, `${at}.role`, ROLE_IDS),
  };
}

/** Validate an import specifier, kind, source line, and resolution. */
function importRecord(v: unknown, at: string): ImportRecord {
  const o = obj(v, at);
  return {
    specifier: str(o.specifier, `${at}.specifier`),
    kind: oneOf(o.kind, `${at}.kind`, EDGE_KINDS),
    line: num(o.line, `${at}.line`),
    resolution: resolution(o.resolution, `${at}.resolution`),
  };
}

/** Validate a resolution status and the fields required for that status. */
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

/** Validate a route: an upper-case method and a pattern starting with a slash. */
function route(v: unknown, at: string): Route {
  const o = obj(v, at);
  const method = str(o.method, `${at}.method`);
  if (!/^[A-Z]+$/.test(method)) fail(`${at}.method`, "upper-case method");
  const path = str(o.path, `${at}.path`);
  if (!path.startsWith("/")) fail(`${at}.path`, "pattern starting with /");
  return { file: str(o.file, `${at}.file`), line: num(o.line, `${at}.line`), method, path };
}

/** Validate an edge's endpoints and supported import kinds. */
function edge(v: unknown, at: string): Edge {
  const o = obj(v, at);
  return {
    from: str(o.from, `${at}.from`),
    to: str(o.to, `${at}.to`),
    kinds: arr(o.kinds, `${at}.kinds`, (k, a) => oneOf(k, a, EDGE_KINDS)),
  };
}

/** Validate a detected-project list, root first, that arrived from a result file or a stored row. */
export function readProjects(value: unknown, at: string): DetectedProject[] {
  const projects = arr(value, at, (p, a) => {
    const x = obj(p, a);
    return { path: str(x.path, `${a}.path`), adapter: str(x.adapter, `${a}.adapter`) };
  });
  if (projects[0]?.path !== ".") fail(`${at}[0].path`, "the root, \".\", first");
  return projects;
}

/** Validate a coverage report that arrived some other way than a result file, such as rebuilt from stored rows. */
export function readCoverage(value: unknown, at: string): Coverage {
  return coverage(value, at);
}

/** Validate file and import counts, skipped files, and ignored directories. */
function coverage(v: unknown, at: string): Coverage {
  const o = obj(v, at);
  const files = obj(o.files, `${at}.files`);
  const imports = obj(o.imports, `${at}.imports`);
  const routes = obj(o.routes, `${at}.routes`);
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
    routes: {
      omitted: arr(routes.omitted, `${at}.routes.omitted`, (r, a) => {
        const x = obj(r, a);
        return { file: str(x.file, `${a}.file`), line: num(x.line, `${a}.line`), reason: str(x.reason, `${a}.reason`) };
      }),
      withheld: arr(routes.withheld, `${at}.routes.withheld`, (w, a) => {
        const x = obj(w, a);
        return { project: str(x.project, `${a}.project`), reason: str(x.reason, `${a}.reason`) };
      }),
    },
  };
}
