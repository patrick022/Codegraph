"use client";

import dagre from "@dagrejs/dagre";
import {
  ReactFlow,
  ReactFlowProvider,
  getViewportForBounds,
  useReactFlow,
  useStore,
  type Edge as FlowEdge,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Folding } from "@/lib/map/fold";
import {
  buildView,
  clampOffset,
  endpointKey,
  groupId,
  highlight,
  MAX_ROWS,
  rankFiles,
  type MapEdge,
  type MapObject,
  type Selection,
} from "@/lib/map/view";
import type { MapFile } from "@/lib/map/types";
import { UNCLASSIFIED } from "@/lib/roles";
import type { Edge } from "@/parser/types";
import { FoldedNodeView, HEADER_HEIGHT, MapContext, PAD_X, PanelNodeView, ROW_HEIGHT, type FoldedNode, type PanelNode } from "./nodes";

const nodeTypes: NodeTypes = { folded: FoldedNodeView, panel: PanelNodeView };
const FIT_PADDING = 0.06;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 2;
// The first fit may enlarge a small graph a little, never to poster size.
const INITIAL_MAX_ZOOM = 1.25;

const CHAR_WIDTH = 6.6; // Geist Mono advance at 11px
const FOLDED_MIN_WIDTH = 120;
const FOLDED_MIN_HEIGHT = 40;
const FOLDED_MAX_HEIGHT = 160;
const FAN_IN_SCALE = 8;
const ROW_EXTRA_WIDTH = 84; // swatch, gaps and the fan counts
const PANEL_MIN_WIDTH = 200;
const PANEL_MAX_WIDTH = 440;

type Box = { x: number; y: number; width: number; height: number };

/**
 * Height carries how many files depend on the node; sqrt so one hub doesn't
 * flatten everything else to the minimum. Width comes from the label alone, so
 * a long name doesn't read as an important folder.
 */
function sizeOf(o: MapObject): { width: number; height: number } {
  const labelWidth = o.label.length * CHAR_WIDTH + 2 * PAD_X;
  if (o.kind === "folded") {
    return {
      width: Math.ceil(Math.max(FOLDED_MIN_WIDTH, labelWidth)),
      height: Math.round(Math.min(FOLDED_MAX_HEIGHT, FOLDED_MIN_HEIGHT + FAN_IN_SCALE * Math.sqrt(o.fanIn))),
    };
  }
  const widest = Math.max(labelWidth, o.rowChars * CHAR_WIDTH + 2 * PAD_X + ROW_EXTRA_WIDTH);
  // A scrolling panel always keeps its above and below rows, so its size is
  // the same at every offset and scrolling never moves the layout.
  return {
    width: Math.ceil(Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, widest))),
    height: HEADER_HEIGHT + (o.rows.length + (o.scrolls ? 2 : 0)) * ROW_HEIGHT,
  };
}

/**
 * Deterministic: objects and edges arrive sorted and dagre has no randomness,
 * so the same data and the same open set give the same picture.
 */
