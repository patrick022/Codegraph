import type { Edge } from "../../parser/types.ts";
import type { MapFile } from "./types.ts";
import type { Folding } from "./fold.ts";

// What's on the canvas for a set of open groups, derived from the parser's
// output without reshaping it. Pure.

// Rows a panel shows at once. Past this it scrolls through a window of them.
export const MAX_ROWS = 12;
// Handle ids of the rows standing for files scrolled out above and below.
// Repo-relative paths never start with "/", so these can't collide with a row.
export const ABOVE_HANDLE = "/above";
export const BELOW_HANDLE = "/below";

export type Row = { path: string; label: string; fanIn: number; fanOut: number };

type Common = { id: string; dir: string; label: string; fileCount: number; fanIn: number; fanOut: number };
export type FoldedObject = Common & { kind: "folded" };
export type PanelObject = Common & {
  kind: "panel";
  rows: Row[];
  // Whether the files outnumber the window, so the panel scrolls.
  scrolls: boolean;
  // Index of the first shown row among all the group's ranked files.
  offset: number;
  above: number;
  below: number;
  // Longest row label at any offset, so the panel's width holds still while it
  // scrolls. A label unique among every file in the open panels is at least as
  // long as one unique among the rows shown, so this bounds them all.
  rowChars: number;
};
export type MapObject = FoldedObject | PanelObject;

export type Endpoint = { object: string; handle: string | null };
export type MapEdge = { id: string; source: string; sourceHandle: string | null; target: string; targetHandle: string | null };
export type MapView = { objects: MapObject[]; edges: MapEdge[]; endpointOf: ReadonlyMap<string, Endpoint> };

/** Build the stable canvas object identifier for a directory. */
export function groupId(dir: string): string {
  return `dir:${dir}`;
}

/**
 * A file's category is its extension: a fact read off the path, not a guess
 * about what the file does.
 */
export function categoryOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "(none)" : name.slice(dot + 1);
}

/** Format an extension for display, preserving the marker for files without one. */
export function categoryLabel(category: string): string {
  return category === "(none)" ? category : `.${category}`;
}

/** Count paths by extension, sorting by descending count and then category name. */
export function countByCategory(paths: readonly string[]): { category: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const p of paths) counts.set(categoryOf(p), (counts.get(categoryOf(p)) ?? 0) + 1);
  return [...counts]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
}

/** The shortest trailing run of path segments no other path on screen shares. */
export function shortestUniqueLabels(paths: readonly string[]): Map<string, string> {
  const split = paths.map((p) => [p, p.split("/")] as const);
  const labels = new Map<string, string>();
  for (const [path, segments] of split) {
    let k = 1;
    for (; k < segments.length; k++) {
      const suffix = segments.slice(-k).join("/");
      if (!split.some(([other, s]) => other !== path && s.slice(-k).join("/") === suffix)) break;
    }
    labels.set(path, segments.slice(-k).join("/"));
  }
  return labels;
}

/** Most depended-on files first, so an unscrolled panel shows the ones that matter. */
export function rankFiles(paths: readonly string[], byPath: ReadonlyMap<string, MapFile>): string[] {
  return [...paths].sort((a, b) => (byPath.get(b)?.fanIn ?? 0) - (byPath.get(a)?.fanIn ?? 0) || a.localeCompare(b));
}

/** Round and clamp a requested row offset so the panel window stays within the file list. */
export function clampOffset(requested: number, count: number): number {
  return Math.max(0, Math.min(Math.round(requested), count - MAX_ROWS));
}

/**
 * Derive folded objects, open panel rows, and merged edges from file-level graph data.
 * Offscreen files share boundary handles; edges within one object are omitted.
 * Throws when an edge endpoint is missing from the folding.
 */
export function buildView(
  files: readonly MapFile[],
  edges: readonly Edge[],
  folding: Folding,
  // Open groups, each with its scroll offset. Clamped here, so any number is safe.
  open: ReadonlyMap<string, number>,
): MapView {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const fan = groupFan(folding, edges);
  const groupLabels = shortestUniqueLabels(folding.groups.map((g) => g.dir));

  const windows = new Map<string, { ranked: string[]; offset: number; shown: string[] }>();
  for (const g of folding.groups) {
    const requested = open.get(groupId(g.dir));
    if (requested === undefined) continue;
    const ranked = rankFiles(g.files, byPath);
    const offset = clampOffset(requested, ranked.length);
    windows.set(g.dir, { ranked, offset, shown: ranked.slice(offset, offset + MAX_ROWS) });
  }
  const rowLabels = shortestUniqueLabels([...windows.values()].flatMap((w) => w.shown));
  const widestLabels = shortestUniqueLabels([...windows.values()].flatMap((w) => w.ranked));

  const objects = folding.groups.map((g): MapObject => {
    const common: Common = {
      id: groupId(g.dir),
      dir: g.dir,
      label: g.dir === "." ? "(root)" : (groupLabels.get(g.dir) ?? g.dir),
      fileCount: g.files.length,
      fanIn: fan.get(g.dir)?.fanIn ?? 0,
      fanOut: fan.get(g.dir)?.fanOut ?? 0,
    };
    const w = windows.get(g.dir);
    if (!w) return { ...common, kind: "folded" };
    return {
      ...common,
      kind: "panel",
      scrolls: w.ranked.length > MAX_ROWS,
      offset: w.offset,
      above: w.offset,
      below: w.ranked.length - w.offset - w.shown.length,
      rowChars: Math.max(0, ...w.ranked.map((f) => widestLabels.get(f)?.length ?? f.length)),
      rows: w.shown.map((path) => ({
        path,
        label: rowLabels.get(path) ?? path,
        fanIn: byPath.get(path)?.fanIn ?? 0,
        fanOut: byPath.get(path)?.fanOut ?? 0,
      })),
    };
  });

  const endpointOf = new Map<string, Endpoint>();
  for (const g of folding.groups) {
    const object = groupId(g.dir);
    const w = windows.get(g.dir);
    if (!w) {
      for (const f of g.files) endpointOf.set(f, { object, handle: null });
      continue;
    }
    w.ranked.forEach((f, i) => {
      const handle = i < w.offset ? ABOVE_HANDLE : i >= w.offset + w.shown.length ? BELOW_HANDLE : f;
      endpointOf.set(f, { object, handle });
    });
  }

  const merged = new Map<string, MapEdge>();
  for (const e of edges) {
    const from = endpointOf.get(e.from);
    const to = endpointOf.get(e.to);
    if (!from || !to) throw new Error(`Edge ${e.from} -> ${e.to} has an endpoint outside the folding`);
    // An edge inside one canvas object would loop back into its own box, so it
    // isn't drawn. It still counts in the files' fan.
    if (from.object === to.object) continue;
    const id = `${from.object}|${from.handle ?? ""}>${to.object}|${to.handle ?? ""}`;
    if (!merged.has(id)) {
      merged.set(id, { id, source: from.object, sourceHandle: from.handle, target: to.object, targetHandle: to.handle });
    }
  }

  return { objects, edges: [...merged.values()].sort((a, b) => a.id.localeCompare(b.id)), endpointOf };
}

