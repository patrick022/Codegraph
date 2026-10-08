"use server";

import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { supabaseSecret } from "@/lib/supabase-secret";
import { analyseRepository, start } from "@/lib/start-analysis";
import { parseRepositoryUrl } from "@/pipeline/archive";
import { claimAnalysis } from "@/pipeline/run";

export type FormState = { error: string | null };

/**
 * Pasting a URL creates the analysis and starts it, or, if this organization
 * already has one for the repository, goes to it without running anything.
 * The organization comes off the session token, never from the form.
 */
export async function submitAnalysis(_previous: FormState, form: FormData): Promise<FormState> {
  const { orgId } = await auth();
  if (!orgId) return { error: "No active organization" };
  const url = form.get("url");
  const repo = typeof url === "string" ? parseRepositoryUrl(url) : null;
  if (!repo) return { error: "That isn't a GitHub repository URL; expected github.com/owner/name" };

  redirect(`/analyses/${await analyseRepository(orgId, repo)}`);
}

/** Re-running is only ever this: a deliberate act from the analysis itself. */
export async function rerunAnalysis(analysisId: string): Promise<FormState> {
  // Visibility is the policy's call: another organization's analysis isn't
  // there to re-run. The writer below bypasses policies, so this read comes first.
  const { data, error } = await supabase().from("analyses").select("id").eq("id", analysisId).maybeSingle();
  if (error) {
    // The database's own message stays in the server log, not on the page.
    console.error(`Reading analysis ${analysisId} to re-run it failed:`, error.message);
    return { error: "Couldn't start a re-run" };
  }
  if (!data) return { error: "Analysis not found" };

  const claimed = await claimAnalysis(supabaseSecret(), analysisId);
  if (!claimed) return { error: "It's already running" };
  start(claimed);
  return { error: null };
}
