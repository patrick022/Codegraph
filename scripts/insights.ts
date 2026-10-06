// pnpm insights <result.json>   the phase 6 insights for a parse result
// Exits non-zero if a reported loop isn't made of real edges, or a walk
// disagrees with the edge list.

import { findInsights, reach } from "../lib/map/graph.ts";
import { readParseResult } from "../parser/io.ts";

const file = process.argv[2];
if (!file) {
  console.error("usage: pnpm insights <result.json>");
  process.exit(1);
}

const { files, edges } = readParseResult(file);
const started = performance.now();
const insights = findInsights(files, edges);
console.log(`insights in ${Math.round(performance.now() - started)}ms`);

const has = new Set(edges.map((e) => `${e.from}\0${e.to}`));
const failures: string[] = [];

console.log(`\nimported by nothing, no convention  ${insights.unimported.length}`);
for (const f of insights.unimported) console.log(`  ${f.path}`);
console.log(`\nheavily imported  ${insights.heavilyImported.length}`);
for (const f of insights.heavilyImported) console.log(`  ${String(f.fanIn).padStart(4)}  ${f.path}`);
console.log(`\ncycles  ${insights.cycles.length}`);
for (const c of insights.cycles) {
  console.log(`  ${c.files.length} files in the loop, ${c.tangled} tangled`);
  c.files.forEach((p, i) => {
    const to = c.files[(i + 1) % c.files.length];
    const real = has.has(`${p}\0${to}`);
    if (!real) failures.push(`loop edge ${p} -> ${to} is not in the edge list`);
    console.log(`    ${real ? " " : "!"} ${p}`);
  });
}
console.log(`\nlong  ${insights.long.length}`);
for (const f of insights.long) console.log(`  ${String(f.lines).padStart(6)}  ${f.path}`);

// Depth one of each walk is exactly the file's direct neighbours.
for (const f of files) {
  const direct = (dir: "dependents" | "dependencies") => reach(edges, f.path, dir).steps[0];
  const importers = edges.filter((e) => e.to === f.path && e.from !== f.path).map((e) => e.from).sort();
  const imported = edges.filter((e) => e.from === f.path && e.to !== f.path).map((e) => e.to).sort();
  if (direct("dependents").join() !== importers.join()) failures.push(`blast radius depth 1 of ${f.path} disagrees`);
  if (direct("dependencies").join() !== imported.join()) failures.push(`dependency chain depth 1 of ${f.path} disagrees`);
}

const hub = insights.heavilyImported[0];
if (hub) {
  const { steps, beyond } = reach(edges, hub.path, "dependents");
  console.log(`\nblast radius of ${hub.path}: ${steps.map((s) => s.length).join(" + ")} within 2 steps, ${beyond} further`);
  // Everything the walk finds is counted once, inside the depth or beyond it.
  const whole = reach(edges, hub.path, "dependents", files.length).steps.flat().length;
  if (whole !== steps.flat().length + beyond) failures.push(`blast radius of ${hub.path} loses files past the depth`);
}

for (const f of failures) console.error(`FAIL ${f}`);
if (failures.length) process.exit(1);