/**
 * A group's fan counts distinct files across its boundary, the same unit a
 * file's own fan-in and fan-out use.
 */
export function groupFan(folding: Folding, edges: readonly Edge[]): Map<string, { fanIn: number; fanOut: number }> {
  const into = new Map<string, Set<string>>();
  const outOf = new Map<string, Set<string>>();
  for (const e of edges) {
    const s = folding.groupOf.get(e.from);
    const t = folding.groupOf.get(e.to);
    if (s === undefined || t === undefined || s === t) continue;
    into.set(t, (into.get(t) ?? new Set()).add(e.from));
    outOf.set(s, (outOf.get(s) ?? new Set()).add(e.to));
  }
  return new Map(
    folding.groups.map((g) => [g.dir, { fanIn: into.get(g.dir)?.size ?? 0, fanOut: outOf.get(g.dir)?.size ?? 0 }]),
  );
}

export type Selection = { kind: "group"; id: string } | { kind: "file"; path: string } | null;

/** Combine an object ID and optional row handle into a selection and hover lookup key. */
export function endpointKey(object: string, handle: string | null): string {
  return `${object}|${handle ?? ""}`;
}

/**
 * What stays at full strength: the selection, its edges, and whatever those
 * edges end on. Null when nothing is selected, meaning everything is bright.
 */
export function highlight(
  view: MapView,
  edges: readonly Edge[],
  selection: Selection,
): {
  endpoints: ReadonlySet<string>;
  objects: ReadonlySet<string>;
  // Drawn edges into the selection (its importers) and out of it (its imports).
  incoming: ReadonlySet<string>;
  outgoing: ReadonlySet<string>;
} | null {
  if (!selection) return null;
  const endpoints = new Set<string>();
  const incoming = new Set<string>();
  const outgoing = new Set<string>();

  if (selection.kind === "group") {
    for (const e of view.edges) {
      if (e.target === selection.id) {
        incoming.add(e.id);
        endpoints.add(endpointKey(e.source, e.sourceHandle));
      } else if (e.source === selection.id) {
        outgoing.add(e.id);
        endpoints.add(endpointKey(e.target, e.targetHandle));
      }
    }
    return { endpoints, objects: new Set([selection.id]), incoming, outgoing };
  }

  const at = view.endpointOf.get(selection.path);
  if (!at) return null;
  const self = endpointKey(at.object, at.handle);
  endpoints.add(self);
  // Neighbours come from the file edges, not the drawn ones, so a neighbour in
  // the same panel, whose edge isn't drawn, still stays bright.
  for (const e of edges) {
    const other = e.from === selection.path ? e.to : e.to === selection.path ? e.from : null;
    const there = other === null ? undefined : view.endpointOf.get(other);
    if (there) endpoints.add(endpointKey(there.object, there.handle));
  }
  for (const e of view.edges) {
    if (endpointKey(e.target, e.targetHandle) === self) incoming.add(e.id);
    else if (endpointKey(e.source, e.sourceHandle) === self) outgoing.add(e.id);
  }
  return { endpoints, objects: new Set(), incoming, outgoing };
}

/**
 * Each file's direct imports and importers, sorted by path. Read straight off
 * the edge list, so a count shown beside a list is that list's length.
 */
export function adjacency(edges: readonly Edge[]): Map<string, { imports: string[]; importedBy: string[] }> {
  const out = new Map<string, { imports: string[]; importedBy: string[] }>();
  /** Get or initialize the mutable adjacency lists for a file path. */
  const at = (path: string) => {
    let entry = out.get(path);
    if (!entry) out.set(path, (entry = { imports: [], importedBy: [] }));
    return entry;
  };
  for (const e of edges) {
    at(e.from).imports.push(e.to);
    at(e.to).importedBy.push(e.from);
  }
  for (const entry of out.values()) {
    entry.imports.sort();
    entry.importedBy.sort();
  }
  return out;
}
