import { auth } from "@clerk/nextjs/server";
import { AnalysisRow, type RowData } from "@/components/progress/analysis-row";
import { StateMark } from "@/components/state-mark";
import { SubmitForm } from "@/components/submit-form";
import { supabase } from "@/lib/supabase";
import { ago } from "@/lib/time";
import { isStale, progressOf, type Status } from "@/pipeline/stages";

const LIST_LIMIT = 100;
const STATUS_ORDER: Status[] = ["running", "queued", "complete", "failed"];

/** Render the active organization's recent analyses, status counts, and the form that starts one. */
export default async function DashboardPage() {
  // Read off the token, never fetched from Clerk.
  const { orgId, sessionClaims } = await auth();
  const rows = await loadAnalyses();

  const counts = new Map<Status, number>();
  for (const r of rows) counts.set(r.progress.status, (counts.get(r.progress.status) ?? 0) + 1);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-4 border-b border-border px-3">
        <h1 className="text-[13px] font-semibold">{sessionClaims?.org_name ?? orgId}</h1>
        <span className="text-xs text-muted tabular-nums">
          {rows.length === LIST_LIMIT
            ? `Latest ${LIST_LIMIT} analyses`
            : `${rows.length} ${rows.length === 1 ? "analysis" : "analyses"}`}
        </span>
        <SubmitForm />
        {rows.length > 0 && (
          // As rendered; each row below follows its own run live.
          <ul className="ml-auto flex items-center gap-3 text-xs text-muted tabular-nums">
            {STATUS_ORDER.filter((s) => counts.has(s)).map((s) => (
              <li key={s} className="flex items-center gap-1.5">
                <StateMark status={s} />
                {counts.get(s)} {s}
              </li>
            ))}
          </ul>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="px-3 py-10 text-xs text-muted">
          <p className="text-fg">No analyses yet.</p>
          <p className="mt-1">Paste a public GitHub repository above to map it.</p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full table-fixed border-collapse text-xs">
            <colgroup>
              <col />
              <col className="w-36" />
              <col className="hidden w-20 sm:table-column" />
              <col className="w-20" />
              <col className="hidden w-20 sm:table-column" />
            </colgroup>
            <thead className="sticky top-0 bg-bg text-left text-muted">
              <tr className="h-7 border-b border-border">
                <th className="px-3 font-normal">Repository</th>
                <th className="px-3 font-normal">State</th>
                <th className="hidden px-3 font-normal sm:table-cell">Commit</th>
                <th className="px-3 text-right font-normal">Started</th>
                <th className="hidden px-3 text-right font-normal sm:table-cell">Finished</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <AnalysisRow key={row.id} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * No organization filter: the row policy scopes this to the organization on
 * the token. Switching organization changes the token, not this query.
 */
async function loadAnalyses(): Promise<RowData[]> {
  const { data, error } = await supabase()
    .from("analyses")
    .select("id, status, stage, stage_message, error, commit_sha, created_at, started_at, finished_at, projects(repo_owner, repo_name)")
    .order("created_at", { ascending: false })
    .limit(LIST_LIMIT);
  if (error) throw new Error(`Couldn't load analyses: ${error.message}`);
  // The clock is read once per request; nothing ticks in the browser.
  const now = Date.now();
  return data.map((a) => ({
    id: a.id,
    repository: a.projects ? { owner: a.projects.repo_owner, name: a.projects.repo_name } : null,
    commitSha: a.commit_sha,
    progress: progressOf(a),
    staleAtRender: isStale(a, now),
    created: { iso: a.created_at, ago: ago(a.created_at, now) },
    finished: a.finished_at ? { iso: a.finished_at, ago: ago(a.finished_at, now) } : null,
  }));
}
