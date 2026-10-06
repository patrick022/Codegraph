import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { degrees } from "../parser/graph.ts";
import { readCoverage, readProjects } from "../parser/io.ts";
import { ROLE_IDS, type Role } from "./roles.ts";
import type { Edge, EdgeKind, Route } from "../parser/types.ts";
import type { Database } from "./database.types.ts";
import type { MapData } from "./map/types.ts";

type Db = SupabaseClient<Database>;

// PostgREST returns at most this many rows per request, so larger analyses
// are read in pages. Bounded by the analysis itself, never open-ended.
const PAGE = 1000;
const EDGE_KINDS: readonly EdgeKind[] = ["import", "re-export", "dynamic-import"];

/**
 * Rebuild a complete analysis from its rows, checked the way a parser output
 * file was: coverage by field path, counts that must add up, and every edge
 * landing on a stored parsed file. Anything off fails here, by name, instead
 * of drawing a quietly wrong map. Reads with the caller's client, so the
 * policies decide whether any of it comes back.
 */
export async function loadStoredMap(db: Db, analysis: { id: string; projects: unknown; coverage: unknown }): Promise<MapData> {
  const files = await readAll((from, to) =>
    db
      .from("files")
      .select("id, path, lines, hash, reached_by, skip_reason, skip_detail, file_roles(role)")
      .eq("analysis_id", analysis.id)
      .order("id")
      .range(from, to),
  );
  const rows = await readAll((from, to) =>
    db.from("edges").select("source_file_id, target_file_id, kinds").eq("analysis_id", analysis.id).order("id").range(from, to),
  );
  const routeRows = await readAll((from, to) =>
    db.from("routes").select("file_id, method, path, line").eq("analysis_id", analysis.id).order("id").range(from, to),
  );

  // Code-unit order, as the parser's walk sorts them, so the rebuilt list is the parsed one.
  const parsed = files.filter((f) => f.skip_reason === null).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const skipped = files.filter((f) => f.skip_reason !== null).sort((a, b) => a.path.localeCompare(b.path));
  // Only parsed files are nodes; an edge to a skipped one is as wrong as an edge to nothing.
  const nodePath = new Map(parsed.map((f) => [f.id, f.path]));

  const edges: Edge[] = rows
    .map((e, i) => {
      const from = nodePath.get(e.source_file_id);
      const to = nodePath.get(e.target_file_id);
      if (!from || !to) throw new Error(`Stored edge ${i} doesn't join two parsed files of this analysis`);
      const kinds = e.kinds.map((k) => {
        const kind = EDGE_KINDS.find((known) => known === k);
        if (!kind) throw new Error(`Stored edge ${from} -> ${to} has unknown kind ${JSON.stringify(k)}`);
        return kind;
      });
      return { from, to, kinds };
    })
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  const routes: Route[] = routeRows
    .map((r) => {
      const file = nodePath.get(r.file_id);
      if (!file) throw new Error(`Stored route ${r.method} ${r.path} isn't on a parsed file of this analysis`);
      return { file, line: r.line, method: r.method, path: r.path };
    })
    .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method) || a.file.localeCompare(b.file));

  // The stored report has everything but the skip list, which is the files table's.
  const stored = typeof analysis.coverage === "object" && analysis.coverage !== null ? analysis.coverage : {};
  const storedFiles: unknown = Reflect.get(stored, "files");
  const coverage = readCoverage(
    {
      ...stored,
      files: {
        ...(typeof storedFiles === "object" && storedFiles !== null ? storedFiles : {}),
        skipped: skipped.map((f) => ({ path: f.path, reason: f.skip_reason, detail: f.skip_detail })),
      },
    },
    "analyses.coverage",
  );
  if (coverage.files.parsed !== parsed.length || coverage.files.found !== files.length) {
    throw new Error(
      `Stored coverage says ${coverage.files.parsed} parsed of ${coverage.files.found} found, ` +
        `but ${parsed.length} parsed of ${files.length} files are stored`,
    );
  }

  // Fan-in and fan-out are arithmetic over the edge list, so they're
  // recomputed rather than stored; degrees() throws on an edge to a non-node.
  const degree = degrees(
    parsed.map((f) => f.path),
    edges,
  );
  return {
    projects: readProjects(analysis.projects, "analyses.detected_projects"),
    files: parsed.map((f) => {
      if (f.lines === null || f.hash === null) throw new Error(`Parsed file ${f.path} is stored without its measurements`);
      // file_id is unique in file_roles, so there's at most one.
      const role = roleNamed(f.file_roles[0]?.role ?? null, f.path);
      return {
        path: f.path,
        folder: path.posix.dirname(f.path),
        lines: f.lines,
        hash: f.hash,
        ...degree.get(f.path)!,
        reachedBy: f.reached_by,
        role,
      };
    }),
    edges,
    routes,
    coverage,
  };
}

/** A stored role checked against the taxonomy, so a stale or mistyped one fails by name. */
function roleNamed(stored: string | null, path: string): Role | null {
  if (stored === null) return null;
  const role = ROLE_IDS.find((r) => r === stored);
  if (!role) throw new Error(`Stored role ${JSON.stringify(stored)} of ${path} isn't in the taxonomy`);
  return role;
}

/** Read every page of a bounded query, in order. */
async function readAll<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(`Reading the stored analysis failed: ${error.message}`);
    if (!data) break;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return rows;
}
