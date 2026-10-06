import type { Edge } from "../../parser/types.ts";
import type { MapFile } from "./types.ts";

// Arithmetic over the edge list. Pure, and fast enough to run on a click.

// Past two levels the walk returns most of a real repository and stops being
// an answer, so two is the default.
export const REACH_DEPTH = 2;
// "Simply too long": a round number past which a file is hard to hold in your
// head, rather than one solved for from the repository.
export const LONG_LINES = 1000;

export type Direction = "dependents" | "dependencies";
export type Reach = {
  // steps[0] is one import away, steps[1] two, up to the depth. Each sorted.
  steps: string[][];
  // Files reachable only past the depth, so the list never reads as complete
  // when it isn't.
  beyond: number;
};

// Blast radius walks dependents (what imports this, and what imports those);
// the dependency chain walks dependencies. Same walk, opposite direction.
// Breadth-first, so each file sits at the fewest steps it's reached in. It runs
// to the end to count what lies past the depth; a queue, so nothing overflows.
export function reach(edges: readonly Edge[], start: string, direction: Direction, depth = REACH_DEPTH): Reach {
  const next = outEdges(edges.map((e) => (direction === "dependencies" ? e : { from: e.to, to: e.from })));
  const seen = new Set([start]);
  const steps: string[][] = Array.from({ length: depth }, () => []);
  let beyond = 0;
  let frontier = [start];
  for (let d = 1; frontier.length > 0; d++) {
    const level: string[] = [];
    for (const p of frontier) {
      for (const q of next.get(p) ?? []) {
        if (seen.has(q)) continue;
        seen.add(q);
        level.push(q);
      }
    }
    if (d <= depth) steps[d - 1] = level.sort();
    else beyond += level.length;
    frontier = level;
  }
  return { steps, beyond };
}

function outEdges(edges: readonly { from: string; to: string }[]): Map<string, string[]> {
  const next = new Map<string, string[]>();
  for (const { from, to } of edges) {
    const list = next.get(from);
    if (list) list.push(to);
    else next.set(from, [to]);
  }
  return next;
}

// A concrete loop, files[0] -> files[1] -> ... -> files[0], and how many files
// are tangled into the same strongly connected group with it.
export type Cycle = { files: string[]; tangled: number };

// Iterative Tarjan: a real repository's import chains run deep enough to
// overflow the call stack if this recursed. Each strongly connected group gets
// one concrete loop, the shortest through its first file, so it can be walked
// by hand.
export function findCycles(edges: readonly Edge[]): Cycle[] {
  const next = outEdges(edges);
  const nodes = [...new Set(edges.flatMap((e) => [e.from, e.to]))].sort();

  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const groups: string[][] = [];
  const lowOf = (v: string) => low.get(v) ?? 0;
  const visit = (v: string) => {
    low.set(v, index.size);
    index.set(v, index.size);
    stack.push(v);
    onStack.add(v);
  };

  for (const root of nodes) {
    if (index.has(root)) continue;
    visit(root);
    const work = [{ v: root, i: 0 }];
    while (work.length > 0) {
      const top = work[work.length - 1];
      const succ = next.get(top.v) ?? [];
      if (top.i < succ.length) {
        const w = succ[top.i++];
        if (!index.has(w)) {
          visit(w);
          work.push({ v: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(top.v, Math.min(lowOf(top.v), index.get(w) ?? 0));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.v, Math.min(lowOf(parent.v), lowOf(top.v)));
      if (lowOf(top.v) !== index.get(top.v)) continue;
      const group: string[] = [];
      let w: string | undefined;
      do {
        w = stack.pop();
        if (w === undefined) throw new Error("Cycle search emptied its stack early");
        onStack.delete(w);
        group.push(w);
      } while (w !== top.v);
      if (group.length > 1 || succ.includes(top.v)) groups.push(group.sort());
    }
  }

  return groups.map((group) => ({ files: shortestLoop(group[0], new Set(group), next), tangled: group.length })).sort(
    (a, b) => a.files[0].localeCompare(b.files[0]),
  );
}

// Breadth-first from `start` inside its group until an edge leads back to it.
function shortestLoop(start: string, group: ReadonlySet<string>, next: ReadonlyMap<string, string[]>): string[] {
  const parent = new Map<string, string>();
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    const u = queue[i];
    for (const w of next.get(u) ?? []) {
      if (w === start) {
        const loop = [u];
        while (loop[0] !== start) loop.unshift(parent.get(loop[0]) ?? start);
        return loop;
      }
      if (group.has(w) && !parent.has(w)) {
        parent.set(w, u);
        queue.push(w);
      }
    }
  }
  throw new Error(`${start} is in a strongly connected group but no loop leads back to it`);
}

export type Insights = {
  // Nothing imports these and no convention reaches them either.
  unimported: MapFile[];
  // Imported by unusually many files.
  heavilyImported: MapFile[];
  cycles: Cycle[];
  long: MapFile[];
};

export function findInsights(
  files: readonly MapFile[],
  edges: readonly Edge[],
): Insights {
  // Tukey's far-out fence, over files imported at all: an outlier among the
  // things that get imported, not among every file. Counting the never-imported
  // ones would pull the fence to zero in a repository of mostly entry points.
  const fanIns = files.map((f) => f.fanIn).filter((n) => n > 0).sort((a, b) => a - b);
  const quantile = (p: number) => fanIns[Math.floor((fanIns.length - 1) * p)] ?? 0;
  const fence = quantile(0.75) + 3 * (quantile(0.75) - quantile(0.25));

  return {
    unimported: files
      .filter((f) => f.fanIn === 0 && f.reachedBy === null)
      .sort((a, b) => a.path.localeCompare(b.path)),
    heavilyImported: files
      .filter((f) => fanIns.length > 0 && f.fanIn > fence)
      .sort((a, b) => b.fanIn - a.fanIn || a.path.localeCompare(b.path)),
    cycles: findCycles(edges),
    long: files.filter((f) => f.lines > LONG_LINES).sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path)),
  };
}
