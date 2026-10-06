// pnpm parse <dir> [--out result.json]   parse a directory, print what was found
// pnpm parse --read result.json          load a written result through the typed reader

import { readParseResult, writeParseResult } from "../parser/io.ts";
import { parseRepository } from "../parser/parse.ts";
import type { EdgeKind, ParseResult, Resolution } from "../parser/types.ts";

const args = process.argv.slice(2);
/** Return the argument following the first occurrence of a flag, or undefined if absent. */
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

const readPath = flag("--read");
const outPath = flag("--out");
const dir = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));

if (!readPath && !dir) {
  console.error("usage: pnpm parse <dir> [--out result.json] | pnpm parse --read result.json");
  process.exit(1);
}

let result: ParseResult;
if (readPath) {
  result = readParseResult(readPath);
  console.log(`read ${readPath}: types hold`);
} else {
  const started = performance.now();
  result = parseRepository(dir!);
  console.log(`parsed ${dir} in ${Math.round(performance.now() - started)}ms`);
  if (outPath) {
    writeParseResult(outPath, result);
    console.log(`wrote ${outPath}`);
  }
}
print(result);

/** Print coverage totals, resolution breakdowns, and a bounded list of unresolved imports. */
function print(r: ParseResult) {
  const { files, imports, ignoredDirectories } = r.coverage;
  /** Right-pad a displayed value to the requested column width. */
  const pad = (s: string | number, n: number) => String(s).padEnd(n);
  const adds = files.found === files.parsed + files.skipped.length;

  console.log(`\nprojects ${r.projects.map((p) => `${p.path} (${p.adapter})`).join(", ")}`);
  console.log(`files    found ${files.found}  parsed ${files.parsed}  skipped ${files.skipped.length}  ${adds ? "(adds up)" : "(DOES NOT ADD UP)"}`);
  for (const s of files.skipped) console.log(`  skip   ${pad(s.path, 50)} ${pad(s.reason, 18)} ${s.detail}`);
  console.log(`folders  ${new Set(r.files.map((f) => f.folder)).size} distinct`);
  console.log(`ignored  ${ignoredDirectories.length} directories`);
  for (const d of ignoredDirectories) console.log(`  ${pad(d.path, 50)} ${d.reason}`);

  const all = r.files.flatMap((f) => f.imports.map((i) => ({ ...i, from: f.path })));
  console.log(`\nimports  ${imports.total}  internal ${imports.internal}  external ${imports.external}  excluded ${imports.excluded}  unresolved ${imports.unresolved}`);
  console.log(`  ${pad("kind", 16)}${pad("found", 8)}${pad("internal", 10)}${pad("external", 10)}${pad("excluded", 10)}unresolved`);
  for (const kind of ["import", "re-export", "dynamic-import"] satisfies EdgeKind[]) {
    const of = all.filter((i) => i.kind === kind);
    /** Count imports of the current kind with the requested resolution status. */
    const n = (s: Resolution["status"]) => of.filter((i) => i.resolution.status === s).length;
    console.log(`  ${pad(kind, 16)}${pad(of.length, 8)}${pad(n("internal"), 10)}${pad(n("external"), 10)}${pad(n("excluded"), 10)}${n("unresolved")}`);
  }

  const reasons = new Map<string, number>();
  for (const i of all) {
    if (i.resolution.status === "internal") continue;
    const key = `${i.resolution.status}: ${i.resolution.reason}`;
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  }
  for (const [k, n] of [...reasons].sort()) console.log(`  ${pad(k, 40)} ${n}`);

  console.log(`\nedges    ${r.edges.length} after removing duplicates`);

  const roles = new Map<string, number>();
  for (const f of r.files) roles.set(f.role ?? "(unclassified)", (roles.get(f.role ?? "(unclassified)") ?? 0) + 1);
  console.log(`\nroles`);
  for (const [role, n] of roles) console.log(`  ${pad(role, 24)} ${n}`);
  const { omitted, withheld } = r.coverage.routes;
  console.log(`\nroutes   ${r.routes.length}`);
  for (const w of withheld) console.log(`  withheld in ${w.project}: ${w.reason}`);
  for (const route of r.routes) console.log(`  ${pad(route.method, 8)} ${pad(route.path, 40)} ${route.file}:${route.line}`);
  if (omitted.length) console.log(`not listed (${omitted.length})`);
  for (const o of omitted) console.log(`  ${pad(`${o.file}:${o.line}`, 50)} ${o.reason}`);

  const unresolved = all.filter((i) => i.resolution.status === "unresolved");
  const shown = 40;
  if (unresolved.length) console.log(`\nunresolved (${unresolved.length})`);
  for (const i of unresolved.slice(0, shown)) {
    const reason = i.resolution.status === "unresolved" ? i.resolution.reason : "";
    console.log(`  ${pad(`${i.from}:${i.line}`, 50)} ${pad(JSON.stringify(i.specifier), 40)} ${reason}`);
  }
  if (unresolved.length > shown) console.log(`  … ${unresolved.length - shown} more, all in the --out file`);
}
