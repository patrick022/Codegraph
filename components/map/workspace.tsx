"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import {
  explainFileAction,
  explainFolderAction,
  fileAtHeadAction,
  repositoryHeadAction,
  type HeadResult,
} from "@/app/(workspace)/analyses/[id]/actions";
import { foldDirectories } from "@/lib/map/fold";
import type { Selection } from "@/lib/map/view";
import type { MapData } from "@/lib/map/types";
import { railCategories, railLabel, type ModelRole, type RailKey } from "@/lib/roles";
import { RouteTable } from "../route-table";
import { DependencyMap } from "./canvas";
import { targetKey, type ExplainTarget, type ExplanationState, type Freshness } from "./explanation-panel";
import { DetailPane, type Tab } from "./pane";

/**
 * The rail, the centre column and the detail pane share one selection, one
 * hover and one category, so any side can drive the others. Everything here
 * is already in the browser: nothing in this workspace reaches the network
 * except the one Explain asks for.
 */
export function MapWorkspace(props: {
  analysisId: string;
  commitSha: string;
  name: string;
  result: MapData;
  /** Roles the model gave files no convention identified, by path. */
  modelRoles: Record<string, ModelRole>;
}) {
  const { analysisId, name, result } = props;
  // Explanations fetched on this page, by file or folder, so moving the
  // selection away and back finds the answer still there without asking again.
  const [explanations, setExplanations] = useState<ReadonlyMap<string, ExplanationState>>(() => new Map());
  const [freshness, setFreshness] = useState<ReadonlyMap<string, Freshness>>(() => new Map());
  const [modelRoles, setModelRoles] = useState<ReadonlyMap<string, ModelRole>>(() => new Map(Object.entries(props.modelRoles)));
  // The repository's latest commit, asked for once per page load: one answer serves every file.
  const head = useRef<Promise<HeadResult> | null>(null);

  const explain = useCallback(
    (target: ExplainTarget) => {
      const key = targetKey(target);
      setExplanations((prev) => new Map(prev).set(key, { status: "loading" }));
      setFreshness((prev) => new Map(prev).set(key, { status: "checking" }));

      void (async () => {
        let next: ExplanationState;
        try {
          const result = await (target.kind === "file" ? explainFileAction(analysisId, target.path) : explainFolderAction(analysisId, target.dir));
          next = result.ok ? { status: "done", result } : { status: "error", error: result.error };
          if (result.ok && target.kind === "file" && result.labelled?.role) {
            const role = result.labelled.role;
            setModelRoles((prev) => new Map(prev).set(target.path, role));
          }
        } catch {
          // A rejected action would otherwise leave the pane on "Explaining…" for good.
          next = { status: "error", error: "The request to explain this didn't complete" };
        }
        setExplanations((prev) => new Map(prev).set(key, next));
      })();

      // Alongside the explanation, not in front of it: a cached answer shows
      // at once, and whether it's current arrives when GitHub answers.
      void (async () => {
        let state: Freshness;
        try {
          const latest = await (head.current ??= repositoryHeadAction(analysisId));
          if (!latest.ok) head.current = null;
          if (!latest.ok) state = { status: "unknown", error: latest.error };
          else if (latest.head === latest.analysed) state = { status: "current" };
          else if (target.kind === "group") state = { status: "moved", head: latest.head, file: null };
          else {
            const file = await fileAtHeadAction(analysisId, target.path, latest.head);
            state = file.ok ? { status: "moved", head: latest.head, file: file.state } : { status: "unknown", error: file.error };
          }
        } catch {
          head.current = null;
          state = { status: "unknown", error: "the request to check didn't complete" };
        }
        setFreshness((prev) => new Map(prev).set(key, state));
      })();
    },
    [analysisId],
  );

  const folding = useMemo(() => foldDirectories(result.files), [result.files]);
  // The rail and the map's category focus count a model's label in its role's
  // row; the pane keeps it apart from convention's. The parse result itself
  // never carries one.
  const railFiles = useMemo(
    () => result.files.map((f) => (f.role === null && modelRoles.has(f.path) ? { ...f, role: modelRoles.get(f.path) ?? null } : f)),
    [result.files, modelRoles],
  );
  // The framework's roles in the taxonomy's fixed order, every one listed even
  // at zero, so each category sits in the same place every time.
  const categories = useMemo(
    () =>
      railCategories(
        result.projects.map((p) => p.adapter),
        railFiles.map((f) => f.role),
      ),
    [result.projects, railFiles],
  );
  const [selection, setSelection] = useState<Selection>(null);
  const [hover, setHover] = useState<Selection>(null);
  const [category, setCategory] = useState<RailKey | null>(null);
  // Held here rather than in the pane's content, so they survive a new selection.
  const [tab, setTab] = useState<Tab>("structure");
  const [insightsOpen, setInsightsOpen] = useState(false);
  // The centre column shows the map or the route table; the rail and the pane keep working on either.
  const [centre, setCentre] = useState<"map" | "routes">("map");

  // Fixed widths on the side columns: their content must never push the map around.
  return (
    <>
      <nav className="flex w-52 shrink-0 flex-col border-r border-border bg-surface" aria-label="Categories">
        <h2 className="flex h-8 shrink-0 items-center px-3 text-xs text-muted">
          Categories <span className="ml-1 tabular-nums">· {result.files.length} files</span>
        </h2>
        <ul className="min-h-0 overflow-y-auto">
          {categories.map(({ key, count }) => (
            <li key={key}>
              <button
                type="button"
                aria-pressed={category === key}
                disabled={count === 0}
                onClick={() => setCategory(category === key ? null : key)}
                className={`flex h-6 w-full items-center gap-2 px-3 text-left text-xs disabled:text-muted ${
                  category === key ? "bg-accent/15 shadow-[inset_2px_0_0_var(--accent)]" : "enabled:hover:bg-bg"
                } ${category !== null && category !== key ? "text-muted" : ""}`}
              >
                <span className="flex-1 truncate">{railLabel(key)}</span>
                <span className="text-muted tabular-nums">{count}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <section className="flex min-w-0 flex-1 flex-col" aria-label="Map">
        <div role="tablist" className="flex h-7 shrink-0 items-end gap-3 border-b border-border bg-surface px-3 text-[11px]">
          <CentreTab label="Map" on={centre === "map"} onClick={() => setCentre("map")} />
          <CentreTab label="Routes" count={result.routes.length} on={centre === "routes"} onClick={() => setCentre("routes")} />
        </div>
        <div className="relative min-h-0 flex-1">
          {/* The map stays mounted under the table, so switching back keeps its viewport. */}
          <div className={`absolute inset-0 ${centre === "map" ? "" : "invisible"}`}>
            <DependencyMap
              files={railFiles}
              edges={result.edges}
              folding={folding}
              selection={selection}
              onSelect={setSelection}
              hover={hover}
              onHover={setHover}
              category={category}
            />
          </div>
          {centre === "routes" && (
            <RouteTable
              routes={result.routes}
              coverage={result.coverage.routes}
              selection={selection}
              hover={hover}
              onSelect={setSelection}
              onHover={setHover}
            />
          )}
        </div>
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
          modelRoles={modelRoles}
          analysisId={analysisId}
          commitSha={props.commitSha}
          explanations={explanations}
          freshness={freshness}
          onExplain={explain}
        />
      </aside>
    </>
  );
}

function CentreTab({ label, count, on, onClick }: { label: string; count?: number; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={on}
      onClick={onClick}
      className={`-mb-px border-b pb-1.5 ${on ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg"}`}
    >
      {label}
      {count !== undefined && <span className="ml-1 text-muted tabular-nums">{count}</span>}
    </button>
  );
}
