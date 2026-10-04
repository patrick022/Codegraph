import type { Edge, EdgeKind } from "./types.ts";

type RawEdge = { from: string; to: string; kind: EdgeKind };

/**
 * Collapse repeated imports of the same file into one edge, so a file that
 * imports and re-exports a neighbour counts that neighbour once.
 */
export function dedupeEdges(raw: RawEdge[]): Edge[] {
  const byPair = new Map<string, Edge>();
  for (const { from, to, kind } of raw) {
    const key = `${from}\0${to}`;
    const edge = byPair.get(key);
    if (!edge) byPair.set(key, { from, to, kinds: [kind] });
    else if (!edge.kinds.includes(kind)) edge.kinds.push(kind);
  }
  return [...byPair.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

/** Count incoming and outgoing edges per file; throw if an endpoint is absent from the file list. */
export function degrees(files: string[], edges: Edge[]): Map<string, { fanIn: number; fanOut: number }> {
  const result = new Map(files.map((f) => [f, { fanIn: 0, fanOut: 0 }]));
  for (const { from, to } of edges) {
    const a = result.get(from);
    const b = result.get(to);
    if (!a || !b) throw new Error(`Edge ${from} -> ${to} references a file that is not a node`);
    a.fanOut++;
    b.fanIn++;
  }
  return result;
}
