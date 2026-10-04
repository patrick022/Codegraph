"use client";

import { useMemo, useState } from "react";
import { foldDirectories } from "@/lib/map/fold";
import type { Selection } from "@/lib/map/view";
import type { ParseResult } from "@/parser/types";
import { DependencyMap } from "./canvas";
import { DetailPane, type Tab } from "./pane";

/**
 * The map and the detail pane share one selection and one hover, so either
 * side can drive the other. Everything here is already in the browser:
 * selecting and hovering never reach the network.
 */
export function MapWorkspace({ name, result }: { name: string; result: ParseResult }) {
  const folding = useMemo(() => foldDirectories(result.files), [result.files]);
  const [selection, setSelection] = useState<Selection>(null);
  const [hover, setHover] = useState<Selection>(null);
  // Held here rather than in the pane's content, so it survives a new selection.
  const [tab, setTab] = useState<Tab>("structure");

  return (
    <>
      <section className="min-w-0 flex-1" aria-label="Map">
        <DependencyMap
          files={result.files}
          edges={result.edges}
          folding={folding}
          selection={selection}
          onSelect={setSelection}
          hover={hover}
          onHover={setHover}
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
        />
      </aside>
    </>
  );
}
