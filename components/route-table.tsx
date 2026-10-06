"use client";

import { useState } from "react";
import type { Selection } from "@/lib/map/view";
import type { Coverage, Route } from "@/parser/types";

/**
 * Every route the adapters recovered, one row per method and pattern. Clicking
 * a row selects the file that declares it, so the pane shows that file while
 * the table stays open. Nothing here is inferred: what the adapters couldn't
 * read exactly is listed underneath with the reason, not guessed into a row.
 */
export function RouteTable({
  routes,
  coverage,
  selection,
  hover,
  onSelect,
  onHover,
}: {
  routes: Route[];
  coverage: Coverage["routes"];
  selection: Selection;
  hover: Selection;
  onSelect: (selection: Selection) => void;
  onHover: (hover: Selection) => void;
}) {
  const [omittedOpen, setOmittedOpen] = useState(false);
  const selectedFile = selection?.kind === "file" ? selection.path : null;
  const hoveredFile = hover?.kind === "file" ? hover.path : null;
  const file = (path: string) => ({
    onClick: () => onSelect({ kind: "file", path }),
    onMouseEnter: () => onHover({ kind: "file", path }),
    onMouseLeave: () => onHover(null),
  });

  return (
    <div className="absolute inset-0 overflow-y-auto bg-surface text-[11px]">
      <p className="border-b border-border px-3 py-1.5 text-muted">
        Listed only where the method and the full path are both written in the code.
      </p>
      {coverage.withheld.map((w) => (
        <p key={w.project} className="border-b border-border px-3 py-1.5">
          <span>No routes listed{w.project === "." ? "" : <> in <span className="font-mono">{w.project}/</span></>}:</span>{" "}
          <span className="text-muted">{w.reason}.</span>
        </p>
      ))}

      {routes.length === 0 ? (
        <p className="px-3 py-2 text-muted">No routes.</p>
      ) : (
        <table className="w-full border-collapse">
          <thead className="sticky top-0 bg-surface">
            <tr className="h-[22px] border-b border-border text-left text-[10px] text-muted">
              <th className="w-16 px-3 font-normal">Method</th>
              <th className="px-3 font-normal">Pattern</th>
              <th className="px-3 font-normal">Declared in</th>
            </tr>
          </thead>
          <tbody>
            {routes.map((r) => (
              <tr
                key={`${r.method} ${r.path} ${r.file}`}
                {...file(r.file)}
                className={`h-[22px] cursor-pointer font-mono ${
                  r.file === selectedFile
                    ? "bg-accent/15 shadow-[inset_2px_0_0_var(--accent)]"
                    : r.file === hoveredFile
                      ? "bg-bg"
                      : "hover:bg-bg"
                }`}
              >
                <td className="px-3">{r.method}</td>
                <td className="px-3 break-all">{r.path}</td>
                <td className="px-3 text-muted" title={r.file}>
                  {r.file}:{r.line}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {coverage.omitted.length > 0 && (
        <section className="border-t border-border">
          <button
            type="button"
            aria-expanded={omittedOpen}
            onClick={() => setOmittedOpen(!omittedOpen)}
            className="flex w-full items-baseline gap-1.5 px-3 py-1.5 text-left hover:bg-bg"
          >
            <span className="w-2 text-muted">{omittedOpen ? "▾" : "▸"}</span>
            <span>Not listed</span>
            <span className="text-muted">declared, but the method or full path isn&apos;t written out</span>
            <span className="ml-auto text-muted tabular-nums">{coverage.omitted.length}</span>
          </button>
          {omittedOpen && (
            <ul className="pb-2">
              {coverage.omitted.map((o) => (
                <li key={`${o.file}:${o.line}:${o.reason}`}>
                  <button type="button" {...file(o.file)} className="flex w-full gap-3 px-3 py-0.5 text-left hover:bg-bg">
                    <span className="shrink-0 font-mono text-muted">
                      {o.file}:{o.line}
                    </span>
                    <span className="text-muted">{o.reason}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
