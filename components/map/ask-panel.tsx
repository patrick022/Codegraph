"use client";

import { useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { readAskEvent, textChunks, type AskEvent, type AskSelection } from "@/lib/ask";
import { StateMark } from "../state-mark";
import { ExplanationText } from "./explanation-text";
import { InlinePath, type PathActions } from "./pane";

// Questions about the whole repository, answered by the agent. Each lookup it
// makes shows as a row the moment it starts, and the answer below them, so
// what the answer rests on is always in view.

type Step = { id: string; name: string; args: Record<string, string>; state: "running" | "complete" | "failed"; detail: string | null };
type Turn = { question: string; selected: AskSelection; steps: Step[]; answer: string | null; error: string | null; done: boolean };

export function AskPanel(props: { analysisId: string; selected: AskSelection; isPath: (path: string) => boolean; paths: PathActions }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const busy = turns.length > 0 && !turns[turns.length - 1].done;
  const end = useRef<HTMLDivElement>(null);

  const link = (path: string): ReactNode =>
    props.isPath(path) ? <InlinePath path={path} paths={props.paths} /> : <code className="font-mono text-[11px]">{path}</code>;

  // Only the last turn is ever live.
  const update = (change: (turn: Turn) => Turn) => setTurns((all) => [...all.slice(0, -1), change(all[all.length - 1])]);

  const apply = (event: AskEvent) => {
    if (event.type === "thread") return setThreadId(event.id);
    update((t) => {
      switch (event.type) {
        case "call":
          return { ...t, steps: [...t.steps, { id: event.id, name: event.name, args: event.args, state: "running", detail: null }] };
        case "result":
          return {
            ...t,
            steps: t.steps.map((s) => (s.id === event.id ? { ...s, state: event.ok ? "complete" : "failed", detail: event.detail } : s)),
          };
        case "answer":
          return { ...t, answer: event.text };
        case "error":
          return { ...t, error: event.message };
      }
    });
    end.current?.scrollIntoView({ block: "end" });
  };

  async function ask(question: string) {
    setTurns((all) => [...all, { question, selected: props.selected, steps: [], answer: null, error: null, done: false }]);
    setDraft("");
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ analysisId: props.analysisId, question, threadId, selected: props.selected }),
      });
      if (!res.ok || !res.body) {
        const error: unknown = Reflect.get(Object(await res.json().catch(() => null)), "error");
        throw new Error(typeof error === "string" ? error : `The request failed (${res.status})`);
      }
      let buffer = "";
      for await (const chunk of textChunks(res.body)) {
        const lines = (buffer + chunk).split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const event = line.trim() ? readAskEvent(line) : null;
          if (event) apply(event);
        }
      }
    } catch (e) {
      update((t) => ({ ...t, error: e instanceof Error ? e.message : "The request failed" }));
    } finally {
      update((t) => ({ ...t, done: true }));
    }
  }

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const question = draft.trim();
    if (question && !busy) void ask(question);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) submit(e);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {turns.length === 0 ? (
          <p className="px-3 py-3 text-[11px] text-muted">
            Ask about this repository&apos;s structure: where something lives, what depends on a file, what a change reaches, which
            routes exist. Every answer is looked up in the parsed graph, and each lookup is listed above it.
          </p>
        ) : (
          turns.map((turn, i) => (
            <section key={i} className="border-b border-border px-3 py-2.5">
              <p className="text-[12px] leading-[18px] font-medium break-words whitespace-pre-wrap">{turn.question}</p>
              {turn.selected && (
                <p className="mt-0.5 text-[10px] text-muted">
                  with the {turn.selected.kind} <span className="font-mono">{turn.selected.path}</span> selected
                </p>
              )}
              {turn.steps.length > 0 && (
                <ol className="mt-2 space-y-0.5">
                  {turn.steps.map((s) => (
                    <li key={s.id} className="text-[11px] leading-4">
                      <div className="flex items-start gap-1.5">
                        <span className={`mt-[3px] ${s.state === "failed" ? "text-fg" : "text-muted"}`}>
                          <StateMark status={s.state} />
                        </span>
                        <span className="min-w-0 break-words">{describe(s, link)}</span>
                      </div>
                      {s.detail && <p className="ml-4 break-words text-[10px] text-muted">{s.detail}</p>}
                    </li>
                  ))}
                </ol>
              )}
              {!turn.done && turn.steps.length === 0 && <p className="mt-2 text-[11px] text-muted">Starting…</p>}
              {turn.answer && (
                <div className="mt-2.5">
                  <ExplanationText text={turn.answer} isPath={props.isPath} onPath={link} />
                  {/* The one thing this panel exists to prevent, said plainly if it happens. */}
                  {turn.steps.length === 0 && <p className="mt-1.5 text-[10px] text-muted">Answered without looking anything up.</p>}
                </div>
              )}
              {turn.error && <p className="mt-2 break-words text-[11px]">{turn.error}</p>}
            </section>
          ))
        )}
        <div ref={end} />
      </div>
      <form onSubmit={submit} className="shrink-0 border-t border-border px-3 py-2">
        <p className="mb-1 flex items-center gap-2 text-[10px] text-muted">
          <span className="min-w-0 flex-1 truncate">
            {props.selected ? (
              <>
                Asking with <span className="font-mono">{props.selected.path}</span> selected
              </>
            ) : (
              "Asking about the whole repository"
            )}
          </span>
          {turns.length > 0 && !busy && (
            <button
              type="button"
              className="hover:text-fg"
              onClick={() => {
                setTurns([]);
                setThreadId(null);
              }}
            >
              New conversation
            </button>
          )}
        </p>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          rows={2}
          maxLength={2000}
          placeholder={busy ? "Looking it up…" : "Where is authentication handled?"}
          disabled={busy}
          className="block w-full resize-none rounded-[3px] border border-border bg-bg px-2 py-1 text-[12px] leading-[18px] outline-none focus:border-accent disabled:text-muted"
        />
      </form>
    </div>
  );
}

/** A lookup as the person would say it, with its file a link to the map. */
function describe(step: Step, link: (path: string) => ReactNode): ReactNode {
  const { query, role, file, direction } = step.args;
  switch (step.name) {
    case "analysis_summary":
      return "Read the analysis summary";
    case "search_files":
      return (
        <>
          Searched paths for <code className="font-mono">{query}</code>
        </>
      );
    case "files_by_role":
      return (
        <>
          Listed files with the role <code className="font-mono">{role}</code>
        </>
      );
    case "file_neighbours":
      return <>Direct imports of {file ? link(file) : "a file"}, both ways</>;
    case "walk_graph":
      return direction === "dependents" ? (
        <>Walked what depends on {file ? link(file) : "a file"}</>
      ) : (
        <>Walked what {file ? link(file) : "a file"} depends on</>
      );
    case "route_table":
      return "Read the route table";
    default:
      return <code className="font-mono">{step.name}</code>;
  }
}
