"use client";

import { useState } from "react";
import type { Coverage } from "@/parser/types";

/**
 * Says the graph is partial when it is. Collapsing keeps one line that still
 * names the figure, so a graph missing a third of its edges can never pass
 * for a complete one. Renders nothing only when nothing is missing.
 */
export function CoverageBanner({ coverage }: { coverage: Coverage }) {
  const [open, setOpen] = useState(true);
  const { imports } = coverage;
  // Declaration files are skipped by design and hold no runtime imports, so
  // leaving them out loses nothing from the graph. Any other skip does.
  const unparsed = coverage.files.skipped.filter((s) => s.reason !== "declaration-file");
  const runtimeFiles = coverage.files.parsed + unparsed.length;
  if (imports.unresolved === 0 && unparsed.length === 0) return null;

  const importShare = share(imports.total - imports.unresolved, imports.total);
  const fileShare = share(coverage.files.parsed, runtimeFiles);
  // The lower of the two is the headline: that's how complete the graph can be at best.
  const headline =
    importShare <= fileShare ? `${importShare}% of imports resolved` : `${fileShare}% of source files parsed`;

  return (
    <div className="shrink-0 border-b border-border bg-surface px-3 py-1.5 text-xs">
      <div className="flex items-baseline gap-2">
        <span className="font-medium">Partial graph · {headline}</span>
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="ml-auto text-muted hover:text-fg">
          {open ? "Collapse" : "Details"}
        </button>
      </div>
      {open && (
        <ul className="mt-0.5 text-muted">
          {imports.unresolved > 0 && (
            <li>
              {count(imports.unresolved, "import")} of {imports.total.toLocaleString("en-US")} couldn&apos;t be resolved to a
              file ({importShare}% resolved). Any edges they stand for are missing from the map, not absent from the code.
            </li>
          )}
          {unparsed.length > 0 && (
            <li>
              {count(unparsed.length, "source file")} of {runtimeFiles.toLocaleString("en-US")} weren&apos;t parsed (
              {reasons(unparsed)}), so neither they nor their imports are on the map.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/** Whole percent, rounded down: 99.6% of a graph is not 100% of it. */
function share(part: number, whole: number): number {
  return whole === 0 ? 100 : Math.floor((part / whole) * 100);
}

function count(n: number, noun: string): string {
  return `${n.toLocaleString("en-US")} ${noun}${n === 1 ? "" : "s"}`;
}

/** "2 syntax-error, 1 symlink". */
function reasons(skipped: Coverage["files"]["skipped"]): string {
  const by = new Map<string, number>();
  for (const s of skipped) by.set(s.reason, (by.get(s.reason) ?? 0) + 1);
  return [...by].map(([reason, n]) => `${n} ${reason}`).join(", ");
}
