"use server";

import { createHash } from "node:crypto";
import { tracingStatus, type TracingStatus } from "@/lib/ai/client";
import { loadFileInput, loadFolderInput } from "@/lib/ai/context";
import { classifyFile, explainFile, explainFolder, type Cache } from "@/lib/ai/tasks";
import { isModelRole, type ModelRole } from "@/lib/roles";
import { supabase } from "@/lib/supabase";
import { supabaseSecret } from "@/lib/supabase-secret";
import { fileAt, headCommit, type Repository } from "@/pipeline/archive";

export type ExplainResult =
  | {
      ok: true;
      body: string;
      model: string;
      cached: boolean;
      tracing: TracingStatus;
      /** Set when this call labelled a file no convention identified. */
      labelled: { role: ModelRole | null } | null;
      /** Why labelling failed, when it did; the explanation still stands. */
      labelError: string | null;
    }
  | { ok: false; error: string };

export type HeadResult = { ok: true; head: string; analysed: string } | { ok: false; error: string };
export type FileAtHead = { ok: true; state: "unchanged" | "changed" | "deleted" } | { ok: false; error: string };

type Db = ReturnType<typeof supabase>;
type Analysis = { id: string; organizationId: string; commitSha: string; repository: Repository };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function explainFileAction(analysisId: string, path: string): Promise<ExplainResult> {
  try {
    const db = supabase();
    const analysis = await readAnalysis(db, analysisId);
    const loaded = await loadFileInput(db, analysis.id, path);
    if (!loaded) return { ok: false, error: `${path} isn't a file in this analysis` };
    const cache = cacheFor(db, analysis.organizationId);
    const source = sourceAtAnalysedCommit(analysis, path, loaded.file.hash);

    // Labelling comes first so the explanation's question includes the role,
    // and asks the same question next time, when the role is read back stored.
    let labelled: { role: ModelRole | null } | null = null;
    let labelError: string | null = null;
    const input = loaded.input;
    if (input.role === null) {
      try {
        const { role } = await classifyFile(loaded.classify, { cache, source });
        // Reported only once stored, and as stored: a role that failed to save,
        // or lost to one another request saved first, isn't the one the map has.
        if (role !== null) {
          const stored = await storeModelRole(analysis.organizationId, loaded.file.id, role);
          input.role = stored.role;
          labelled = stored.source === "model" ? { role: stored.role } : null;
        } else {
          labelled = { role: null };
        }
      } catch (error) {
        labelError = messageOf(error);
      }
    }

    const answer = await explainFile(input, { cache, source });
    return { ok: true, ...answer, tracing: tracingStatus(), labelled, labelError };
  } catch (error) {
    console.error(`Explaining ${path} failed:`, error);
    return { ok: false, error: messageOf(error) };
  }
}

export async function explainFolderAction(analysisId: string, dir: string): Promise<ExplainResult> {
  try {
    const db = supabase();
    const analysis = await readAnalysis(db, analysisId);
    const input = await loadFolderInput(db, analysis.id, dir);
    if (!input) return { ok: false, error: `${dir} isn't a folder on this map` };
    const answer = await explainFolder(input, { cache: cacheFor(db, analysis.organizationId) });
    return { ok: true, ...answer, tracing: tracingStatus(), labelled: null, labelError: null };
  } catch (error) {
    console.error(`Explaining folder ${dir} failed:`, error);
    return { ok: false, error: messageOf(error) };
  }
}

