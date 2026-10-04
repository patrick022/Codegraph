// pnpm map-counts <result.json>   the phase 4 numbers for a parse result, folded
// Exits non-zero if a node holds one file or an edge ends on a missing node.

import { foldDirectories, MAX_GROUPS } from "../lib/map/fold.ts";
import { buildView, groupId } from "../lib/map/view.ts";
import { readParseResult } from "../parser/io.ts";

const file = process.argv[2];
if (!file) {
  console.error("usage: pnpm map-counts <result.json>");
  process.exit(1);
}

const { files, edges } = readParseResult(file);
const folding = foldDirectories(files);
const view = buildView(files, edges, folding, new Map());
const ids = new Set(view.objects.map((o) => o.id));

const singles = folding.groups.filter((g) => g.files.length < 2);
const dangling = view.edges.filter((e) => !ids.has(e.source) || !ids.has(e.target));

console.log(`files      ${files.length}`);
console.log(`threshold  ${folding.threshold}`);
console.log(`nodes      ${view.objects.length} (max ${MAX_GROUPS}, ~${Math.round(files.length / 10)} at one per ten files)`);
console.log(`edges      ${view.edges.length} drawn, from ${edges.length} file edges`);
console.log(`one-file   ${singles.length}${singles.map((g) => `  ${g.dir}`).join("")}`);
console.log(`dangling   ${dangling.length}`);
for (const g of folding.groups) {
  const o = view.objects.find((x) => x.id === groupId(g.dir));
  console.log(`  ${g.dir.padEnd(40)} ${String(g.files.length).padStart(4)} files  in ${o?.fanIn ?? 0}  out ${o?.fanOut ?? 0}`);
}

// Every group opened at once: each edge must still land on a row handle or a node.
const allOpen = buildView(files, edges, folding, new Map(view.objects.map((o) => [o.id, 0])));
const unattached = allOpen.edges.filter((e) => e.sourceHandle === null || e.targetHandle === null);
console.log(`all open   ${allOpen.edges.length} drawn, ${unattached.length} not on a row`);

if (singles.length || dangling.length || unattached.length) process.exit(1);
