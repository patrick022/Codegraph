import { after } from "next/server";
import { supabaseSecret } from "@/lib/supabase-secret";
import type { Repository } from "@/pipeline/archive";
import { claimAnalysis, runAnalysis, submitRepository, type ClaimedRun } from "@/pipeline/run";

// A signed-out visitor's repository from the landing page waits in this cookie
// rather than in the sign-in redirect URL, because a new account passes
// through onboarding, which picks its own destination.
export const PENDING_REPO = "pending_repo";

/**
 * Create the organization's analysis for a repository and start it, or return
 * the one it already has without running anything. The caller is responsible
 * for `orgId` having come off the session token.
 */
export async function analyseRepository(orgId: string, repo: Repository): Promise<string> {
  const db = supabaseSecret();
  const { analysisId, created } = await submitRepository(db, orgId, repo);
  if (created) {
    // Claimed before responding, so the page it lands on already says it started.
    const claimed = await claimAnalysis(db, analysisId);
    if (claimed) start(claimed);
  }
  return analysisId;
}

/**
 * The run outlives the response. It records its own failure on the row; this
 * only makes sure nothing is lost if even that fails.
 */
export function start(claimed: ClaimedRun): void {
  after(async () => {
    try {
      await runAnalysis(supabaseSecret(), claimed);
    } catch (e) {
      console.error(`Analysis ${claimed.analysisId} failed:`, e);
    }
  });
}
