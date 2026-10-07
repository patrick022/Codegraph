import { createHash } from "node:crypto";
import { getCurrentRunTree, traceable } from "langsmith/traceable";
import { isModelRole, MODEL_ROLES, type ModelRole } from "../roles.ts";
import { ai, langsmith, MODELS, traceConfig, tracingStatus } from "./client.ts";
import { inventedPaths, shownPaths, type ShownInput } from "./invented-paths.ts";
import {
  CLASSIFY_SYSTEM,
  classifyMessage,
  EXPLAIN_FILE_SYSTEM,
  EXPLAIN_FOLDER_SYSTEM,
  explainFileMessage,
  explainFolderMessage,
  PROMPT_VERSION,
  type ClassifyInput,
  type FileInput,
  type FolderInput,
} from "./prompts.ts";

// The model calls, each behind its cache. The cache read is the first thing
// inside the traced function, so a hit is still a recorded run, one with no
// model call in it, and a broken cache is visible as a trace full of calls.

export type Task = "explain-file" | "explain-folder" | "classify-file";

export type Cache = {
  read: (key: string) => Promise<string | null>;
  write: (entry: { key: string; task: Task; model: string; body: string }) => Promise<void>;
};

export type Explanation = { body: string; model: string; cached: boolean };

// The source is only fetched on a miss: a hit answers from the stored hash alone.
export type SourceOf = () => Promise<string>;

// A backstop against an unexpectedly huge prompt; the model is told when it applies.
const MAX_SOURCE_CHARS = 120_000;
const EXCERPT_LINES = 60;

export function cacheKey(task: Task, model: string, input: unknown): string {
  return createHash("sha256").update(JSON.stringify({ task, version: PROMPT_VERSION, model, input })).digest("hex");
}

export async function explainFile(input: FileInput, deps: { cache: Cache; source: SourceOf }): Promise<Explanation> {
  const model = MODELS.explain;
  const run = traceable(async (question: FileInput): Promise<Explanation> => {
    const key = cacheKey("explain-file", model, question);
    const hit = await deps.cache.read(key);
    if (hit !== null) return scored(question, { body: hit, model, cached: true });
    const body = await askExplainFile(EXPLAIN_FILE_SYSTEM, question, await deps.source());
    await deps.cache.write({ key, task: "explain-file", model, body });
    return scored(question, { body, model, cached: false });
  }, traceConfig("explain-file"));
  return run(input);
}

export async function explainFolder(input: FolderInput, deps: { cache: Cache }): Promise<Explanation> {
  const model = MODELS.explain;
  const run = traceable(async (question: FolderInput): Promise<Explanation> => {
    const key = cacheKey("explain-folder", model, question);
    const hit = await deps.cache.read(key);
    if (hit !== null) return scored(question, { body: hit, model, cached: true });
    const body = await complete(model, EXPLAIN_FOLDER_SYSTEM, explainFolderMessage(question));
    await deps.cache.write({ key, task: "explain-folder", model, body });
    return scored(question, { body, model, cached: false });
  }, traceConfig("explain-folder"));
  return run(input);
}

// "none" is a real answer, and cached like any other: the model isn't made to
// pick something when nothing fits, and the file stays unclassified.
const NONE = "none";

export async function classifyFile(
  input: ClassifyInput,
  deps: { cache: Cache; source: SourceOf },
): Promise<{ role: ModelRole | null; cached: boolean }> {
  const model = MODELS.classify;
  const run = traceable(async (question: ClassifyInput): Promise<{ role: ModelRole | null; cached: boolean }> => {
    const key = cacheKey("classify-file", model, question);
    const hit = await deps.cache.read(key);
    if (hit !== null) return { role: parseRole(hit), cached: true };
    const answer = await askRole(question, await deps.source());
    // Parsed before caching, so a refused answer is never stored and served.
    const role = parseRole(answer);
    await deps.cache.write({ key, task: "classify-file", model, body: answer });
    return { role, cached: false };
  }, traceConfig("classify-file"));
  return run(input);
}

/** The model's role for a file, as answered: one of MODEL_ROLES or "none". */
export async function askRole(question: ClassifyInput, source: string): Promise<string> {
  const excerpt = source.split("\n").slice(0, EXCERPT_LINES).join("\n");
  const response = await ai().chat.completions.create({
    model: MODELS.classify,
    messages: [
      { role: "system", content: CLASSIFY_SYSTEM },
      { role: "user", content: classifyMessage(question, excerpt) },
    ],
    reasoning_effort: "low",
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "file_role",
        strict: true,
        schema: {
          type: "object",
          properties: { role: { type: "string", enum: [...MODEL_ROLES, NONE] } },
          required: ["role"],
          additionalProperties: false,
        },
      },
    },
  });
  return readRole(response.choices[0]?.message.content ?? null);
}

/** A file explained under a given system prompt: the evals compare prompts through this. */
export function askExplainFile(system: string, input: FileInput, source: string): Promise<string> {
  return complete(MODELS.explain, system, explainFileMessage(input, capped(source)));
}

export const INVENTED_PATHS_KEY = "no-invented-paths";

/** 1 when every path-shaped token was one the model was shown, else 0, naming the others. */
export function inventedPathsScore(input: ShownInput, body: string): { key: string; score: number; comment: string } {
  const invented = inventedPaths(body, shownPaths(input));
  return { key: INVENTED_PATHS_KEY, score: invented.length ? 0 : 1, comment: invented.length ? `not shown: ${invented.join(", ")}` : "every path was shown" };
}

// The live evaluator: every answer shown, cached or not, is scored on its own
// run. Not awaited, so an answer is never held back for its score; a score that
// fails to save is logged rather than lost silently.
function scored(input: ShownInput, answer: Explanation): Explanation {
  const run = getCurrentRunTree(true);
  if (run && tracingStatus().on) {
    const { key, score, comment } = inventedPathsScore(input, answer.body);
    langsmith()
      .createFeedback(run.id, key, { score, comment })
      .catch((error: unknown) => console.error(`Scoring run ${run.id} for invented paths failed:`, error));
  }
  return answer;
}

function parseRole(answer: string): ModelRole | null {
  if (answer === NONE) return null;
  // Structural roles aren't in the schema, but the answer is checked rather
  // than trusted: convention alone decides what's routable.
  if (!isModelRole(answer)) throw new Error(`The model answered the role "${answer}", which it isn't allowed to give`);
  return answer;
}

function readRole(content: string | null): string {
  if (!content) throw new Error("The model returned no role");
  const parsed: unknown = JSON.parse(content);
  const role: unknown = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "role") : undefined;
  if (typeof role !== "string") throw new Error(`The model's answer had no role: ${content}`);
  return role;
}

async function complete(model: string, system: string, user: string): Promise<string> {
  const response = await ai().chat.completions.create({
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    reasoning_effort: "low",
    verbosity: "low",
  });
  const body = response.choices[0]?.message.content?.trim();
  if (!body) throw new Error(`${model} returned an empty answer (finish reason: ${response.choices[0]?.finish_reason ?? "none"})`);
  return body;
}

function capped(source: string): string {
  if (source.length <= MAX_SOURCE_CHARS) return source;
  const kept = source.slice(0, MAX_SOURCE_CHARS);
  return `${kept}\n[… source truncated here: ${source.length - MAX_SOURCE_CHARS} more characters not shown]`;
}
