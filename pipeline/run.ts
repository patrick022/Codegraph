// The run: fetch, select, parse, store. Each stage is written to the analysis
// row as it starts, and a trigger on that row publishes it, so progress comes
// from the database rather than from anyone polling.

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import type { PostgrestError, PostgrestSingleResponse } from "@supabase/supabase-js";
import type { Database, Json } from "../lib/database.types.ts";
import type { SecretClient } from "../lib/supabase-secret.ts";
import { parseSelection, selectFiles } from "../parser/parse.ts";
import { SCHEMA_VERSION, type Coverage, type ParseResult } from "../parser/types.ts";
import { fetchArchive, type Repository } from "./archive.ts";
import { STALE_AFTER_MS, type Stage } from "./stages.ts";

const BATCH = 1000;

/**
 * claimedStartedAt is this run's own claim on the row. Every later write is
 * scoped to it, so a stale run that was taken over can't change the row the
 * newer run now owns.
 */
export type ClaimedRun = { analysisId: string; organizationId: string; repo: Repository; claimedStartedAt: string };

/**
 * Find or create the one analysis for this repository in this organization,
 * enforced by unique constraints rather than check-then-insert, so two tabs
 * submitting at once still end with one row. `created` is false when it
 * already existed: pasting the same URL again leads to that analysis rather
 * than starting another run. Nothing here contacts GitHub; a repository that
 * doesn't exist gets a row, and that row fails in fetch.
 */
export async function submitRepository(db: SecretClient, organizationId: string, repo: Repository) {
  // Organizations live in Clerk; the row exists so everything has a foreign key.
  await must(db.from("organizations").upsert({ id: organizationId }, { ignoreDuplicates: true }));
  const project = read(
    await db
      .from("projects")
      .upsert(
        { organization_id: organizationId, repo_owner: repo.owner, repo_name: repo.name },
        { onConflict: "organization_id,repo_owner,repo_name" },
      )
      .select("id")
      .single(),
  );
  const inserted = read(
    await db
      .from("analyses")
      .upsert({ organization_id: organizationId, project_id: project.id }, { onConflict: "project_id", ignoreDuplicates: true })
      .select("id"),
  );
  if (inserted[0]) return { analysisId: inserted[0].id, created: true };
  const existing = read(await db.from("analyses").select("id").eq("project_id", project.id).single());
  return { analysisId: existing.id, created: false };
}

/**
 * Move the row to running and clear the last run's outcome in one conditional
 * update, so two runs of the same analysis can't overlap; a stale one can be
 * taken over. Separate from the run so a request can claim before it
 * responds, and the page it lands on already says the run has started.
 * Null when a run already holds it.
 */
export async function claimAnalysis(db: SecretClient, analysisId: string): Promise<ClaimedRun | null> {
  const staleBefore = new Date(Date.now() - STALE_AFTER_MS).toISOString();
  const { data, error } = await db
    .from("analyses")
    .update({
      status: "running",
      stage: "fetch",
      stage_message: "Starting",
      started_at: new Date().toISOString(),
      finished_at: null,
      error: null,
      coverage: null,
      detected_projects: null,
      schema_version: null,
    })
    .eq("id", analysisId)
    .or(`status.neq.running,started_at.lt.${staleBefore}`)
    .select("organization_id, started_at, projects!inner(repo_owner, repo_name)")
    .maybeSingle();
  if (error) throw new Error(`Starting analysis ${analysisId} failed: ${error.message}`);
  if (!data) return null;
  // The claim just set it, so a null here means the update didn't do what it says.
  if (!data.started_at) throw new Error(`Starting analysis ${analysisId} left it without a start time`);
  return {
    analysisId,
    organizationId: data.organization_id,
    repo: { owner: data.projects.repo_owner, name: data.projects.repo_name },
    // As the database stored it, so matching on it later compares like with like.
    claimedStartedAt: data.started_at,
  };
}

/**
 * Run a claimed analysis to completion. Any failure, in any stage, ends with
 * the row marked failed with its reason, and the stage left on the one it
 * failed in. Throws only if even that couldn't be written.
 */
