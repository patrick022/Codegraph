// Directory path in, ParseResult out. No network, no framework checks: what a
// framework knows comes in through the adapter.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { Node, Project, SyntaxKind, ts } from "ts-morph";
import type { Role } from "../lib/roles.ts";
import type { AdapterRun, FrameworkAdapter } from "./adapter.ts";
import { fallbackAdapter, selectAdapter } from "./adapters/index.ts";
import { exportedNames } from "./exports.ts";
import { dedupeEdges, degrees } from "./graph.ts";
import {
  SCHEMA_VERSION,
  type Coverage,
  type EdgeKind,
  type FileNode,
  type ImportRecord,
  type ParseResult,
  type Resolution,
  type Route,
} from "./types.ts";

const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const DECLARATION = /\.d\.([^./]+\.)?[mc]?ts$/;
const BUILD_OUTPUT = new Set(["dist", "build", "out", "coverage"]);

type RawImport = { specifier: string; kind: EdgeKind; line: number; literal: boolean };
type Parsed = { path: string; lines: number; hash: string; imports: RawImport[]; exports: string[]; role: Role | null; reachedBy: string | null };
type WalkProject = { path: string; adapter: FrameworkAdapter };
// What a parsed file is asked through: its project's run, and its path within that project.
type Asker = { run: AdapterRun; adapter: FrameworkAdapter; within: string };
type Skipped = Coverage["files"]["skipped"][number];

/** Normalize path separators to forward slashes for stored paths and comparisons. */
const posix = (p: string) => p.replaceAll("\\", "/");

/**
 * Parse a local repository into file nodes, resolved import edges, and coverage counts.
 * Unreadable or invalid source files are recorded as skipped; root and directory traversal errors propagate.
 */
export function parseRepository(dir: string): ParseResult {
  return parseSelection(selectFiles(dir));
}

export type Selection = ReturnType<typeof selectFiles>;

/** Choose the files to parse and the project each belongs to: walk the directory, skipping what never gets parsed and recording why. */
export function selectFiles(dir: string) {
  // realpath gives canonical casing, so paths TypeScript hands back compare equal to ours.
  const root = posix(realpathSync.native(path.resolve(dir)));
  return { root, ...walk(root) };
}

/** Paths handed to an adapter are relative to its project. */
function withinProject(project: string, rel: string): string {
  return project === "." ? rel : rel.slice(project.length + 1);
}

/** Parse a selection into file nodes, resolved import edges, and coverage counts. */
export function parseSelection(walked: Selection): ParseResult {
  const { root } = walked;
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true } });
  const parsed: Parsed[] = [];
  const skipped: Skipped[] = [...walked.skipped];
  const runs = new Map(walked.projects.map((p) => [p.path, p.adapter.begin()]));
  /** The project run and project-relative path a file is asked about. */
  const askerOf = (rel: string): Asker => {
    const at = walked.projectOf.get(rel);
    const owner = walked.projects.find((p) => p.path === at);
    const run = at === undefined ? undefined : runs.get(at);
    if (at === undefined || !owner || !run) throw new Error(`${rel} was walked without a project`);
    return { run, adapter: owner.adapter, within: withinProject(at, rel) };
  };
  for (const rel of walked.files) {
    const result = parseFile(project, root, rel, askerOf(rel));
    if ("reason" in result) skipped.push(result);
    else parsed.push(result);
  }

  // Resolution needs the final node set, because an import of a file that was
  // skipped is excluded, not an edge.
  const nodes = new Set(parsed.map((p) => p.path));
  const skippedPaths = new Set(skipped.map((s) => s.path));
  const resolver = createResolver(root, nodes, skippedPaths, walked.ignored.map((d) => d.path));

  const raw: { from: string; to: string; kind: EdgeKind }[] = [];
  const withImports = parsed.map((file) => {
    const imports: ImportRecord[] = file.imports.map(({ specifier, kind, line, literal }) => {
      const resolution: Resolution = literal
        ? resolver.resolve(specifier, `${root}/${file.path}`)
        : { status: "unresolved", reason: "non-literal-specifier" };
      if (resolution.status === "internal") raw.push({ from: file.path, to: resolution.target, kind });
      return { specifier, kind, line, resolution };
    });
    return { ...file, imports };
  });

  const edges = dedupeEdges(raw);
  const degree = degrees([...nodes], edges);
  const files: FileNode[] = withImports.map((f) => ({
    path: f.path,
    folder: path.posix.dirname(f.path),
    lines: f.lines,
    hash: f.hash,
    imports: f.imports,
    ...degree.get(f.path)!,
    reachedBy: f.reachedBy,
    role: f.role,
    exports: f.exports,
  }));

  // Each project's adapter reports its own routes, by project-relative path,
  // mapped back to repository paths here.
  const found: Route[] = [];
  const omitted: Coverage["routes"]["omitted"] = [];
  const withheld: Coverage["routes"]["withheld"] = [];
  for (const { path: at } of walked.projects) {
    const toRepo = (p: string) => (at === "." ? p : `${at}/${p}`);
    // A declaration file has no runtime code, so it can't hold anything an adapter reads.
    const unparsed = skipped
      .filter((f) => f.reason !== "declaration-file" && walked.projectOf.get(f.path) === at)
      .map((f) => withinProject(at, f.path));
    const report = runs.get(at)!.routes(unparsed);
    if (report.withheld !== null) {
      withheld.push({ project: at, reason: report.withheld });
      continue;
    }
    for (const r of report.routes) found.push({ ...r, file: toRepo(r.file) });
    for (const o of report.omitted) omitted.push({ ...o, file: toRepo(o.file) });
  }
  // An array of paths on a decorator can name the same route twice.
  const routes = [...new Map(found.map((r) => [`${r.method} ${r.path} ${r.file}`, r])).values()];

  const imports: Coverage["imports"] = { total: 0, internal: 0, external: 0, excluded: 0, unresolved: 0 };
  for (const f of files) {
    for (const i of f.imports) {
      imports.total++;
      imports[i.resolution.status]++;
    }
  }

  return {
    version: SCHEMA_VERSION,
    projects: walked.projects.map((p) => ({ path: p.path, adapter: p.adapter.name })),
    files,
    edges,
    routes: routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method) || a.file.localeCompare(b.file)),
    coverage: {
      files: {
        found: walked.files.length + walked.skipped.length,
        parsed: files.length,
        skipped: skipped.sort((a, b) => a.path.localeCompare(b.path)),
      },
      ignoredDirectories: walked.ignored,
      imports,
      routes: { omitted: omitted.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line), withheld },
    },
  };
}

