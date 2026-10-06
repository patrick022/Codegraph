"use client";

import { useMemo, useState, type ReactNode } from "react";
import type { Folding } from "@/lib/map/fold";
import { findInsights, LONG_LINES, reach, REACH_DEPTH, type Direction } from "@/lib/map/graph";
import { adjacency, categoryLabel, categoryOf, countByCategory, groupFan, groupId, type Selection } from "@/lib/map/view";
import { adapterNamed } from "@/parser/adapter";
import type { Edge, FileNode, ParseResult } from "@/parser/types";
import { CategorySwatch } from "../swatch";

export type Tab = "structure" | "explanation";

// How many rows each summary ranking shows before saying how many more.
const SUMMARY_ROWS = 10;

type PaneProps = {
  name: string;
  result: ParseResult;
  folding: Folding;
  selection: Selection;
  onSelect: (selection: Selection) => void;
  hover: Selection;
  onHover: (hover: Selection) => void;
  tab: Tab;
  onTab: (tab: Tab) => void;
  insightsOpen: boolean;
  onInsightsOpen: (open: boolean) => void;
};

type PathActions = Pick<PaneProps, "onSelect" | "onHover"> & { hovered: (path: string) => boolean };

/** Show repository, file, or folder details for the current selection with shared path interactions. */
export function DetailPane(props: PaneProps) {
  const { result, folding, selection, hover } = props;
  const byPath = useMemo(() => new Map(result.files.map((f) => [f.path, f])), [result.files]);
  const neighbours = useMemo(() => adjacency(result.edges), [result.edges]);
  const fan = useMemo(() => groupFan(folding, result.edges), [folding, result.edges]);

  /** A file hovered on the map, or a folded node holding it. */
  const hovered = (path: string) =>
    (hover?.kind === "file" && hover.path === path) ||
    (hover?.kind === "group" && hover.id === groupId(folding.groupOf.get(path) ?? ""));
  const paths: PathActions = { onSelect: props.onSelect, onHover: props.onHover, hovered };

  const file = selection?.kind === "file" ? byPath.get(selection.path) : undefined;
  const group = selection?.kind === "group" ? folding.groups.find((g) => groupId(g.dir) === selection.id) : undefined;

  let content: ReactNode;
  if (file) {
    content = (
      <Selected caption="file" title={<PathTitle path={file.path} paths={paths} />} tab={props.tab} onTab={props.onTab}>
        {/* Keyed so a walk shown for one file isn't carried over to the next. */}
        <FileStructure
          key={file.path}
          file={file}
          edges={result.edges}
          reachedBy={adapterNamed(result.adapter).reachedBy(file.path)}
          {...(neighbours.get(file.path) ?? { imports: [], importedBy: [] })}
          paths={paths}
        />
      </Selected>
    );
  } else if (group) {
    content = (
      <Selected
        caption="folder"
        title={<span className="font-mono text-[12px] break-all">{group.dir === "." ? "(root)" : `${group.dir}/`}</span>}
        tab={props.tab}
        onTab={props.onTab}
      >
        <FolderStructure files={group.files} fan={fan.get(group.dir) ?? { fanIn: 0, fanOut: 0 }} />
      </Selected>
    );
  } else {
    content = (
      <RepositorySummary
        name={props.name}
        result={result}
        paths={paths}
        insightsOpen={props.insightsOpen}
        onInsightsOpen={props.onInsightsOpen}
      />
    );
  }
  return <div className="min-h-0 flex-1 overflow-y-auto pb-3">{content}</div>;
}

// ── Nothing selected ─────────────────────────────────────────────────────────

