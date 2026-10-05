"use client";

import { Handle, Position, useUpdateNodeInternals, type Node, type NodeProps } from "@xyflow/react";
import { createContext, useContext, useEffect, useRef, type WheelEvent } from "react";
import {
  ABOVE_HANDLE,
  BELOW_HANDLE,
  categoryOf,
  endpointKey,
  MAX_ROWS,
  type FoldedObject,
  type highlight,
  type PanelObject,
  type Selection,
} from "@/lib/map/view";
import { CategorySwatch } from "../swatch";

export type FoldedNode = Node<FoldedObject, "folded">;
export type PanelNode = Node<PanelObject, "panel">;

// Sizes are px, not rem: dagre lays out in the units React Flow draws in, and
// these are shared with the layout so the box drawn is the box laid out.
export const PAD_X = 10;
export const HEADER_HEIGHT = 40;
export const ROW_HEIGHT = 20;

// Actions and selection come through context so node data stays the plain view
// object. Opening a folded node goes through React Flow's onNodeClick instead.
export const MapContext = createContext<{
  close: (id: string) => void;
  selectFile: (path: string) => void;
  // Move a panel's window to this offset; the view clamps it.
  scroll: (id: string, offset: number) => void;
  selection: Selection;
  lit: ReturnType<typeof highlight>;
  // Endpoint of the file hovered here or in the detail pane. It lights up even
  // when the selection would dim it.
  hoverKey: string | null;
  onHover: (hover: Selection) => void;
  // The rail's category, and how many of each group's files are in it.
  category: string | null;
  matches: ReadonlyMap<string, number> | null;
}>({
  close: () => {},
  selectFile: () => {},
  scroll: () => {},
  selection: null,
  lit: null,
  hoverKey: null,
  onHover: () => {},
  category: null,
  matches: null,
});

const DIM = "opacity-25";
const HOVER_RING = "outline outline-1 -outline-offset-1 outline-accent";
// Invisible anchors: an edge ends at the box or row, not at a dot.
const anchor = "!size-px !min-h-0 !min-w-0 !border-0 !bg-transparent";

/** Render a collapsed directory with dependency counts and edge anchors, dimmed by selection. */
export function FoldedNodeView({ id, data }: NodeProps<FoldedNode>) {
  const { lit, hoverKey, matches } = useContext(MapContext);
  const hovered = hoverKey === endpointKey(id, null);
  const matched = matches?.get(id) ?? null;
  const dim = !hovered && ((lit !== null && !lit.endpoints.has(endpointKey(id, null))) || matched === 0);
  return (
    <div
      title={data.dir}
      className={`flex size-full cursor-pointer flex-col justify-center gap-0.5 rounded border bg-surface hover:border-accent ${
        hovered ? "border-accent" : "border-border"
      } ${dim ? DIM : ""}`}
      style={{ paddingInline: PAD_X }}
    >
      <Handle type="target" position={Position.Left} className={anchor} isConnectable={false} />
      <span className="truncate font-mono text-[11px] leading-4">{data.label}</span>
      <Meta fileCount={data.fileCount} matched={matched} fanIn={data.fanIn} fanOut={data.fanOut} />
      <Handle type="source" position={Position.Right} className={anchor} isConnectable={false} />
    </div>
  );
}