function layout(objects: readonly MapObject[], edges: readonly MapEdge[]): Map<string, Box> {
  const g = new dagre.graphlib.Graph<object, { width: number; height: number; x?: number; y?: number }, object>();
  g.setGraph({ rankdir: "LR", nodesep: 16, ranksep: 72 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const o of objects) g.setNode(o.id, sizeOf(o));
  // Row-level lines between the same two objects are one layout constraint.
  for (const e of edges) if (!g.hasEdge(e.source, e.target)) g.setEdge(e.source, e.target);
  dagre.layout(g);

  const boxes = new Map<string, Box>();
  for (const o of objects) {
    const n = g.node(o.id);
    if (n.x === undefined || n.y === undefined) throw new Error(`Layout gave ${o.id} no position`);
    // dagre positions centres; React Flow positions top-left corners.
    boxes.set(o.id, { x: n.x - n.width / 2, y: n.y - n.height / 2, width: n.width, height: n.height });
  }
  return boxes;
}

type MapProps = {
  files: MapFile[];
  edges: Edge[];
  folding: Folding;
  selection: Selection;
  onSelect: (selection: Selection) => void;
  // A file hovered here or in the detail pane; a group only from here.
  hover: Selection;
  onHover: (hover: Selection) => void;
  // The rail's category, a role or UNCLASSIFIED: files outside it dim. Null when none is picked.
  category: string | null;
};
type OpenState = { open: ReadonlyMap<string, number>; refit: number };

/** Render the interactive dependency map inside its React Flow provider. */
export function DependencyMap(props: MapProps) {
  return (
    <ReactFlowProvider>
      <MapCanvas {...props} />
    </ReactFlowProvider>
  );
}

/** Manage open panels and viewport fitting while rendering shared selection and hover state. */
function MapCanvas({ files, edges, folding, selection, onSelect, hover, onHover, category }: MapProps) {
  // `open` and `refit` change in the same update, so the refit effect only
  // ever sees the boxes of the layout the open produced, never the one before.
  const [{ open, refit }, setOpenState] = useState<OpenState>({ open: new Map(), refit: 0 });
  const byPath = useMemo(() => new Map(files.map((f) => [f.path, f])), [files]);

  // A file can be selected from outside the map, so whenever the selection
  // changes its row is brought on screen. Adjusted during render rather than
  // in an effect, so the map never draws a frame without the row.
  const [revealed, setRevealed] = useState(selection);
  if (revealed !== selection) {
    setRevealed(selection);
    if (selection?.kind === "file") setOpenState((s) => reveal(s, selection.path, folding, byPath));
  }

  const view = useMemo(() => buildView(files, edges, folding, open), [files, edges, folding, open]);
  const boxes = useMemo(() => layout(view.objects, view.edges), [view]);
  const lit = useMemo(() => highlight(view, edges, selection), [view, edges, selection]);
  // Per group, so a folded box can say how many matches it holds too, and every
  // box's count adds up to the rail's.
  const matches = useMemo(
    () =>
      category === null
        ? null
        : new Map(
            folding.groups.map((g) => [groupId(g.dir), g.files.filter((f) => (byPath.get(f)?.role ?? UNCLASSIFIED) === category).length]),
          ),
    [folding, category, byPath],
  );
  const hovered = hover?.kind === "file" ? view.endpointOf.get(hover.path) : undefined;
  const hoverKey = hovered ? endpointKey(hovered.object, hovered.handle) : null;

  const nodes = useMemo(
    () =>
      view.objects.map((o): FoldedNode | PanelNode => {
        const box = boxes.get(o.id);
        if (!box) throw new Error(`No layout box for ${o.id}`);
        // nopan: a press on a node would otherwise start a canvas pan, and the
        // pan swallows the click if the pointer drifts more than a pixel, which
        // a real hand on a mouse or trackpad usually does. Pan from empty canvas.
        const base = { id: o.id, className: "nopan", position: { x: box.x, y: box.y }, width: box.width, height: box.height };
        return o.kind === "folded" ? { ...base, type: "folded", data: o } : { ...base, type: "panel", data: o };
      }),
    [view, boxes],
  );

  const flowEdges = useMemo(() => {
    const dim: FlowEdge[] = [];
    const bright: FlowEdge[] = [];
    for (const e of view.edges) {
      // Direction only gets colour relative to a selection: green flows into
      // it, amber flows out of it.
      const stroke = lit?.incoming.has(e.id) ? "var(--incoming)" : lit?.outgoing.has(e.id) ? "var(--outgoing)" : undefined;
      (stroke ? bright : dim).push({
        ...e,
        // An edge belongs to no category, so picking one dims every edge the
        // selection hasn't lit.
        style: { stroke: stroke ?? "var(--edge)", strokeWidth: 0.75, opacity: (lit || category !== null) && !stroke ? 0.15 : 1 },
      });
    }
    // Bright edges drawn last so they cross over the dim ones.
    return [...dim, ...bright];
  }, [view, lit, category]);

  const refitted = useRef(refit);
  const { getZoom, setViewport } = useReactFlow();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  useEffect(() => {
    if (refitted.current === refit) return;
    refitted.current = refit;
    // Capping the fit at the current zoom means it can only zoom out.
    setViewport(getViewportForBounds(boundsOf(boxes), width, height, MIN_ZOOM, getZoom(), FIT_PADDING));
  }, [refit, boxes, width, height, getZoom, setViewport]);

  const context = useMemo(
    () => ({
      close: (id: string) => {
        setOpenState((s) => {
          const next = new Map(s.open);
          next.delete(id);
          return { open: next, refit: s.refit };
        });
        // A selection inside what just folded has nothing left to point at.
        if (
          (selection?.kind === "group" && selection.id === id) ||
          (selection?.kind === "file" && view.endpointOf.get(selection.path)?.object === id)
        ) {
          onSelect(null);
        }
      },
      selectFile: (path: string) => onSelect({ kind: "file", path }),
      // No refit: scrolling keeps the panel's size, so nothing else moves.
      scroll: (id: string, offset: number) =>
        setOpenState((s) => (s.open.has(id) ? { open: new Map(s.open).set(id, offset), refit: s.refit } : s)),
      selection,
      lit,
      hoverKey,
      onHover,
      category,
      matches,
    }),
    [selection, lit, view, onSelect, hoverKey, onHover, category, matches],
  );

  return (
    <MapContext.Provider value={context}>
      <ReactFlow
        nodes={nodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        minZoom={MIN_ZOOM}
        maxZoom={MAX_ZOOM}
        fitView
        fitViewOptions={{ padding: FIT_PADDING, maxZoom: INITIAL_MAX_ZOOM }}
        proOptions={{ hideAttribution: true }}
        // Clicking a folded node opens it and selects it. Panel header and row
        // clicks bubble here too and are handled inside the panel.
        onNodeClick={(_, node) => {
          if (node.type !== "folded") return;
          setOpenState((s) => ({ open: new Map(s.open).set(node.id, 0), refit: s.refit + 1 }));
          onSelect({ kind: "group", id: node.id });
        }}
        onNodeMouseEnter={(_, node) => node.type === "folded" && onHover({ kind: "group", id: node.id })}
        onNodeMouseLeave={(_, node) => node.type === "folded" && onHover(null)}
        onPaneClick={() => onSelect(null)}
      />
    </MapContext.Provider>
  );
}

/**
 * The open state with `path`'s row on screen: its group opened, or its panel
 * scrolled the least distance that shows it. Unchanged if it already shows.
 */
function reveal(s: OpenState, path: string, folding: Folding, byPath: ReadonlyMap<string, MapFile>): OpenState {
  const dir = folding.groupOf.get(path);
  const group = folding.groups.find((g) => g.dir === dir);
  if (!group) return s;
  const id = groupId(group.dir);
  const i = rankFiles(group.files, byPath).indexOf(path);
  const requested = s.open.get(id);
  const offset = clampOffset(requested ?? 0, group.files.length);
  if (requested !== undefined && i >= offset && i < offset + MAX_ROWS) return s;
  return {
    open: new Map(s.open).set(id, i < offset ? i : Math.max(0, i - MAX_ROWS + 1)),
    refit: requested === undefined ? s.refit + 1 : s.refit,
  };
}

/** Return the enclosing rectangle for a nonempty collection of layout boxes. */
function boundsOf(boxes: ReadonlyMap<string, Box>): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of boxes.values()) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