// One request to GitHub; the pane asks once per page load, not once per file.
export async function repositoryHeadAction(analysisId: string): Promise<HeadResult> {
  try {
    const analysis = await readAnalysis(supabase(), analysisId);
    return { ok: true, head: (await headCommit(analysis.repository)).commit, analysed: analysis.commitSha };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

// Only asked once the repository has moved past the analysed commit: the
// file's bytes at the new head, against the hash the parser stored.
export async function fileAtHeadAction(analysisId: string, path: string, head: string): Promise<FileAtHead> {
  try {
    if (!/^[0-9a-f]{40}$/.test(head)) return { ok: false, error: "That isn't a commit" };
    const db = supabase();
    const analysis = await readAnalysis(db, analysisId);
    const { data: file, error } = await db.from("files").select("hash").eq("analysis_id", analysis.id).eq("path", path).maybeSingle();
    if (error) throw new Error(`Reading ${path} failed: ${error.message}`);
    if (!file?.hash) return { ok: false, error: `${path} isn't a parsed file in this analysis` };
    const bytes = await fileAt(analysis.repository, head, path);
    if (bytes === null) return { ok: true, state: "deleted" };
    return { ok: true, state: sha256(bytes) === file.hash ? "unchanged" : "changed" };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

// Read under the caller's policies: another organization's analysis isn't
// there, and nothing after this runs for it. Not a uuid can't be one; asking
// Postgres would be a cast error, not a miss.
async function readAnalysis(db: Db, analysisId: string): Promise<Analysis> {
  if (!UUID.test(analysisId)) throw new Error("Analysis not found");
  const { data, error } = await db
    .from("analyses")
    .select("id, organization_id, status, commit_sha, projects(repo_owner, repo_name)")
    .eq("id", analysisId)
    .maybeSingle();
  if (error) throw new Error(`Reading the analysis failed: ${error.message}`);
  if (!data?.projects) throw new Error("Analysis not found");
  if (data.status !== "complete" || !data.commit_sha) throw new Error("This analysis isn't complete");
  return {
    id: data.id,
    organizationId: data.organization_id,
    commitSha: data.commit_sha,
    repository: { owner: data.projects.repo_owner, name: data.projects.repo_name },
  };
}

// Reads go through the member's client and its policy. Members have no write
// grant, so answers are stored by the server's writer, stamped with the
// organization the policy just let the member read.
function cacheFor(db: Db, organizationId: string): Cache {
  return {
    async read(key) {
      const { data, error } = await db.from("ai_cache").select("body").eq("key", key).maybeSingle();
      if (error) throw new Error(`Reading the cache failed: ${error.message}`);
      return data?.body ?? null;
    },
    async write({ key, task, model, body }) {
      const { error } = await supabaseSecret()
        .from("ai_cache")
        .upsert({ organization_id: organizationId, key, task, model, body }, { onConflict: "organization_id,key", ignoreDuplicates: true });
      if (error) throw new Error(`Storing the answer in the cache failed: ${error.message}`);
    },
  };
}

/**
 * Store the model's role unless the file already has one, and return whatever
 * the file's role row holds afterwards. An existing row is never replaced, so
 * that may be another request's label rather than this one.
 */
async function storeModelRole(
  organizationId: string,
  fileId: string,
  role: ModelRole,
): Promise<{ role: ModelRole; source: "model" } | { role: string; source: "convention" }> {
  const db = supabaseSecret();
  const { error } = await db
    .from("file_roles")
    .upsert({ organization_id: organizationId, file_id: fileId, role, source: "model" }, { onConflict: "file_id", ignoreDuplicates: true });
  if (error) throw new Error(`Storing the role failed: ${error.message}`);
  const { data, error: readError } = await db.from("file_roles").select("role, source").eq("file_id", fileId).single();
  if (readError) throw new Error(`Reading back the stored role failed: ${readError.message}`);
  if (data.source === "convention") return { role: data.role, source: "convention" };
  // The table's check constraint already refuses anything else; this keeps the type honest.
  if (data.source !== "model" || !isModelRole(data.role)) throw new Error(`The stored role "${data.role}" (${data.source}) isn't one a model may give`);
  return { role: data.role, source: "model" };
}

// Fetched at most once per request, and only if a cache miss needs it. The
// bytes must be the ones the parser read; if GitHub's copy hashes differently,
// explaining it would describe code that isn't on the map.
function sourceAtAnalysedCommit(analysis: Analysis, path: string, hash: string): () => Promise<string> {
  let pending: Promise<string> | null = null;
  return () => {
    pending ??= (async () => {
      const bytes = await fileAt(analysis.repository, analysis.commitSha, path);
      if (bytes === null) throw new Error(`GitHub has no ${path} at ${analysis.commitSha.slice(0, 7)}, the commit that was analysed`);
      if (sha256(bytes) !== hash) throw new Error(`GitHub's copy of ${path} at ${analysis.commitSha.slice(0, 7)} isn't what was parsed`);
      return bytes.toString("utf8");
    })();
    return pending;
  };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