/** Render an expanded directory with selectable file rows, paging, and synchronized edge handles. */
export function PanelNodeView({ id, data }: NodeProps<PanelNode>) {
  const { close, selectFile, scroll, selection, lit, hoverKey, onHover, category, matches } = useContext(MapContext);
  const whole = lit === null || lit.objects.has(id);
  /** Check whether this panel row is the endpoint of the currently hovered file. */
  const hovered = (handle: string) => hoverKey === endpointKey(id, handle);
  /** Keep a row bright when its panel is selected, it is hovered, or it neighbours the selection. */
  const bright = (handle: string) =>
    whole || hovered(handle) || (lit?.endpoints.has(endpointKey(id, handle)) ?? false);
  const anyBright =
    data.rows.some((r) => bright(r.path)) || (data.scrolls && (bright(ABOVE_HANDLE) || bright(BELOW_HANDLE)));
  const matched = matches?.get(id) ?? null;
  // A dim panel's rows aren't dimmed again, or they'd fade to nothing.
  const panelDim = !anyBright || matched === 0;
  const rowDim = (handle: string, inCategory: boolean) =>
    !panelDim && !hovered(handle) && ((anyBright && !bright(handle)) || !inCategory);

  // Wheel deltas come in pixels from trackpads and in lines from some mice;
  // they add up until they make a whole row, so slow scrolling still moves.
  const pending = useRef(0);
  /** Accumulate wheel movement and advance the panel window by whole rows. */
  function onWheel(event: WheelEvent) {
    if (!data.scrolls) return;
    pending.current += event.deltaMode === 1 ? event.deltaY * ROW_HEIGHT : event.deltaY;
    const rows = Math.trunc(pending.current / ROW_HEIGHT);
    if (rows === 0) return;
    pending.current -= rows * ROW_HEIGHT;
    scroll(id, data.offset + rows);
  }
  // React Flow measures handles when a node resizes. Scrolling swaps rows at a
  // fixed size, so the new rows' handles have to be measured explicitly or
  // their edges have nothing to attach to.
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => updateNodeInternals(id), [id, data.offset, updateNodeInternals]);

  return (
    <div
      className={`flex size-full flex-col overflow-hidden rounded border bg-surface ${
        whole && lit !== null ? "border-accent" : "border-muted"
      } ${panelDim ? DIM : ""}`}
    >
      <button
        type="button"
        onClick={() => close(id)}
        title={`${data.dir} — click to fold`}
        className="flex shrink-0 flex-col justify-center gap-0.5 border-b border-border text-left hover:bg-bg"
        style={{ height: HEADER_HEIGHT, paddingInline: PAD_X }}
      >
        <span className="truncate font-mono text-[11px] leading-4 font-semibold">{data.label}</span>
        <Meta fileCount={data.fileCount} matched={matched} fanIn={data.fanIn} fanOut={data.fanOut} />
      </button>
      {/* nowheel: over the rows the wheel scrolls them instead of zooming the map. */}
      <ul className={data.scrolls ? "nowheel" : undefined} onWheel={onWheel}>
        {data.scrolls && (
          <OffscreenRow
            handle={ABOVE_HANDLE}
            count={data.above}
            label="above"
            dim={rowDim(ABOVE_HANDLE, category === null)}
            hovered={hovered(ABOVE_HANDLE)}
            onClick={() => scroll(id, data.offset - MAX_ROWS)}
          />
        )}
        {data.rows.map((row) => {
          const selected = selection?.kind === "file" && selection.path === row.path;
          return (
            <li key={row.path} className="relative" style={{ height: ROW_HEIGHT }}>
              <Handle id={row.path} type="target" position={Position.Left} className={anchor} isConnectable={false} />
              <button
                type="button"
                onClick={() => selectFile(row.path)}
                onMouseEnter={() => onHover({ kind: "file", path: row.path })}
                onMouseLeave={() => onHover(null)}
                title={row.path}
                aria-pressed={selected}
                className={`flex size-full items-center gap-1.5 text-left text-[11px] ${
                  selected ? "bg-accent/15 shadow-[inset_2px_0_0_var(--accent)]" : "hover:bg-bg"
                } ${hovered(row.path) ? HOVER_RING : ""} ${
                  rowDim(row.path, category === null || categoryOf(row.path) === category) ? DIM : ""
                }`}
                style={{ paddingInline: PAD_X }}
              >
                <CategorySwatch category={categoryOf(row.path)} />
                <span className="min-w-0 flex-1 truncate font-mono">{row.label}</span>
                <Fan fanIn={row.fanIn} fanOut={row.fanOut} />
              </button>
              <Handle id={row.path} type="source" position={Position.Right} className={anchor} isConnectable={false} />
            </li>
          );
        })}
        {data.scrolls && (
          <OffscreenRow
            handle={BELOW_HANDLE}
            count={data.below}
            label="below"
            dim={rowDim(BELOW_HANDLE, category === null)}
            hovered={hovered(BELOW_HANDLE)}
            onClick={() => scroll(id, data.offset + MAX_ROWS)}
          />
        )}
      </ul>
    </div>
  );
}

/**
 * Stands for the files scrolled out of the window on one side. Edges to those
 * files end here, so they stay on the panel. Clicking pages that way.
 */
function OffscreenRow(props: {
  handle: string;
  count: number;
  label: string;
  dim: boolean;
  hovered: boolean;
  onClick: () => void;
}) {
  return (
    <li className="relative" style={{ height: ROW_HEIGHT }}>
      <Handle id={props.handle} type="target" position={Position.Left} className={anchor} isConnectable={false} />
      <button
        type="button"
        onClick={props.onClick}
        disabled={props.count === 0}
        className={`flex size-full items-center text-left text-[10px] text-muted tabular-nums enabled:hover:bg-bg enabled:hover:text-fg disabled:opacity-50 ${
          props.hovered ? HOVER_RING : ""
        } ${props.dim ? DIM : ""}`}
        style={{ paddingInline: PAD_X }}
      >
        {props.count} {props.count === 1 ? "file" : "files"} {props.label}
      </button>
      <Handle id={props.handle} type="source" position={Position.Right} className={anchor} isConnectable={false} />
    </li>
  );
}

/** Display the file count and incoming and outgoing dependency counts for a directory. */
function Meta(props: { fileCount: number; matched: number | null; fanIn: number; fanOut: number }) {
  const { fileCount, matched, fanIn, fanOut } = props;
  return (
    <span className="flex items-center gap-2 text-[10px] leading-3 text-muted tabular-nums">
      <span>
        {matched !== null && <span className="text-fg">{matched} of </span>}
        {fileCount} {fileCount === 1 ? "file" : "files"}
      </span>
      <Fan fanIn={fanIn} fanOut={fanOut} />
    </span>
  );
}

/** The same green and amber the edges use: what flows in, what flows out. */
function Fan({ fanIn, fanOut }: { fanIn: number; fanOut: number }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-[10px] tabular-nums">
      <span className="text-incoming" title="Distinct files that import this">
        ←{fanIn}
      </span>
      <span className="text-outgoing" title="Distinct files this imports">
        {fanOut}→
      </span>
    </span>
  );
}