/**
 * Keep whole directories: every source file outside ignored directories is a
 * candidate. Never selects by size, so an imported leaf can't be dropped while
 * its importer is kept.
 *
 * The root is always a project. Below it, a package.json starts one only when
 * a framework is detected there; otherwise the folder stays in its parent's
 * project and keeps its conventions.
 */
function walk(root: string) {
  const files: string[] = [];
  const skipped: Skipped[] = [];
  const ignored: Coverage["ignoredDirectories"] = [];
  const projects: WalkProject[] = [];
  // The project of every file found, parsed or skipped.
  const projectOf = new Map<string, string>();

  /** Visit a repository-relative directory, collecting source files and recording skips and ignored directories. */
  const visit = (rel: string, parent: WalkProject | null) => {
    const dir = rel ? `${root}/${rel}` : root;
    const entries = readdirSync(dir, { withFileTypes: true });
    let project = parent;
    const manifest = entries.some((e) => e.isFile() && e.name === "package.json");
    if (!parent || manifest) {
      const adapter = selectAdapter(manifest ? dependencies(`${dir}/package.json`) : new Set());
      if (!parent || adapter !== fallbackAdapter) {
        project = { path: rel || ".", adapter };
        projects.push(project);
      }
    }
    if (!project) throw new Error(`No project for ${rel}`);

    for (const entry of entries) {
      const p = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        const reason = ignoreReason(entry.name, project.adapter);
        if (reason) ignored.push({ path: p, reason });
        else visit(p, project);
      } else if (entry.isSymbolicLink()) {
        // Following links risks cycles and files that live outside the repo.
        if (SOURCE.test(entry.name)) {
          projectOf.set(p, project.path);
          skipped.push({ path: p, reason: "symlink", detail: "symbolic link, not followed" });
        } else if (isDirectory(`${root}/${p}`)) ignored.push({ path: p, reason: "symbolic link, not followed" });
      } else if (entry.isFile() && SOURCE.test(entry.name)) {
        projectOf.set(p, project.path);
        if (DECLARATION.test(entry.name)) {
          skipped.push({ path: p, reason: "declaration-file", detail: "types only, no runtime imports" });
        } else files.push(p);
      }
    }
  };
  visit("", null);
  files.sort();
  ignored.sort((a, b) => a.path.localeCompare(b.path));
  return { files, skipped, ignored, projects, projectOf };
}