/** Render repository coverage counts and ranked file lists when nothing is selected. */
function RepositorySummary(props: {
  name: string;
  result: ParseResult;
  paths: PathActions;
  insightsOpen: boolean;
  onInsightsOpen: (open: boolean) => void;
}) {
  const { name, result, paths } = props;
  const { files, edges, coverage, adapter } = result;
  const mostImported = useMemo(
    () => files.filter((f) => f.fanIn > 0).sort((a, b) => b.fanIn - a.fanIn || a.path.localeCompare(b.path)),
    [files],
  );
  // Nothing leads into these and they lead into the most, so reading starts here.
  const unimported = useMemo(
    () => files.filter((f) => f.fanIn === 0).sort((a, b) => b.fanOut - a.fanOut || a.path.localeCompare(b.path)),
    [files],
  );
  const skipped = coverage.files.skipped.length;
  const unresolved = coverage.imports.unresolved;

  return (
    <>
      <header className="border-b border-border px-3 py-2">
        <h2 className="font-mono text-[13px] font-semibold break-all">{name}</h2>
        <p className="mt-0.5 text-[11px] text-muted">
          Framework <span className="text-fg">{adapter === "none" ? "none detected" : adapter}</span>
        </p>
      </header>

      <dl className="grid grid-cols-3 border-b border-border">
        <Count label="Files" value={files.length} note={skipped > 0 ? `${skipped} skipped` : null} />
        <Count
          label="Imports"
          value={edges.length}
          note={unresolved > 0 ? `${unresolved} unresolved` : null}
          title="Distinct file-to-file imports resolved inside this repository"
        />
        {/* No adapter recovers routes yet, and zero would claim one looked. */}
        <Count
          label="Routes"
          value={null}
          note={adapter === "none" ? "no adapter" : null}
          title="No framework adapter recovered routes for this repository"
        />
      </dl>

      <RankedList
        title="Most depended on"
        hint="by files importing it"
        files={mostImported}
        figure={(f) => <span className="text-incoming">←{f.fanIn}</span>}
        paths={paths}
      />
      <RankedList
        title="Imported by nothing"
        hint="where reading starts"
        files={unimported}
        figure={(f) => <span className="text-outgoing">{f.fanOut}→</span>}
        paths={paths}
      />

      {/* The fallback adapter knows no conventions, so it identifies nothing. */}
      <section className="mt-3 px-3">
        <h3 className="flex items-baseline justify-between text-[11px] text-muted">
          <span>Unidentified by convention</span>
          <span className="text-fg tabular-nums">{adapter === "none" ? files.length : "—"}</span>
        </h3>
        <p className="mt-0.5 text-[11px] text-muted">No framework adapter applied, so no file was matched to a role.</p>
      </section>

      <Insights result={result} paths={paths} open={props.insightsOpen} onOpen={props.onInsightsOpen} />
    </>
  );
}

// Facts about the edge list, never a verdict on the code: collapsed until
// asked for, last in the summary, and each kind says one fixed sentence.
function Insights(props: { result: ParseResult; paths: PathActions; open: boolean; onOpen: (open: boolean) => void }) {
  const { files, edges, adapter } = props.result;
  const insights = useMemo(
    () => (props.open ? findInsights(files, edges, adapterNamed(adapter).reachedBy) : null),
    [props.open, files, edges, adapter],
  );
  return (
    <section className="mt-3 border-t border-border">
      <button
        type="button"
        aria-expanded={props.open}
        onClick={() => props.onOpen(!props.open)}
        className="flex h-7 w-full items-center gap-1.5 px-3 text-left text-[11px] hover:bg-bg"
      >
        <span className="w-2 text-muted">{props.open ? "▾" : "▸"}</span>
        <span>Insights</span>
      </button>
      {insights && (
        <>
          {/* Leads because it's where reading starts; the others read closer to a verdict. */}
          <InsightFiles
            title="Imported by nothing"
            sentence="Nothing imports these, and no convention the adapter knows reaches them."
            files={insights.unimported}
            figure={(f) => <span className="text-outgoing">{f.fanOut}→</span>}
            paths={props.paths}
          />
          <InsightFiles
            title="Imported unusually often"
            sentence="Far more files import these than import a typical file."
            files={insights.heavilyImported}
            figure={(f) => <span className="text-incoming">←{f.fanIn}</span>}
            paths={props.paths}
          />
          <section className="mt-3">
            <InsightHeading title="Import cycles" count={insights.cycles.length} />
            <InsightSentence>Each file imports the next, and the last imports the first.</InsightSentence>
            {insights.cycles.map((c) => (
              <div key={c.files.join()} className="mt-1.5">
                <p className="px-3 text-[10px] text-muted tabular-nums">
                  {c.files.length} in the loop
                  {c.tangled > c.files.length && ` · ${c.tangled} files reach each other through it`}
                </p>
                <ul>
                  {c.files.map((p) => (
                    <PathRow key={p} path={p} paths={props.paths} trailing={<span className="text-outgoing">→</span>} />
                  ))}
                </ul>
              </div>
            ))}
          </section>
          <InsightFiles
            title="Long files"
            sentence={`These files are over ${LONG_LINES.toLocaleString("en")} lines.`}
            files={insights.long}
            figure={(f) => <span className="text-muted">{f.lines}</span>}
            paths={props.paths}
          />
        </>
      )}
    </section>
  );
}

