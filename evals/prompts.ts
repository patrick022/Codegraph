// pnpm eval:prompts [--rebuild]
// The current file explanation prompt and the retired one, run over the same
// dataset as two experiments, each scored two ways:
//
//   no-invented-paths  exact. Set membership against the paths the model was shown.
//   specific           a model's judgement. "Specific enough to be useful" has no
//                      exact answer, so a model judges it, and the number is that
//                      model's opinion, not a measurement.
//
// Both experiments sit side by side in LangSmith's comparison view; the
// difference is printed here.

import "../scripts/env.ts";
import { evaluate } from "langsmith/evaluation";
import type { KVMap } from "langsmith/schemas";
import { ai, MODELS } from "../lib/ai/client.ts";
import { EXPLAIN_FILE_SYSTEM, explainFileMessage, PROMPT_VERSION } from "../lib/ai/prompts.ts";
import { askExplainFile, capped, INVENTED_PATHS_KEY, inventedPathsScore } from "../lib/ai/tasks.ts";
import { buildExplainExamples, ensureDataset, EXPLAIN_DATASET, explainExample, type ExplainExample } from "./datasets.ts";
import { EXPLAIN_FILE_SYSTEM_V0 } from "./retired-prompts.ts";

const SPECIFIC_KEY = "specific";

// The judge is the explaining model's own pinned snapshot, so it's one more
// thing the numbers depend on, and it's recorded with every experiment.
const JUDGE_MODEL = MODELS.explain;

const JUDGE_SYSTEM = `You judge one explanation of a file in a TypeScript or JavaScript repository, written for a developer reading the repository for the first time. You're shown exactly what the explainer was shown, then its explanation.

Answer "specific" if a developer would come away knowing what this particular file does and what part it plays among the files listed around it: concrete behaviour, named exports or named neighbours, used correctly. Answer "generic" if most of it could be said of many files, restates the file's name or role, or lists neighbours without saying what passes between them. Judge usefulness to that developer only, not style, length or formatting. Give a one-sentence reason.`;

const VERSIONS = [
  { label: `v${PROMPT_VERSION}`, system: EXPLAIN_FILE_SYSTEM, note: "current, shipped" },
  { label: "v0", system: EXPLAIN_FILE_SYSTEM_V0, note: "retired, lives in evals/" },
];

await ensureDataset(
  EXPLAIN_DATASET,
  "Files with the most neighbours from each analysed repository, with the source as it was parsed.",
  buildExplainExamples,
);

type Tally = { label: string; experiment: string; clean: number; specific: number; total: number; specificById: Map<string, boolean> };
const tallies: Tally[] = [];

for (const version of VERSIONS) {
  const results = await evaluate(
    // Straight to the model under this version's prompt: no cache, both versions answer every example.
    async (inputs: KVMap) => {
      const { question, source } = explainExample(inputs);
      return { body: await askExplainFile(version.system, question, source) };
    },
    {
      data: EXPLAIN_DATASET,
      experimentPrefix: `explain-${version.label}`,
      description: `File explanation prompt ${version.label} (${version.note}). ${SPECIFIC_KEY} is judged by ${JUDGE_MODEL}; ${INVENTED_PATHS_KEY} is exact.`,
      metadata: { prompt: version.label, model: MODELS.explain, judge: JUDGE_MODEL },
      maxConcurrency: 4,
      evaluators: [
        ({ inputs, outputs }: { inputs: KVMap; outputs: KVMap }) => {
          const { question, source } = explainExample(inputs);
          return inventedPathsScore(question, bodyOf(outputs), capped(source));
        },
        async ({ inputs, outputs }: { inputs: KVMap; outputs: KVMap }) => {
          const { question, source } = explainExample(inputs);
          return judge(question, source, bodyOf(outputs));
        },
      ],
    },
  );

  const tally: Tally = { label: version.label, experiment: results.experimentName, clean: 0, specific: 0, total: 0, specificById: new Map() };
  const failed: string[] = [];
  for (const row of results.results) {
    if (row.run.error) {
      failed.push(`${row.example.id}: ${row.run.error}`);
      continue;
    }
    const score = (key: string) => row.evaluationResults.results.find((r) => r.key === key)?.score;
    const clean = score(INVENTED_PATHS_KEY);
    const specific = score(SPECIFIC_KEY);
    // An evaluator that didn't produce a score fails the run rather than counting as either answer.
    if (clean === undefined || specific === undefined) {
      failed.push(`${row.example.id}: an evaluator produced no score`);
      continue;
    }
    tally.total++;
    if (clean === 1) tally.clean++;
    if (specific === 1) tally.specific++;
    tally.specificById.set(row.example.id, specific === 1);
  }
  for (const f of failed) console.error(`FAIL ${version.label}, example ${f}`);
  if (failed.length) process.exit(1);
  tallies.push(tally);
}

