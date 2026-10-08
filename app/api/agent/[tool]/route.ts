import type { NextRequest } from "next/server";
import { readAgentCredential } from "@/lib/agent-credential";
import { reach, REACH_DEPTH, type Direction } from "@/lib/map/graph";
import { adjacency } from "@/lib/map/view";
import { railCategories, railLabel, ROLE_IDS, UNCLASSIFIED, type RailKey } from "@/lib/roles";
import { loadStoredMap } from "@/lib/stored-map";
import { supabaseForAgent } from "@/lib/supabase";
import { SCHEMA_VERSION } from "@/parser/types";

// The agent's lookups. Read-only, and signed in as nobody: the bearer is the
// one-analysis credential, and every read goes through the policies with it.
// Each answer comes from the functions that draw the canvas; nothing here
// works out structure of its own.

// Past this a list stops being read. The total always comes with it, so a
// trimmed list never reads as the whole.
const LIST_LIMIT = 100;

export async function POST(req: NextRequest, ctx: RouteContext<"/api/agent/[tool]">) {
  const credential = req.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  const grant = credential ? readAgentCredential(credential) : null;
  if (!credential || !grant) return fail(401, "Missing, invalid or expired credential");

  const { tool } = await ctx.params;
  const body: unknown = await req.json().catch(() => null);
  if (typeof body !== "object" || body === null) return fail(400, "Body must be a JSON object");

  const db = supabaseForAgent(credential);
  const { data, error } = await db
    .from("analyses")
    .select("id, status, commit_sha, detected_projects, coverage, schema_version, projects(repo_owner, repo_name)")
    .eq("id", grant.analysisId)
    .maybeSingle();
  if (error) throw new Error(`Couldn't load analysis: ${error.message}`);
  if (!data?.projects) return fail(404, "The analysis isn't there");
  if (data.status !== "complete") return fail(409, `The analysis is ${data.status}, not complete`);
  if (data.schema_version !== SCHEMA_VERSION) return fail(409, "The analysis was stored by an older parser and needs a re-run");

  // ponytail: the whole map is read on every lookup, a few per answer. Cache per credential if that shows in latency.
  const { map, modelRoles } = await loadStoredMap(db, { id: data.id, projects: data.detected_projects, coverage: data.coverage });
  const paths = new Set(map.files.map((f) => f.path));

  switch (tool) {
    case "summary": {
      // Counted the way the rail counts them, a model's label in its role's row.
      const roles = railCategories(
        map.projects.map((p) => p.adapter),
        map.files.map((f) => f.role ?? modelRoles[f.path] ?? null),
      );
      const { files, imports, routes } = map.coverage;
      return Response.json({
        repository: `${data.projects.repo_owner}/${data.projects.repo_name}`,
        commit: data.commit_sha,
        projects: map.projects.map((p) => ({ path: p.path, framework: p.adapter })),
        files: map.files.length,
        edges: map.edges.length,
        routes: map.routes.length,
        roles: roles.map((r) => ({ role: r.key, label: railLabel(r.key), files: r.count })),
        coverage: {
          filesFound: files.found,
          filesParsed: files.parsed,
          filesSkipped: files.skipped.length,
          imports,
          routesOmitted: routes.omitted.length,
          routesWithheld: routes.withheld,
        },
      });
    }

    case "search": {
      const query = text(body, "query");
      if (!query) return fail(400, "query is required");
      const needle = query.toLowerCase();
      return Response.json(list(map.files.map((f) => f.path).filter((p) => p.toLowerCase().includes(needle))));
    }

    case "role": {
      const role = text(body, "role");
      if (!isRailKey(role)) return fail(400, `role must be one of ${[...ROLE_IDS, UNCLASSIFIED].join(", ")}`);
      // Convention's roles are facts the parser established; a model's label
      // is kept apart so the agent can say which it's reporting.
      const byConvention = map.files.filter((f) => (f.role ?? UNCLASSIFIED) === role && !(role === UNCLASSIFIED && modelRoles[f.path]));
      const labelledByModel = role === UNCLASSIFIED ? [] : map.files.filter((f) => f.role === null && modelRoles[f.path] === role);
      return Response.json({
        role,
        label: railLabel(role),
        byConvention: list(byConvention.map((f) => f.path)),
        labelledByModel: list(labelledByModel.map((f) => f.path)),
      });
    }

    case "neighbours": {
      const file = text(body, "file");
      if (!paths.has(file)) return fail(404, `No parsed file at ${JSON.stringify(file)}`);
      const { imports, importedBy } = adjacency(map.edges).get(file) ?? { imports: [], importedBy: [] };
      return Response.json({ file, imports, importedBy });
    }

    case "walk": {
      const file = text(body, "file");
      const direction = text(body, "direction");
      if (!paths.has(file)) return fail(404, `No parsed file at ${JSON.stringify(file)}`);
      if (!isDirection(direction)) return fail(400, "direction must be dependents or dependencies");
      const { steps, beyond } = reach(map.edges, file, direction);
      return Response.json({ file, direction, depth: REACH_DEPTH, steps, beyond });
    }

    case "routes":
      return Response.json({
        routes: map.routes,
        omitted: map.coverage.routes.omitted,
        withheld: map.coverage.routes.withheld,
      });

    default:
      return fail(404, `No lookup called ${JSON.stringify(tool)}`);
  }
}

function fail(status: number, error: string) {
  return Response.json({ error }, { status });
}

function text(body: object, key: string): string {
  const value: unknown = Reflect.get(body, key);
  return typeof value === "string" ? value.trim() : "";
}

function list(items: string[]) {
  return { total: items.length, items: items.sort().slice(0, LIST_LIMIT) };
}

function isRailKey(value: string): value is RailKey {
  return value === UNCLASSIFIED || (ROLE_IDS as readonly string[]).includes(value);
}

function isDirection(value: string): value is Direction {
  return value === "dependents" || value === "dependencies";
}