/** Every name a package.json declares in dependencies and devDependencies; an unreadable one declares nothing. */
function dependencies(file: string): Set<string> {
  const names = new Set<string>();
  try {
    const pkg: unknown = JSON.parse(readFileSync(file, "utf8"));
    for (const field of ["dependencies", "devDependencies"]) {
      const group: unknown = typeof pkg === "object" && pkg !== null ? Reflect.get(pkg, field) : undefined;
      if (typeof group === "object" && group !== null) for (const name of Object.keys(group)) names.add(name);
    }
  } catch {
    // not valid JSON: declares nothing, so only the fallback matches
  }
  return names;
}

/** Return why a directory should be excluded, or null when it should be traversed. */
function ignoreReason(name: string, adapter: FrameworkAdapter): string | null {
  if (name === "node_modules") return "installed dependencies";
  if (name.startsWith(".")) return "hidden directory";
  if (BUILD_OUTPUT.has(name)) return "build output";
  if (adapter.ignoredDirectories.includes(name)) return `generated by ${adapter.name}`;
  return null;
}

/** Check whether a path resolves to a directory, returning false when stat fails. */
function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false; // broken link
  }
}

/**
 * Read and parse one source file, returning imports, metadata and its adapter role, or a skip reason.
 * The temporary source file is removed from the project after inspection.
 */
function parseFile(project: Project, root: string, rel: string, asker: Asker): Parsed | Skipped {
  // A file that vanished or can't be opened since the walk is one skip, not a failed parse.
  let bytes: Buffer;
  try {
    bytes = readFileSync(`${root}/${rel}`);
  } catch (e) {
    return { path: rel, reason: "unreadable", detail: e instanceof Error ? e.message : String(e) };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { path: rel, reason: "unreadable", detail: "not valid UTF-8" };
  }

  const sf = project.createSourceFile(`/${rel}`, text, { overwrite: true });
  try {
    // A tree recovered from broken syntax can hold imports that aren't really
    // there, so the file is skipped rather than half-trusted.
    const error = firstSyntaxError(sf.compilerNode);
    if (error) return { path: rel, reason: "syntax-error", detail: error };

    const imports: RawImport[] = [];
    for (const d of sf.getImportDeclarations()) {
      imports.push({ specifier: d.getModuleSpecifierValue(), kind: "import", line: d.getStartLineNumber(), literal: true });
    }
    for (const d of sf.getExportDeclarations()) {
      const specifier = d.getModuleSpecifierValue();
      if (specifier !== undefined) imports.push({ specifier, kind: "re-export", line: d.getStartLineNumber(), literal: true });
    }
    // import() and require() can appear anywhere an expression can. The
    // `require` in `import x = require("y")` isn't a call expression, so
    // nothing here sees it; require.resolve() names a path without loading it.
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      const kind: EdgeKind | null =
        callee.getKind() === SyntaxKind.ImportKeyword
          ? "dynamic-import"
          : Node.isIdentifier(callee) && callee.getText() === "require"
            ? "require"
            : null;
      if (kind === null) continue;
      const [arg] = call.getArguments();
      const line = call.getStartLineNumber();
      if (arg && (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg))) {
        imports.push({ specifier: arg.getLiteralValue(), kind, line, literal: true });
      } else {
        imports.push({ specifier: arg?.getText() ?? "", kind, line, literal: false });
      }
    }
    imports.sort((a, b) => a.line - b.line);

    const lines = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    const role = asker.run.inspect(asker.within, sf);
    const reachedBy = asker.adapter.reachedBy(asker.within);
    const hash = createHash("sha256").update(bytes).digest("hex");
    return { path: rel, lines, hash, imports, exports: exportedNames(sf), role, reachedBy };
  } finally {
    project.removeSourceFile(sf);
  }
}

/**
 * Return the first syntax diagnostic with its line number, or null for valid syntax.
 * Throws if TypeScript no longer exposes the diagnostic array.
 *
 * parseDiagnostics isn't in TypeScript's public types. The public alternative
 * is building a Program per file, which also loads every dependency's types.
 */
function firstSyntaxError(sf: ts.SourceFile): string | null {
  const diagnostics: unknown = Reflect.get(sf, "parseDiagnostics");
  if (!Array.isArray(diagnostics)) throw new Error("TypeScript no longer exposes parseDiagnostics; syntax errors can't be detected");
  const first: unknown = diagnostics[0];
  if (first === undefined) return null;
  if (typeof first === "object" && first !== null && "messageText" in first && "start" in first) {
    const { messageText, start } = first;
    const message = typeof messageText === "string" ? messageText : "syntax error";
    const line = typeof start === "number" ? sf.getLineAndCharacterOfPosition(start).line + 1 : "?";
    return `line ${line}: ${message}`;
  }
  return "syntax error";
}

