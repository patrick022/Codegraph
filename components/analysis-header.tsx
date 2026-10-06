"use client";

import { useRouter } from "next/navigation";
import { RerunButton } from "./progress/rerun-button";

/**
 * Above the map, not in it: the map's columns stay where they are. Re-running
 * hands the page back to the progress view, which the server renders once the
 * row says running.
 */
export function AnalysisHeader(props: { analysisId: string; repository: { owner: string; name: string }; commitSha: string }) {
  const router = useRouter();
  return (
    <div className="flex h-9 shrink-0 items-center gap-3 border-b border-border px-3 text-xs">
      <h1 className="font-mono text-[13px]">
        <span className="text-muted">{props.repository.owner}/</span>
        {props.repository.name}
      </h1>
      <span className="font-mono text-muted" title={props.commitSha}>
        {props.commitSha.slice(0, 7)}
      </span>
      <span className="ml-auto">
        <RerunButton analysisId={props.analysisId} onStarted={() => router.refresh()} />
      </span>
    </div>
  );
}
