"use client";

import { useMemo, useState } from "react";
import { foldDirectories } from "@/lib/map/fold";
import { categoryLabel, countByCategory, type Selection } from "@/lib/map/view";
import type { MapData } from "@/lib/map/types";
import { CategorySwatch } from "../swatch";
import { DependencyMap } from "./canvas";
import { DetailPane, type Tab } from "./pane";

/**
 * The rail, the map and the detail pane share one selection, one hover and one
 * category, so any side can drive the others. Everything here is already in
 * the browser: nothing in this workspace reaches the network.
 */
export function MapWorkspace({ name, result }: { name: string; result: MapData }) {
  const folding = useMemo(() => foldDirectories(result.files), [result.files]);
  const categories = useMemo(() => countByCategory(result.files.map((f) => f.path)), [result.files]);
  const [selection, setSelection] = useState<Selection>(null);
  const [hover, setHover] = useState<Selection>(null);
  const [category, setCategory] = useState<string | null>(null);
  // Held here rather than in the pane's content, so they survive a new selection.
  const [tab, setTab] = useState<Tab>("structure");
  const [insightsOpen, setInsightsOpen] = useState(false);

  // Fixed widths on the side columns: their content must never push the map around.
  return (
    <>
      <nav className="flex w-52 shrink-0 flex-col border-r border-border bg-surface" aria-label="Categories">
        <h2 className="flex h-8 shrink-0 items-center px-3 text-xs text-muted">
          Categories <span className="ml-1 tabular-nums">· {result.files.length} files</span>
        </h2>
        <ul>
          {categories.map(({ category: c, count }) => (
            <li key={c}>
              <button
                type="button"
                aria-pressed={category === c}
                onClick={() => setCategory(category === c ? null : c)}
                className={`flex h-6 w-full items-center gap-2 px-3 text-left text-xs ${
                  category === c ? "bg-accent/15 shadow-[inset_2px_0_0_var(--accent)]" : "hover:bg-bg"
                } ${category !== null && category !== c ? "text-muted" : ""}`}
              >
                <CategorySwatch category={c} />
                <span className="flex-1 font-mono">{categoryLabel(c)}</span>
                <span className="text-muted tabular-nums">{count}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <section className="min-w-0 flex-1" aria-label="Map">
        <DependencyMap
          files={result.files}
          edges={result.edges}
          folding={folding}
          selection={selection}
          onSelect={setSelection}
          hover={hover}
          onHover={setHover}
          category={category}
        />
      </section>
      <aside className="flex w-80 shrink-0 flex-col border-l border-border bg-surface" aria-label="Details">
        <DetailPane
          name={name}
          result={result}
          folding={folding}
          selection={selection}
          onSelect={setSelection}
          hover={hover}
          onHover={setHover}
          tab={tab}
          onTab={setTab}
          insightsOpen={insightsOpen}
          onInsightsOpen={setInsightsOpen}
        />
      </aside>
    </>
  );
}