type Config = { dir: string; options: ts.CompilerOptions; cache: ts.ModuleResolutionCache; fileNames: Set<string>; references: string[] };

/**
 * Create an import resolver with cached project settings and dependency declarations.
 * Resolved paths are classified against parsed files, skipped files, and ignored directories.
 */
function createResolver(root: string, nodes: Set<string>, skipped: Set<string>, ignoredDirs: string[]) {
  const configs = new Map<string, Config>();
  const nearestConfigByDir = new Map<string, string | null>();
  const depsByDir = new Map<string, Record<string, string>>();
  const fallback = makeConfig(root, defaultOptions(), new Set(), []);

  /** Test whether an absolute normalized path is the repository root or lies beneath it. */
  const inRoot = (abs: string) => abs === root || abs.startsWith(`${root}/`);

  /** Load and cache TypeScript settings, included files, and project references, retaining recoverable options. */
  function loadConfig(file: string): Config {
    const cached = configs.get(file);
    if (cached) return cached;
    const dir = path.posix.dirname(file);
    // Config errors (say, an `extends` package that isn't installed) still
    // yield the options TypeScript could read; anything that then fails to
    // resolve is reported per import.
    const { config } = ts.readConfigFile(file, ts.sys.readFile);
    const cmd = ts.parseJsonConfigFileContent(config ?? {}, ts.sys, dir, undefined, file);
    const loaded = makeConfig(
      dir,
      withResolutionDefaults(cmd.options),
      new Set(cmd.fileNames.map(posix)),
      (cmd.projectReferences ?? []).map((r) => posix(ts.resolveProjectReferencePath(r))),
    );
    configs.set(file, loaded);
    return loaded;
  }

  /** Find and cache the closest tsconfig or jsconfig at or above a directory, stopping at the repository root. */
  function nearestConfig(dir: string): string | null {
    if (nearestConfigByDir.has(dir)) return nearestConfigByDir.get(dir)!;
    let found: string | null = null;
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      if (existsSync(`${dir}/${name}`)) {
        found = `${dir}/${name}`;
        break;
      }
    }
    if (!found && dir !== root && inRoot(dir)) found = nearestConfig(path.posix.dirname(dir));
    nearestConfigByDir.set(dir, found);
    return found;
  }

  /**
   * Solution-style configs (a tsconfig that only lists references) keep their
   * aliases in the referenced config that actually includes the file.
   */
  function configFor(file: string): Config {
    const nearest = nearestConfig(path.posix.dirname(file));
    if (!nearest) return fallback;
    const config = loadConfig(nearest);
    if (config.fileNames.has(file)) return config;
    for (const ref of config.references) {
      if (!existsSync(ref)) continue;
      const referenced = loadConfig(ref);
      if (referenced.fileNames.has(file)) return referenced;
    }
    return config;
  }

  /** Classify a resolved path against the repository boundary and available runtime source files. */
  function classifyFile(abs: string): Resolution {
    // Native path functions: on Windows a posix-style "C:/..." path is not absolute to path.posix.
    let rel = posix(path.relative(root, abs));
    if (rel.startsWith("../") || path.isAbsolute(rel)) return { status: "external", reason: "outside-root" };
    if (rel.split("/").includes("node_modules")) return { status: "external", reason: "package" };
    // TypeScript prefers a .d.ts sitting next to a .js file; at runtime the
    // import loads the .js, so that's the file the edge points at.
    const runtime = runtimeSibling(rel);
    if (runtime && nodes.has(runtime)) rel = runtime;
    if (nodes.has(rel)) return { status: "internal", target: rel };
    if (skipped.has(rel)) return { status: "excluded", target: rel, reason: "skipped-file" };
    if (ignoredDirs.some((d) => rel.startsWith(`${d}/`))) return { status: "excluded", target: rel, reason: "ignored-directory" };
    return { status: "excluded", target: rel, reason: "not-source" };
  }

  /** Find a parsed JavaScript sibling for a declaration path, or return null. */
  function runtimeSibling(rel: string): string | null {
    const match = /\.d\.([mc]?)ts$/.exec(rel);
    if (!match) return null;
    const base = rel.slice(0, match.index);
    const candidates = match[1] === "m" ? [".mjs"] : match[1] === "c" ? [".cjs"] : [".js", ".jsx"];
    return candidates.map((ext) => base + ext).find((c) => nodes.has(c)) ?? null;
  }

  /** Check ancestor manifests for the first declaration of a package, excluding workspace dependencies. */
  function declaredDependency(name: string, fromDir: string): boolean {
    for (let dir = fromDir; inRoot(dir); dir = path.posix.dirname(dir)) {
      const version = dependencies(dir)[name];
      // A workspace: dependency lives inside this repo, so failing to resolve
      // it is a real failure, not an external package.
      if (version !== undefined) return !version.startsWith("workspace:");
      if (dir === root) break;
    }
    return false;
  }

  /** Cache string-valued dependencies from a directory's manifest; unreadable or invalid JSON declares none. */
  function dependencies(dir: string): Record<string, string> {
    const cached = depsByDir.get(dir);
    if (cached) return cached;
    const deps: Record<string, string> = {};
    try {
      const pkg: unknown = JSON.parse(readFileSync(`${dir}/package.json`, "utf8"));
      for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
        const group: unknown = typeof pkg === "object" && pkg !== null ? Reflect.get(pkg, field) : undefined;
        if (typeof group !== "object" || group === null) continue;
        for (const [k, v] of Object.entries(group)) if (typeof v === "string") deps[k] = v;
      }
    } catch {
      // no package.json here, or not valid JSON: declares nothing
    }
    depsByDir.set(dir, deps);
    return deps;
  }

  /** Resolve an import from an absolute source path and classify code, assets, packages, or resolution failures. */
  function resolve(specifier: string, fromFile: string): Resolution {
    const config = configFor(fromFile);
    const resolved = ts.resolveModuleName(specifier, fromFile, config.options, ts.sys, config.cache).resolvedModule;
    if (resolved) return classifyFile(posix(resolved.resolvedFileName));
    if (isBuiltin(specifier)) return { status: "external", reason: "builtin" };

    // TypeScript only resolves code. A stylesheet or image import that names a
    // real file is excluded, not failed.
    const fromDir = path.posix.dirname(fromFile);
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      const abs = posix(path.resolve(fromDir, specifier));
      return isFile(abs) ? classifyFile(abs) : { status: "unresolved", reason: "file-not-found" };
    }
    const aliased = aliasTargets(specifier, config);
    if (aliased) {
      const hit = aliased.find(isFile);
      return hit ? classifyFile(hit) : { status: "unresolved", reason: "file-not-found" };
    }
    const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
    return declaredDependency(name, fromDir)
      ? { status: "external", reason: "declared-dependency" }
      : { status: "unresolved", reason: "package-not-found" };
  }

  return { resolve };
}

