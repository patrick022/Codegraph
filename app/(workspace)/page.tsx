import { auth } from "@clerk/nextjs/server";
import type { Enums } from "@/lib/database.types";
import { supabase } from "@/lib/supabase";

type Status = Enums<"analysis_status">;

const LIST_LIMIT = 100;
const STATUS_ORDER: Status[] = ["parsing", "queued", "complete", "failed"];

/** Render the active organization's recent analyses, status counts, and relative timestamps. */
export default async function DashboardPage() {
  // Read off the token, never fetched from Clerk.
  const { orgId, sessionClaims } = await auth();
  const { rows, now } = await loadAnalyses();

  const counts = new Map<Status, number>();
  for (const r of rows) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-4 border-b border-border px-3">
        <h1 className="text-[13px] font-semibold">{sessionClaims?.org_name ?? orgId}</h1>
        <span className="text-xs text-muted tabular-nums">
          {rows.length === LIST_LIMIT
            ? `Latest ${LIST_LIMIT} analyses`
            : `${rows.length} ${rows.length === 1 ? "analysis" : "analyses"}`}
        </span>
        {rows.length > 0 && (
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
          <p className="mt-1">This organization hasn&apos;t mapped a repository.</p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full table-fixed border-collapse text-xs">
            <colgroup>
              <col />
              <col className="w-28" />
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
              {rows.map((a) => (
                <tr key={a.id} className="border-b border-border align-top">
                  <td className="truncate px-3 py-1.5 font-mono">
                    {a.projects ? (
                      <>
                        <span className="text-muted">{a.projects.repo_owner}/</span>
                        {a.projects.repo_name}
                      </>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                    {a.error && (
                      <span className="mt-0.5 block truncate font-sans text-muted" title={a.error}>
                        {a.error}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    <span className={`flex items-center gap-1.5 ${a.status === "queued" ? "text-muted" : ""}`}>
                      <StateMark status={a.status} />
                      {a.status}
                    </span>
                  </td>
                  <td className="hidden px-3 py-1.5 font-mono text-muted sm:table-cell">
                    {a.commit_sha ? <span title={a.commit_sha}>{a.commit_sha.slice(0, 7)}</span> : "—"}
                  </td>
                  <td className="px-3 py-1.5 text-right text-muted tabular-nums">
                    <time dateTime={a.created_at} title={a.created_at}>
                      {ago(a.created_at, now)}
                    </time>
                  </td>
                  <td className="hidden px-3 py-1.5 text-right text-muted tabular-nums sm:table-cell">
                    {a.finished_at ? (
                      <time dateTime={a.finished_at} title={a.finished_at}>
                        {ago(a.finished_at, now)}
                      </time>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
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
async function loadAnalyses() {
  const { data, error } = await supabase()
    .from("analyses")
    .select("id, status, commit_sha, error, created_at, finished_at, projects(repo_owner, repo_name)")
    .order("created_at", { ascending: false })
    .limit(LIST_LIMIT);
  if (error) throw new Error(`Couldn't load analyses: ${error.message}`);
  // The clock is read once per request; nothing ticks in the browser.
  return { rows: data, now: Date.now() };
}

/**
 * Relative rather than a clock time: the server doesn't know the viewer's
 * timezone, and "3h ago" is right everywhere. Exact time is in the title.
 */
function ago(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * State is carried by shape, not hue: green, amber and blue already mean
 * direction and interaction, so status stays greyscale. Empty ring queued,
 * half parsing, full complete, crossed out failed.
 */
function StateMark({ status }: { status: Status }) {
  return (
    <svg viewBox="0 0 10 10" className="size-2.5 shrink-0" aria-hidden="true">
      {status === "complete" ? (
        <circle cx="5" cy="5" r="4.5" fill="currentColor" />
      ) : (
        <circle cx="5" cy="5" r="4" fill="none" stroke="currentColor" strokeWidth="1" />
      )}
      {status === "parsing" && <path d="M5 1 A4 4 0 0 1 5 9 Z" fill="currentColor" />}
      {status === "failed" && <path d="M2.2 2.2 L7.8 7.8 M7.8 2.2 L2.2 7.8" stroke="currentColor" strokeWidth="1" />}
    </svg>
  );
}