export async function runAnalysis(db: SecretClient, claimed: ClaimedRun): Promise<void> {
  const { repo } = claimed;
  let dir: string | undefined;
  try {
    await enter(db, claimed, "fetch", `Downloading github.com/${repo.owner}/${repo.name}`);
    const archive = await fetchArchive(repo);
    dir = archive.dir;
    await update(db, claimed, {
      commit_sha: archive.commit,
      stage_message: `Downloaded ${(archive.bytes / 1024 / 1024).toFixed(1)} MB at ${archive.commit.slice(0, 7)}`,
    });

    await enter(db, claimed, "select", `Walking ${count(archive.files, "file")} for TypeScript and JavaScript`);
    const selection = selectFiles(archive.dir);

    const skipped = selection.skipped.length;
    await enter(db, claimed, "parse", `Parsing ${count(selection.files.length, "file")}${skipped ? `, ${skipped} skipped` : ""}`);
    // ponytail: parsing is synchronous and holds the server's event loop for
    // the length of the parse (seconds on a large repository). Move it to a
    // worker thread if other requests visibly stall during a run.
    const result = parseSelection(selection);

    await enter(
      db,
      claimed,
      "store",
      `Storing ${count(result.coverage.files.found, "file")}, ${count(result.edges.length, "edge")} and ${count(result.routes.length, "route")}`,
    );
    await store(db, claimed, result);

    await update(db, claimed, {
      status: "complete",
      finished_at: new Date().toISOString(),
      detected_projects: result.projects,
      schema_version: SCHEMA_VERSION,
      coverage: storedCoverage(result.coverage),
      stage_message: `Mapped ${count(result.files.length, "file")} and ${count(result.edges.length, "edge")}`,
    });
  } catch (e) {
    // A newer run owns the row now; its outcome is the one to record.
    if (e instanceof SupersededError) return;
    const reason = e instanceof Error ? e.message : String(e);
    const { error } = await db
      .from("analyses")
      .update({ status: "failed", error: reason, finished_at: new Date().toISOString() })
      .eq("id", claimed.analysisId)
      .eq("started_at", claimed.claimedStartedAt);
    // Nowhere left to write it; the row will read as stale once it's old enough.
    if (error) throw new Error(`Run failed (${reason}), and recording the failure failed too: ${error.message}`, { cause: e });
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

class SupersededError extends Error {
  override name = "SupersededError";
}

/** Record that a stage has started, and what it's doing. */
async function enter(db: SecretClient, claimed: ClaimedRun, stage: Stage, message: string) {
  await update(db, claimed, { stage, stage_message: message });
}

/** Update this run's row; no row matching means a newer run claimed it, so this one stops. */
async function update(db: SecretClient, claimed: ClaimedRun, values: Database["public"]["Tables"]["analyses"]["Update"]) {
  const rows = read(
    await db
      .from("analyses")
      .update(values)
      .eq("id", claimed.analysisId)
      .eq("started_at", claimed.claimedStartedAt)
      .select("id"),
  );
  if (rows.length === 0) throw new SupersededError(`Analysis ${claimed.analysisId} was taken over by a newer run`);
}

/**
 * Replace whatever a previous run stored with this result. Chunks aren't one
 * transaction, but nothing reads as complete until the final update, and a
 * failure part-way marks the run failed. Files get their ids here, so edges
 * can reference them without reading anything back.
 */
async function store(db: SecretClient, claimed: ClaimedRun, result: ParseResult) {
  const scope = { organization_id: claimed.organizationId, analysis_id: claimed.analysisId };
  // Edges, roles and routes go with their files, by cascade.
  await must(db.from("files").delete().eq("analysis_id", claimed.analysisId));

  const ids = new Map<string, string>();
  /** Give a path its row id. */
  const assign = (path: string) => {
    const id = randomUUID();
    ids.set(path, id);
    return id;
  };
  /** Look up a stored file's id; an edge to anything else is a parser bug, not a gap to fill. */
  const idOf = (path: string) => {
    const id = ids.get(path);
    if (!id) throw new Error(`${path} is referenced by an edge but was not stored as a file`);
    return id;
  };

  const files: Database["public"]["Tables"]["files"]["Insert"][] = [
    ...result.files.map((f) => ({ ...scope, id: assign(f.path), path: f.path, lines: f.lines, hash: f.hash, reached_by: f.reachedBy })),
    ...result.coverage.files.skipped.map((s) => ({
      ...scope,
      id: assign(s.path),
      path: s.path,
      skip_reason: s.reason,
      skip_detail: s.detail,
    })),
  ];
  await inBatches(files, (rows) => db.from("files").insert(rows));

  const edges = result.edges.map((e) => ({ ...scope, source_file_id: idOf(e.from), target_file_id: idOf(e.to), kinds: e.kinds }));
  await inBatches(edges, (rows) => db.from("edges").insert(rows));

  // Only files a convention named get a row; the rest stay unclassified rather than labelled "other".
  const roles = result.files.flatMap((f) =>
    f.role === null ? [] : [{ organization_id: claimed.organizationId, file_id: idOf(f.path), role: f.role, source: "convention" }],
  );
  await inBatches(roles, (rows) => db.from("file_roles").insert(rows));

  const routes = result.routes.map((r) => ({ ...scope, file_id: idOf(r.file), method: r.method, path: r.path, line: r.line }));
  await inBatches(routes, (rows) => db.from("routes").insert(rows));
}

/** Coverage without the skipped-file list, which is the files table's. */
function storedCoverage({ files, ignoredDirectories, imports, routes }: Coverage): Json {
  return { files: { found: files.found, parsed: files.parsed }, ignoredDirectories, imports, routes };
}

/** Write rows in fixed-size batches, so a large repository isn't one oversized request. */
async function inBatches<T>(rows: T[], write: (batch: T[]) => PromiseLike<{ error: PostgrestError | null }>) {
  for (let i = 0; i < rows.length; i += BATCH) await must(write(rows.slice(i, i + BATCH)));
}

/** Await a write, turning its error into a thrown one. */
async function must(query: PromiseLike<{ error: PostgrestError | null }>): Promise<void> {
  const { error } = await query;
  if (error) throw new Error(error.message);
}

/** Unwrap a response that returns rows, throwing on its error. */
function read<T>(response: PostgrestSingleResponse<T>): T {
  if (response.error) throw new Error(response.error.message);
  return response.data;
}

/** "1 file", "1,204 files". */
function count(n: number, noun: string): string {
  return `${n.toLocaleString("en-US")} ${noun}${n === 1 ? "" : "s"}`;
}
