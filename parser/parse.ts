// Directory path in, ParseResult out. No network, no framework checks: what a
// framework knows comes in through the adapter.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { Node, Project, SyntaxKind, ts } from "ts-morph";
import { fallbackAdapter, type FrameworkAdapter } from "./adapter.ts";
import { dedupeEdges, degrees } from "./graph.ts";
import {
  SCHEMA_VERSION,
  type Coverage,
  type EdgeKind,
  type FileNode,
  type ImportRecord,
  type ParseResult,
  type Resolution,
} from "./types.ts";

const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const DECLARATION = /\.d\.([^./]+\.)?[mc]?ts$/;
const BUILD_OUTPUT = new Set(["dist", "build", "out", "coverage"]);

type RawImport = { specifier: string; kind: EdgeKind; line: number; literal: boolean };
type Parsed = { path: string; lines: number; hash: string; imports: RawImport[] };
type Skipped = Coverage["files"]["skipped"][number];

const posix = (p: string) => p.replaceAll("\\", "/");

export function parseRepository(dir: string, adapter: FrameworkAdapter = fallbackAdapter): ParseResult {
  // realpath gives canonical casing, so paths TypeScript hands back compare equal to ours.
  const root = posix(realpathSync.native(path.resolve(dir)));
  const walked = walk(root, adapter);

  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true } });
  const parsed: Parsed[] = [];
  const skipped: Skipped[] = [...walked.skipped];
  for (const rel of walked.files) {
    const result = parseFile(project, root, rel);
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
  }));

  const imports: Coverage["imports"] = { total: 0, internal: 0, external: 0, excluded: 0, unresolved: 0 };
  for (const f of files) {
    for (const i of f.imports) {
      imports.total++;
      imports[i.resolution.status]++;
    }
  }

  return {
    version: SCHEMA_VERSION,
    adapter: adapter.name,
    files,
    edges,
    coverage: {
      files: {
        found: walked.files.length + walked.skipped.length,
        parsed: files.length,
        skipped: skipped.sort((a, b) => a.path.localeCompare(b.path)),
      },
      ignoredDirectories: walked.ignored,
      imports,
    },
  };
}

// Keep whole directories: every source file outside ignored directories is a
// candidate. Never selects by size, so an imported leaf can't be dropped while
// its importer is kept.
function walk(root: string, adapter: FrameworkAdapter) {
  const files: string[] = [];
  const skipped: Skipped[] = [];
  const ignored: Coverage["ignoredDirectories"] = [];

  const visit = (rel: string) => {
    for (const entry of readdirSync(rel ? `${root}/${rel}` : root, { withFileTypes: true })) {
      const p = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        const reason = ignoreReason(entry.name, adapter);
        if (reason) ignored.push({ path: p, reason });
        else visit(p);
      } else if (entry.isSymbolicLink()) {
        // Following links risks cycles and files that live outside the repo.
        if (SOURCE.test(entry.name)) skipped.push({ path: p, reason: "symlink", detail: "symbolic link, not followed" });
        else if (isDirectory(`${root}/${p}`)) ignored.push({ path: p, reason: "symbolic link, not followed" });
      } else if (entry.isFile() && SOURCE.test(entry.name)) {
        if (DECLARATION.test(entry.name)) {
          skipped.push({ path: p, reason: "declaration-file", detail: "types only, no runtime imports" });
        } else files.push(p);
      }
    }
  };
  visit("");
  files.sort();
  ignored.sort((a, b) => a.path.localeCompare(b.path));
  return { files, skipped, ignored };
}

function ignoreReason(name: string, adapter: FrameworkAdapter): string | null {
  if (name === "node_modules") return "installed dependencies";
  if (name.startsWith(".")) return "hidden directory";
  if (BUILD_OUTPUT.has(name)) return "build output";
  if (adapter.ignoredDirectories.includes(name)) return `generated by ${adapter.name}`;
  return null;
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false; // broken link
  }
}

function parseFile(project: Project, root: string, rel: string): Parsed | Skipped {
  const bytes = readFileSync(`${root}/${rel}`);
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
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      if (call.getExpression().getKind() !== SyntaxKind.ImportKeyword) continue;
      const [arg] = call.getArguments();
      const line = call.getStartLineNumber();
      if (arg && (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg))) {
        imports.push({ specifier: arg.getLiteralValue(), kind: "dynamic-import", line, literal: true });
      } else {
        imports.push({ specifier: arg?.getText() ?? "", kind: "dynamic-import", line, literal: false });
      }
    }
    imports.sort((a, b) => a.line - b.line);

    const lines = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    return { path: rel, lines, hash: createHash("sha256").update(bytes).digest("hex"), imports };
  } finally {
    project.removeSourceFile(sf);
  }
}

// parseDiagnostics isn't in TypeScript's public types. The public alternative
// is building a Program per file, which also loads every dependency's types.
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

function createResolver(root: string, nodes: Set<string>, skipped: Set<string>, ignoredDirs: string[]) {
  const configs = new Map<string, Config>();
  const nearestConfigByDir = new Map<string, string | null>();
  const depsByDir = new Map<string, Record<string, string>>();
  const fallback = makeConfig(root, defaultOptions(), new Set(), []);

  const inRoot = (abs: string) => abs === root || abs.startsWith(`${root}/`);

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

  // Solution-style configs (a tsconfig that only lists references) keep their
  // aliases in the referenced config that actually includes the file.
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

  function runtimeSibling(rel: string): string | null {
    const match = /\.d\.([mc]?)ts$/.exec(rel);
    if (!match) return null;
    const base = rel.slice(0, match.index);
    const candidates = match[1] === "m" ? [".mjs"] : match[1] === "c" ? [".cjs"] : [".js", ".jsx"];
    return candidates.map((ext) => base + ext).find((c) => nodes.has(c)) ?? null;
  }

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

// Candidate files for a specifier matching a tsconfig `paths` pattern, or
// null when no pattern matches.
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

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function defaultOptions(): ts.CompilerOptions {
  return withResolutionDefaults({ module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve });
}

// The resolver has to find .js and .json files whatever the project's own
// settings, and Classic resolution (an old default) never looks in
// node_modules or at index files, so it's replaced with Bundler.
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

function makeConfig(dir: string, options: ts.CompilerOptions, fileNames: Set<string>, references: string[]): Config {
  const cache = ts.createModuleResolutionCache(dir, (s) => s, options);
  return { dir, options, cache, fileNames, references };
}