/**
 * Candidate files for a specifier matching a tsconfig `paths` pattern, or
 * null when no pattern matches.
 */
function aliasTargets(specifier: string, config: Config): string[] | null {
  const paths = config.options.paths;
  if (!paths) return null;
  const base = posix(config.options.baseUrl ?? config.dir);
  for (const [pattern, targets] of Object.entries(paths)) {
    const star = pattern.indexOf("*");
    let captured: string | null = null;
    if (star === -1) captured = pattern === specifier ? "" : null;
    else {
      const prefix = pattern.slice(0, star);
      const suffix = pattern.slice(star + 1);
      if (specifier.startsWith(prefix) && specifier.endsWith(suffix) && specifier.length >= prefix.length + suffix.length) {
        captured = specifier.slice(prefix.length, specifier.length - suffix.length);
      }
    }
    if (captured !== null) return targets.map((t) => posix(path.resolve(base, t.replace("*", captured))));
  }
  return null;
}

/** Check whether a path resolves to a file, returning false when stat fails. */
function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Return fallback compiler options for repositories without a project configuration. */
function defaultOptions(): ts.CompilerOptions {
  return withResolutionDefaults({ module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve });
}

/**
 * The resolver has to find .js and .json files whatever the project's own
 * settings, and Classic resolution (an old default) never looks in
 * node_modules or at index files, so it's replaced with Bundler.
 */
function withResolutionDefaults(options: ts.CompilerOptions): ts.CompilerOptions {
  const nodeModule = [ts.ModuleKind.Node16, ts.ModuleKind.Node18, ts.ModuleKind.Node20, ts.ModuleKind.NodeNext];
  const classic =
    options.moduleResolution === ts.ModuleResolutionKind.Classic ||
    (options.moduleResolution === undefined && !nodeModule.includes(options.module ?? ts.ModuleKind.ESNext));
  return {
    ...options,
    allowJs: true,
    resolveJsonModule: true,
    moduleResolution: classic ? ts.ModuleResolutionKind.Bundler : options.moduleResolution,
  };
}

/** Bundle project settings and file membership with a fresh TypeScript resolution cache. */
function makeConfig(dir: string, options: ts.CompilerOptions, fileNames: Set<string>, references: string[]): Config {
  const cache = ts.createModuleResolutionCache(dir, (s) => s, options);
  return { dir, options, cache, fileNames, references };
}
