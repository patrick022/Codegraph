// The invented-path check over real traffic.
//
//   pnpm eval:paths                     score the most recent explanations the app gave
//   pnpm eval:paths <run id> <file>     check the text in <file> against what that run's
//                                       model was shown; exits 1 if it names anything else
//
// The app already scores every answer the model writes (the run's
// "no-invented-paths" feedback). This reads the same runs back and checks them
// again from the trace alone: the listed paths from the run's input, the
// source from the model call under it. A cache hit repeats an answer scored
// where it was written, so hits are counted and skipped.

import "../scripts/env.ts";
import { readFileSync } from "node:fs";
import type { Run } from "langsmith/schemas";
import { langsmith, tracingStatus } from "../lib/ai/client.ts";
import { inventedPaths, shownPaths, type ShownInput } from "../lib/ai/invented-paths.ts";

const RECENT = 50;

const status = tracingStatus();
if (!status.on) {
  console.error(`FAIL tracing is off (${status.reason}), so there are no runs to read`);
  process.exit(1);
}
const client = langsmith();
const [runId, file] = process.argv.slice(2);

if (runId) {
  if (!file) {
    console.error("usage: pnpm eval:paths <run id> <file with the explanation text>");
    process.exit(1);
  }
  const run = await client.readRun(runId, { loadChildRuns: true });
  if (run.outputs?.cached === true) {
    console.error(`FAIL run ${runId} is a cache hit; check the run where that answer was written`);
    process.exit(1);
  }
  const shown = shownOf(run);
  const invented = inventedPaths(readFileSync(file, "utf8"), shown);
  console.log(`${run.name} of ${subject(run)}: the model was shown ${shown.size} paths`);
  for (const p of invented) console.log(`  invented  ${p}`);
  console.log(invented.length ? `${invented.length} invented` : "every path was shown");
  process.exit(invented.length ? 1 : 0);
}

let total = 0;
let clean = 0;
let hits = 0;
const flagged: string[] = [];
for await (const run of client.listRuns({
  projectName: status.project,
  isRoot: true,
  error: false,
  filter: 'or(eq(name, "explain-file"), eq(name, "explain-folder"))',
  limit: RECENT,
})) {
  const body: unknown = run.outputs?.body;
  if (typeof body !== "string") throw new Error(`Run ${run.id} finished without an explanation`);
  if (run.outputs?.cached === true) {
    hits++;
    continue;
  }
  const invented = inventedPaths(body, shownOf(await client.readRun(run.id, { loadChildRuns: true })));
  total++;
  if (invented.length === 0) clean++;
  else flagged.push(`${run.id}  ${run.name} of ${subject(run)}\n    ${invented.join("\n    ")}`);
}

console.log(`project ${status.project}, ${total} answers among the ${total + hits} most recent explanations (${hits} cache hits, scored where first written)`);
for (const f of flagged) console.log(f);
console.log(`no invented paths  ${clean}/${total}  ${total ? ((100 * clean) / total).toFixed(1) : "–"}%`);

// A run's inputs are the explanation's input as traced; only its paths are
// read. A file's source is read from the model call under it, as sent.
function shownOf(run: Run): Set<string> {
  const input = asShownInput(run.inputs);
  if (!input) throw new Error(`Run ${run.id} (${run.name}) isn't an explanation: its inputs have no paths to check against`);
  if ("dir" in input) return shownPaths(input);
  return shownPaths(input, sentSource(run, input.path));
}

// The user message ends with the source between markers (see explainFileMessage).
function sentSource(run: Run, path: string): string {
  const call = run.child_runs?.find((c) => c.run_type === "llm");
  const messages: unknown = call?.inputs.messages;
  const user = Array.isArray(messages) ? messages.find((m) => isRecord(m) && m.role === "user") : undefined;
  const content: unknown = isRecord(user) ? user.content : undefined;
  if (typeof content !== "string") throw new Error(`Run ${run.id} has no model call holding the message it was sent`);
  const open = `Source of ${path}:\n<<<\n`;
  const start = content.indexOf(open);
  const end = content.lastIndexOf("\n>>>");
  if (start === -1 || end < start) throw new Error(`Run ${run.id}'s message has no source for ${path}`);
  return content.slice(start + open.length, end);
}

function subject(run: Run): string {
  const input = asShownInput(run.inputs);
  return input === null ? "?" : "dir" in input ? `${input.dir}/` : input.path;
}

function asShownInput(value: unknown): ShownInput | null {
  if (!isRecord(value)) return null;
  const { path, imports, importedBy, dir, files, incoming, outgoing } = value;
  if (typeof path === "string" && isList(imports, hasPath) && isList(importedBy, hasPath)) return { path, imports, importedBy };
  if (typeof dir === "string" && isList(files, hasPath) && isList(incoming, isLink) && isList(outgoing, isLink)) return { dir, files, incoming, outgoing };
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isList<T>(v: unknown, item: (x: unknown) => x is T): v is T[] {
  return Array.isArray(v) && v.every(item);
}

function hasPath(v: unknown): v is { path: string } {
  return isRecord(v) && typeof v.path === "string";
}

function isLink(v: unknown): v is { from: string; to: string } {
  return isRecord(v) && typeof v.from === "string" && typeof v.to === "string";
}
