// Submits a repository for an organization and runs the pipeline in this
// process, the same code the app runs, then reads back what was stored.
//
//   pnpm analyze <github url> --org <clerk org id>           submit; run only if new
//   pnpm analyze <github url> --org <clerk org id> --rerun   run it again either way

import "./env.ts";
import { parseRepositoryUrl } from "../pipeline/archive.ts";
import { claimAnalysis, runAnalysis, submitRepository } from "../pipeline/run.ts";
import { supabaseSecret } from "../lib/supabase-secret.ts";

const args = process.argv.slice(2);
const orgAt = args.indexOf("--org");
const org = orgAt === -1 ? undefined : args[orgAt + 1];
const [url] = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--org");
const repo = url ? parseRepositoryUrl(url) : null;
if (!repo || !org) {
  console.error("usage: pnpm analyze <github url> --org <clerk org id> [--rerun]");
  process.exit(1);
}

const db = supabaseSecret();
const { analysisId, created } = await submitRepository(db, org, repo);
console.log(`${created ? "Created" : "Existing"} analysis ${analysisId}`);

if (created || args.includes("--rerun")) {
  const claimed = await claimAnalysis(db, analysisId);
  if (!claimed) {
    console.error("A run is already in progress for this analysis");
    process.exit(1);
  }
  const started = performance.now();
  await runAnalysis(db, claimed);
  console.log(`Run took ${((performance.now() - started) / 1000).toFixed(1)}s`);
}

const { data, error } = await db
  .from("analyses")
  .select("status, stage, stage_message, error, commit_sha, started_at, finished_at")
  .eq("id", analysisId)
  .single();
if (error) throw new Error(error.message);
console.log(data);

const parsed = await db.from("files").select("id", { count: "exact", head: true }).eq("analysis_id", analysisId).is("skip_reason", null);
const skipped = await db.from("files").select("id", { count: "exact", head: true }).eq("analysis_id", analysisId).not("skip_reason", "is", null);
const edges = await db.from("edges").select("id", { count: "exact", head: true }).eq("analysis_id", analysisId);
console.log(`Stored: ${parsed.count} parsed files, ${skipped.count} skipped, ${edges.count} edges`);
if (data.status === "failed") process.exit(1);
