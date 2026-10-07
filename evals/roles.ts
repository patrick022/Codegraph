// pnpm eval:roles [--rebuild]
// Role accuracy: files convention already labelled, their role hidden, the
// classifier asked, and its answer compared with convention's. An experiment
// in LangSmith, and the percentage printed here.

import "../scripts/env.ts";
import { evaluate } from "langsmith/evaluation";
import type { KVMap } from "langsmith/schemas";
import { MODELS } from "../lib/ai/client.ts";
import { PROMPT_VERSION } from "../lib/ai/prompts.ts";
import { askRole } from "../lib/ai/tasks.ts";
import { buildRoleExamples, ensureDataset, ROLE_DATASET, roleExample } from "./datasets.ts";

// Below this a percentage says more about which files happened to be picked than about the classifier.
const MIN_EXAMPLES = 30;

await ensureDataset(
  ROLE_DATASET,
  "Files whose role convention gave and the classifier is allowed to give. The role is the ground truth; the model never sees it.",
  buildRoleExamples,
);

const results = await evaluate(
  // The classifier's own call, straight to the model: no cache, so every run is a real answer.
  async (inputs: KVMap) => {
    const { question, source } = roleExample(inputs);
    return { role: await askRole(question, source) };
  },
  {
    data: ROLE_DATASET,
    experimentPrefix: "roles",
    description: `Classifier ${MODELS.classify}, prompt v${PROMPT_VERSION}, against conventional roles.`,
    metadata: { model: MODELS.classify, prompt: PROMPT_VERSION },
    maxConcurrency: 4,
    evaluators: [
      ({ outputs, referenceOutputs }: { outputs: KVMap; referenceOutputs?: KVMap }) => ({
        key: "role-correct",
        score: outputs.role === referenceOutputs?.role ? 1 : 0,
        comment: `answered ${outputs.role}, convention says ${referenceOutputs?.role}`,
      }),
    ],
  },
);

const byRole = new Map<string, { right: number; total: number }>();
const failed: string[] = [];
for (const row of results.results) {
  // A call that failed isn't a wrong answer; it's no answer, and it's reported rather than scored.
  if (row.run.error) {
    failed.push(`${row.example.id}: ${row.run.error}`);
    continue;
  }
  const expected = String(row.example.outputs?.role);
  const counts = byRole.get(expected) ?? { right: 0, total: 0 };
  counts.total++;
  if (row.run.outputs?.role === expected) counts.right++;
  byRole.set(expected, counts);
}
const total = results.results.length - failed.length;
const right = [...byRole.values()].reduce((n, c) => n + c.right, 0);

console.log(`\nexperiment ${results.experimentName}`);
for (const [role, c] of [...byRole].sort((a, b) => b[1].total - a[1].total)) {
  console.log(`  ${role.padEnd(11)} ${String(c.right).padStart(3)}/${String(c.total).padEnd(3)} ${percent(c.right, c.total)}`);
}
console.log(`role accuracy  ${right}/${total}  ${percent(right, total)}`);
for (const f of failed) console.error(`FAIL no answer for example ${f}`);
if (failed.length) process.exit(1);
if (total < MIN_EXAMPLES) {
  console.error(`FAIL the dataset has ${total} files; at least ${MIN_EXAMPLES} are needed for the percentage to mean anything`);
  process.exit(1);
}

function percent(n: number, of: number): string {
  return of ? `${((100 * n) / of).toFixed(1)}%` : "–";
}