function InsightHeading({ title, count }: { title: string; count: number }) {
  return (
    <h3 className="flex items-baseline justify-between px-3 text-[11px]">
      <span>{title}</span>
      <span className="text-muted tabular-nums">{count}</span>
    </h3>
  );
}

function InsightSentence({ children }: { children: ReactNode }) {
  return <p className="px-3 pb-0.5 text-[11px] text-muted">{children}</p>;
}

function InsightFiles(props: {
  title: string;
  sentence: string;
  files: FileNode[];
  figure: (file: FileNode) => ReactNode;
  paths: PathActions;
}) {
  return (
    <section className="mt-3">
      <InsightHeading title={props.title} count={props.files.length} />
      <InsightSentence>{props.sentence}</InsightSentence>
      <ul>
        {props.files.map((f) => (
          <PathRow key={f.path} path={f.path} paths={props.paths} trailing={props.figure(f)} />
        ))}
      </ul>
    </section>
  );
}

/** Display a summary metric with optional context, using a dash for an unknown value. */
function Count({ label, value, note, title }: { label: string; value: number | null; note?: string | null; title?: string }) {
  return (
    <div className="border-r border-border px-3 py-2 last:border-r-0" title={title}>
      <dt className="text-[11px] text-muted">{label}</dt>
      <dd className="text-[15px] leading-5 tabular-nums">{value ?? <span className="text-muted">—</span>}</dd>
      {note && <dd className="text-[10px] text-muted tabular-nums">{note}</dd>}
    </div>
  );
}

/** Render up to SUMMARY_ROWS files in the supplied order and report how many remain hidden. */
function RankedList(props: {
  title: string;
  hint: string;
  files: FileNode[];
  figure: (file: FileNode) => ReactNode;
  paths: PathActions;
}) {
  const shown = props.files.slice(0, SUMMARY_ROWS);
  return (
    <section className="mt-3">
      <h3 className="flex items-baseline gap-1.5 px-3 pb-0.5 text-[11px] text-muted">
        <span className="text-fg">{props.title}</span>
        <span>{props.hint}</span>
        <span className="ml-auto tabular-nums">{props.files.length}</span>
      </h3>
      {shown.length === 0 ? (
        <p className="px-3 text-[11px] text-muted">None.</p>
      ) : (
        <ul>
          {shown.map((f) => (
            <PathRow key={f.path} path={f.path} paths={props.paths} trailing={props.figure(f)} />
          ))}
        </ul>
      )}
      {props.files.length > shown.length && (
        <p className="px-3 pt-0.5 text-[10px] text-muted tabular-nums">{props.files.length - shown.length} more not listed</p>
      )}
    </section>
  );
}

// ── Something selected ───────────────────────────────────────────────────────

