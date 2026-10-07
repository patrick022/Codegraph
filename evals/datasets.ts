// The two datasets the evals run over, built once from the stored analyses and
// then kept in LangSmith as they are: every experiment against a dataset sees
// the same examples, sources included, however the repositories move on.
// --rebuild throws a dataset away and builds it again from what's stored now.

import type { ExampleCreate, KVMap } from "langsmith/schemas";
import { langsmith } from "../lib/ai/client.ts";
import { loadFileInput } from "../lib/ai/context.ts";
import type { ClassifyInput, FileInput } from "../lib/ai/prompts.ts";
import { readAll } from "../lib/stored-map.ts";
import { MODEL_ROLES, type ModelRole } from "../lib/roles.ts";
import { supabaseSecret } from "../lib/supabase-secret.ts";
import { sourceAt, type Repository } from "../pipeline/archive.ts";

// The shapes this file writes into each dataset. LangSmith hands examples back
// as KVMap, its values typed any, and validating every field of an input
// would restate the input types. They're read back as the shapes written,
// because this file is the only writer: an unchecked assumption, made here.
export type RoleExample = { question: ClassifyInput; source: string };
export type ExplainExample = { question: FileInput; source: string };

export function roleExample(inputs: KVMap): RoleExample {
  return { question: inputs.question, source: inputs.source };
}

export function explainExample(inputs: KVMap): ExplainExample {
  return { question: inputs.question, source: inputs.source };
}

export const ROLE_DATASET = "codegraph-roles";
export const EXPLAIN_DATASET = "codegraph-explain";

// Files per repository in the explanation dataset: the ones with the most
// neighbours, where there is the most to be specific about and to invent.
const EXPLAIN_PER_REPOSITORY = 4;

type Analysis = { id: string; commit: string; repository: Repository };

const db = supabaseSecret();

export async function ensureDataset(name: string, description: string, build: () => Promise<ExampleCreate[]>): Promise<void> {
  const client = langsmith();
  const exists = await client.hasDataset({ datasetName: name });
  if (exists && !process.argv.includes("--rebuild")) return;
  if (exists) await client.deleteDataset({ datasetName: name });
  const examples = await build();
  const dataset = await client.createDataset(name, { description });
  await client.createExamples(examples.map((e) => ({ ...e, dataset_id: dataset.id })));
  console.log(`Built dataset ${name}: ${examples.length} examples`);
}

/**
 * Every file whose role convention gave and the classifier is allowed to
 * give. In normal operation none of them reaches the model, so the role is
 * real ground truth the model has never been shown.
 */
export async function buildRoleExamples(): Promise<ExampleCreate[]> {
  const examples: ExampleCreate[] = [];
  for (const analysis of await latestAnalyses()) {
    const { data, error } = await db
      .from("files")
      .select("path, hash, file_roles!inner(role, source)")
      .eq("analysis_id", analysis.id)
      .is("skip_reason", null)
      .eq("file_roles.source", "convention")
      .in("file_roles.role", [...MODEL_ROLES])
      .order("path");
    if (error) throw new Error(`Reading the roles of ${name(analysis)} failed: ${error.message}`);
    for (const file of data) {
      const role = MODEL_ROLES.find((r) => r === file.file_roles[0]?.role);
      if (!role || file.hash === null) throw new Error(`${file.path} came back without the role or hash it was selected by`);
      const loaded = await loadFileInput(db, analysis.id, file.path);
      if (!loaded) throw new Error(`${file.path} disappeared from ${name(analysis)} while reading it`);
      const inputs: RoleExample = { question: loaded.classify, source: await sourceAt(analysis.repository, analysis.commit, file.path, file.hash) };
      const outputs: { role: ModelRole } = { role };
      examples.push({ inputs, outputs, metadata: { repository: name(analysis), commit: analysis.commit } });
    }
  }
  return examples;
}

export async function buildExplainExamples(): Promise<ExampleCreate[]> {
  const examples: ExampleCreate[] = [];
  for (const analysis of await latestAnalyses()) {
    const files = await readAll((from, to) =>
      db.from("files").select("id, path").eq("analysis_id", analysis.id).is("skip_reason", null).order("id").range(from, to),
    );
    const edges = await readAll((from, to) =>
      db.from("edges").select("id, source_file_id, target_file_id").eq("analysis_id", analysis.id).order("id").range(from, to),
    );
    const degree = new Map<string, number>();
    for (const e of edges) for (const id of [e.source_file_id, e.target_file_id]) degree.set(id, (degree.get(id) ?? 0) + 1);
    const picked = files
      .filter((f) => degree.has(f.id))
      .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.path.localeCompare(b.path))
      .slice(0, EXPLAIN_PER_REPOSITORY);
    for (const f of picked) {
      const loaded = await loadFileInput(db, analysis.id, f.path);
      if (!loaded) throw new Error(`${f.path} disappeared from ${name(analysis)} while reading it`);
      const inputs: ExplainExample = { question: loaded.input, source: await sourceAt(analysis.repository, analysis.commit, f.path, loaded.file.hash) };
      examples.push({ inputs, metadata: { repository: name(analysis), commit: analysis.commit } });
    }
  }
  return examples;
}

// The newest complete analysis of each project, so no repository is counted twice.
async function latestAnalyses(): Promise<Analysis[]> {
  const { data, error } = await db
    .from("analyses")
    .select("id, project_id, commit_sha, finished_at, projects(repo_owner, repo_name)")
    .eq("status", "complete")
    .order("finished_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(`Reading the analyses failed: ${error.message}`);
  const seen = new Set<string>();
  const out: Analysis[] = [];
  for (const a of data) {
    if (seen.has(a.project_id)) continue;
    seen.add(a.project_id);
    if (!a.commit_sha || !a.projects) throw new Error(`Complete analysis ${a.id} has no commit or project`);
    const analysis = { id: a.id, commit: a.commit_sha, repository: { owner: a.projects.repo_owner, name: a.projects.repo_name } };
    // An analysis that ran before exports were stored can't build the
    // question the app asks today. It's left out and said so, not filled in.
    const { count, error: countError } = await db
      .from("files")
      .select("id", { count: "exact", head: true })
      .eq("analysis_id", a.id)
      .is("skip_reason", null)
      .is("exports", null);
    if (countError) throw new Error(`Counting the files of ${name(analysis)} failed: ${countError.message}`);
    if (count) {
      console.warn(`Left out ${name(analysis)}: analysed before exports were stored (${count} files). Re-analyse it to include it.`);
      continue;
    }
    out.push(analysis);
  }
  return out;
}

function name(analysis: Analysis): string {
  return `${analysis.repository.owner}/${analysis.repository.name}`;
}
