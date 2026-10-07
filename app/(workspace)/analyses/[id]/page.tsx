import { notFound } from "next/navigation";
import type { ComponentProps } from "react";
import { AnalysisHeader } from "@/components/analysis-header";
import { CoverageBanner } from "@/components/coverage-banner";
import { MapWorkspace } from "@/components/map/workspace";
import { AnalysisProgress } from "@/components/progress/analysis-progress";
import type { MapData } from "@/lib/map/types";
import type { ModelRole } from "@/lib/roles";
import { loadStoredMap } from "@/lib/stored-map";
import { supabase } from "@/lib/supabase";
import { ago } from "@/lib/time";
import { SCHEMA_VERSION } from "@/parser/types";
import { isStale, progressOf } from "@/pipeline/stages";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One address per analysis: the map once it's complete, the run's progress
 * until then. The progress view refreshes this page when the last stage
 * lands, so a finished run turns into its map in place.
 */
export default async function AnalysisPage({ params }: PageProps<"/analyses/[id]">) {
  const loaded = await loadAnalysis((await params).id);
  if (!loaded) notFound();

  if (loaded.kind === "map") {
    const { header, map, modelRoles } = loaded;
    return (
      <div className="flex h-full flex-col">
        <AnalysisHeader {...header} />
        <CoverageBanner coverage={map.coverage} />
        <div className="flex min-h-0 flex-1">
          <MapWorkspace
            analysisId={header.analysisId}
            commitSha={header.commitSha}
            name={`${header.repository.owner}/${header.repository.name}`}
            result={map}
            modelRoles={modelRoles}
          />
        </div>
      </div>
    );
  }

  if (loaded.kind === "outdated") {
    // Stored before the parser read roles and routes. Showing it would present
    // every file as unclassified and the route table as empty, neither of
    // which was checked.
    return (
      <div className="flex h-full flex-col">
        <AnalysisHeader {...loaded.header} />
        <div className="px-3 py-3 text-xs">
          <p>This analysis was stored by an older version of the parser, which didn&apos;t read everything the current one does.</p>
          <p className="mt-0.5 text-muted">Re-run it to map it with the current one.</p>
        </div>
      </div>
    );
  }

  const { props } = loaded;
  // A fresh mount per server render, so "unchanged since render" restarts with it.
  return <AnalysisProgress key={`${props.initial.status}:${props.initial.stage}:${props.started?.iso}`} {...props} />;
}

type Loaded =
  | { kind: "map"; header: ComponentProps<typeof AnalysisHeader>; map: MapData; modelRoles: Record<string, ModelRole> }
  | { kind: "outdated"; header: ComponentProps<typeof AnalysisHeader> }
  | { kind: "progress"; props: ComponentProps<typeof AnalysisProgress> };

/**
 * Read under the member's policy, so another organization's analysis isn't
 * found rather than hidden. Not a uuid can't be an analysis; asking Postgres
 * would be a cast error, not a miss.
 */
async function loadAnalysis(id: string): Promise<Loaded | null> {
  if (!UUID.test(id)) return null;
  const db = supabase();
  const { data, error } = await db
    .from("analyses")
    .select("id, status, stage, stage_message, error, commit_sha, detected_projects, coverage, schema_version, created_at, started_at, projects(repo_owner, repo_name)")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Couldn't load analysis: ${error.message}`);
  if (!data?.projects) return null;
  const repository = { owner: data.projects.repo_owner, name: data.projects.repo_name };

  // The row's constraint guarantees a complete run has its commit, projects and coverage.
  if (data.status === "complete" && data.commit_sha) {
    const header = { analysisId: data.id, repository, commitSha: data.commit_sha };
    if (data.schema_version !== SCHEMA_VERSION) return { kind: "outdated", header };
    const { map, modelRoles } = await loadStoredMap(db, { id: data.id, projects: data.detected_projects, coverage: data.coverage });
    return { kind: "map", header, map, modelRoles };
  }

  // The clock is read once per request; nothing ticks in the browser.
  const now = Date.now();
  return {
    kind: "progress",
    props: {
      analysisId: data.id,
      repository,
      commitSha: data.commit_sha,
      initial: progressOf(data),
      staleAtRender: isStale(data, now),
      started: data.started_at ? { iso: data.started_at, ago: ago(data.started_at, now) } : null,
    },
  };
}