const [current, retired] = tallies;
// A rate over nothing is no rate; an empty experiment fails instead of printing NaN.
for (const t of tallies) {
  if (t.total === 0) {
    console.error(`FAIL ${t.label} scored no examples, so there is nothing to compare`);
    process.exit(1);
  }
}
console.log("");
for (const t of tallies) {
  console.log(
    `${t.label.padEnd(3)} ${t.experiment}\n    ${INVENTED_PATHS_KEY.padEnd(18)} ${t.clean}/${t.total}  ${percent(t.clean, t.total)}   (exact)\n    ${SPECIFIC_KEY.padEnd(18)} ${t.specific}/${t.total}  ${percent(t.specific, t.total)}   (judged by ${JUDGE_MODEL})`,
  );
}

// Paired on the same examples, so the difference isn't two unrelated rates.
let onlyCurrent = 0;
let onlyRetired = 0;
for (const [id, specific] of current.specificById) {
  const other = retired.specificById.get(id);
  if (specific && other === false) onlyCurrent++;
  if (!specific && other === true) onlyRetired++;
}
console.log(`\n${current.label} - ${retired.label}`);
console.log(`    ${INVENTED_PATHS_KEY.padEnd(18)} ${points(current.clean / current.total - retired.clean / retired.total)}`);
console.log(
  `    ${SPECIFIC_KEY.padEnd(18)} ${points(current.specific / current.total - retired.specific / retired.total)}   ${onlyCurrent} examples specific only under ${current.label}, ${onlyRetired} only under ${retired.label}`,
);
console.log(`\n"${SPECIFIC_KEY}" is one model's verdict on another's answer. Read it as an opinion with a direction, not a measurement.`);

async function judge(question: ExplainExample["question"], source: string, body: string) {
  const response = await ai().chat.completions.create({
    model: JUDGE_MODEL,
    messages: [
      { role: "system", content: JUDGE_SYSTEM },
      { role: "user", content: `What the explainer was shown:\n\n${explainFileMessage(question, source)}\n\nIts explanation:\n<<<\n${body}\n>>>` },
    ],
    reasoning_effort: "low",
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "verdict",
        strict: true,
        schema: {
          type: "object",
          properties: { verdict: { type: "string", enum: ["specific", "generic"] }, reason: { type: "string" } },
          required: ["verdict", "reason"],
          additionalProperties: false,
        },
      },
    },
  });
  const content = response.choices[0]?.message.content;
  if (!content) throw new Error("The judge returned nothing");
  const parsed: unknown = JSON.parse(content);
  const verdict: unknown = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "verdict") : undefined;
  const reason: unknown = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "reason") : undefined;
  if (verdict !== "specific" && verdict !== "generic") throw new Error(`The judge's answer had no verdict: ${content}`);
  return { key: SPECIFIC_KEY, score: verdict === "specific" ? 1 : 0, comment: typeof reason === "string" ? reason : "" };
}

function bodyOf(outputs: KVMap): string {
  const body: unknown = outputs.body;
  if (typeof body !== "string") throw new Error("The target returned no explanation");
  return body;
}

function percent(n: number, of: number): string {
  return of ? `${((100 * n) / of).toFixed(1)}%` : "–";
}

function points(delta: number): string {
  return `${delta >= 0 ? "+" : ""}${(100 * delta).toFixed(1)} points`;
}