/** Render the selected item header and tabs, showing structure or the explanation placeholder. */
function Selected(props: { caption: string; title: ReactNode; tab: Tab; onTab: (tab: Tab) => void; children: ReactNode }) {
  return (
    <>
      <header className="border-b border-border px-3 pt-2">
        <p className="text-[10px] text-muted">{props.caption}</p>
        <h2 className="leading-4">{props.title}</h2>
        <div role="tablist" className="mt-2 flex gap-3 text-[11px]">
          {(["structure", "explanation"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={props.tab === t}
              onClick={() => props.onTab(t)}
              className={`-mb-px border-b pb-1.5 capitalize ${
                props.tab === t ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </header>
      {props.tab === "structure" ? (
        props.children
      ) : (
        <p className="px-3 py-2 text-[11px] text-muted">No explanation yet. Nothing generates one in this build.</p>
      )}
    </>
  );
}

/**
 * Clickable like every other path in the pane: it brings the file back into
 * view on the map if its folder has been scrolled or closed since.
 */
function PathTitle({ path, paths }: { path: string; paths: PathActions }) {
  const slash = path.lastIndexOf("/");
  return (
    <button
      type="button"
      onClick={() => paths.onSelect({ kind: "file", path })}
      onMouseEnter={() => paths.onHover({ kind: "file", path })}
      onMouseLeave={() => paths.onHover(null)}
      className="text-left font-mono text-[12px] break-all hover:underline"
    >
      {slash >= 0 && <span className="text-muted">{path.slice(0, slash + 1)}</span>}
      <span className="font-semibold">{path.slice(slash + 1)}</span>
    </button>
  );
}

/** Counts are the lengths of the lists below them, so they can't disagree. */
function FileStructure({
  file,
  edges,
  reachedBy,
  imports,
  importedBy,
  paths,
}: {
  file: FileNode;
  edges: Edge[];
  reachedBy: string | null;
  imports: string[];
  importedBy: string[];
  paths: PathActions;
}) {
  const category = categoryOf(file.path);
  const [walk, setWalk] = useState<Direction | null>(null);
  return (
    <>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 border-b border-border px-3 py-2 text-[11px]">
        <Fact label="Kind">
          <span className="flex items-center gap-1.5 font-mono">
            <CategorySwatch category={category} />
            {categoryLabel(category)}
          </span>
        </Fact>
        <Fact label="Folder">
          <span className="font-mono break-all">{file.folder}</span>
        </Fact>
        <Fact label="Length">
          {file.lines} {file.lines === 1 ? "line" : "lines"}
        </Fact>
        <Fact label="Depends on">
          <span className="text-outgoing">{imports.length}</span> {imports.length === 1 ? "file" : "files"}
        </Fact>
        <Fact label="Depended on by">
          <span className="text-incoming">{importedBy.length}</span> {importedBy.length === 1 ? "file" : "files"}
        </Fact>
        <Fact label="Reached by">{reachedBy ?? <span className="text-muted">imports only</span>}</Fact>
      </dl>
      <div className="flex gap-1.5 border-b border-border px-3 py-2">
        <WalkButton direction="dependents" label="Blast radius" walk={walk} onWalk={setWalk} />
        <WalkButton direction="dependencies" label="Dependency chain" walk={walk} onWalk={setWalk} />
      </div>
      {walk && <ReachList path={file.path} edges={edges} direction={walk} paths={paths} />}
      <NeighbourList title="Imports" count={<span className="text-outgoing">{imports.length}→</span>} rows={imports} paths={paths} />
      <NeighbourList
        title="Imported by"
        count={<span className="text-incoming">←{importedBy.length}</span>}
        rows={importedBy}
        paths={paths}
      />
    </>
  );
}

function WalkButton(props: {
  direction: Direction;
  label: string;
  walk: Direction | null;
  onWalk: (walk: Direction | null) => void;
}) {
  const on = props.walk === props.direction;
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => props.onWalk(on ? null : props.direction)}
      className={`rounded-[3px] border px-2 py-0.5 text-[11px] ${
        on ? "border-accent bg-accent/15 text-fg" : "border-border text-muted hover:bg-bg hover:text-fg"
      }`}
    >
      {props.label}
    </button>
  );
}

// Worked out on the click from edges already in the browser: no request, no spinner.
function ReachList(props: { path: string; edges: Edge[]; direction: Direction; paths: PathActions }) {
  const { path, edges, direction } = props;
  const { steps, beyond } = useMemo(() => reach(edges, path, direction), [edges, path, direction]);
  const total = steps.reduce((n, s) => n + s.length, 0);
  const dependents = direction === "dependents";
  return (
    <section className="mt-3">
      <h3 className="flex items-baseline gap-1.5 px-3 pb-0.5 text-[11px] text-muted">
        <span className="text-fg">{dependents ? "Blast radius" : "Dependency chain"}</span>
        <span>{dependents ? "what imports this, directly or through others" : "what this imports, directly or through others"}</span>
        <span className={`ml-auto tabular-nums ${dependents ? "text-incoming" : "text-outgoing"}`}>{total}</span>
      </h3>
      {steps.map((list, i) => (
        <div key={i}>
          <h4 className="px-3 pt-1 text-[10px] text-muted tabular-nums">
            {i + 1} {i === 0 ? "step" : "steps"} away · {list.length}
          </h4>
          {list.length === 0 ? (
            <p className="px-3 text-[11px] text-muted">None.</p>
          ) : (
            <ul>
              {list.map((p) => (
                <PathRow key={p} path={p} paths={props.paths} />
              ))}
            </ul>
          )}
        </div>
      ))}
      <p className="px-3 pt-1 text-[10px] text-muted tabular-nums">
        {beyond > 0 ? `${beyond} more further than ${REACH_DEPTH} steps, not listed.` : `Nothing further than ${REACH_DEPTH} steps.`}
      </p>
    </section>
  );
}

/** Render selectable neighbouring file paths or an empty state beneath their count. */
function NeighbourList(props: { title: string; count: ReactNode; rows: string[]; paths: PathActions }) {
  return (
    <section className="mt-3">
      <h3 className="flex items-baseline justify-between px-3 pb-0.5 text-[11px]">
        <span>{props.title}</span>
        <span className="tabular-nums">{props.count}</span>
      </h3>
      {props.rows.length === 0 ? (
        <p className="px-3 text-[11px] text-muted">None.</p>
      ) : (
        <ul>
          {props.rows.map((p) => (
            <PathRow key={p} path={p} paths={props.paths} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** A folder's fan counts distinct files across its boundary, the unit a file's own counts use. */
function FolderStructure({ files, fan }: { files: string[]; fan: { fanIn: number; fanOut: number } }) {
  return (
    <>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 border-b border-border px-3 py-2 text-[11px]">
        <Fact label="Files">{files.length}</Fact>
        <Fact label="Imported from outside by">
          <span className="text-incoming">{fan.fanIn}</span> {fan.fanIn === 1 ? "file" : "files"}
        </Fact>
        <Fact label="Imports from outside">
          <span className="text-outgoing">{fan.fanOut}</span> {fan.fanOut === 1 ? "file" : "files"}
        </Fact>
      </dl>
      <section className="mt-3">
        <h3 className="px-3 pb-0.5 text-[11px]">Kinds of file inside</h3>
        <ul>
          {countByCategory(files).map(({ category, count }) => (
            <li key={category} className="flex h-[22px] items-center gap-2 px-3 text-[11px]">
              <CategorySwatch category={category} />
              <span className="flex-1 font-mono">{categoryLabel(category)}</span>
              <span className="text-muted tabular-nums">{count}</span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

/** Render a label and value pair in a detail definition list. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 tabular-nums">{children}</dd>
    </>
  );
}

/**
 * Every path in the pane is one of these: clicking moves the map's selection
 * to it, hovering marks it on the map, and it's marked here when the map
 * reports the pointer over it.
 */
function PathRow({ path, paths, trailing }: { path: string; paths: PathActions; trailing?: ReactNode }) {
  const slash = path.lastIndexOf("/");
  return (
    <li>
      <button
        type="button"
        title={path}
        onClick={() => paths.onSelect({ kind: "file", path })}
        onMouseEnter={() => paths.onHover({ kind: "file", path })}
        onMouseLeave={() => paths.onHover(null)}
        className={`flex h-[22px] w-full min-w-0 items-center gap-2 px-3 text-left text-[11px] ${
          paths.hovered(path) ? "bg-accent/15 shadow-[inset_2px_0_0_var(--accent)]" : "hover:bg-bg"
        }`}
      >
        <span className="flex min-w-0 flex-1 font-mono">
          {slash >= 0 && <span className="truncate text-muted">{path.slice(0, slash + 1)}</span>}
          <span className="shrink-0">{path.slice(slash + 1)}</span>
        </span>
        {trailing && <span className="shrink-0 text-[10px] tabular-nums">{trailing}</span>}
      </button>
    </li>
  );
}
