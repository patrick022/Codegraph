import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EdgeKind } from "../../parser/types.ts";
import type { Database } from "../database.types.ts";
import { foldDirectories } from "../map/fold.ts";
import { readAll } from "../stored-map.ts";
import type { ClassifyInput, FileInput, FolderFile, FolderInput, NeighbourFacts } from "./prompts.ts";

type Db = SupabaseClient<Database>;

// What the model is handed, read from the stored analysis and nowhere else.
// The browser names a file or folder; which files are its neighbours is read
// here from the edges the parser stored, never taken from the request. Reads
// go through the caller's client, so the policies decide what comes back.

const EDGE_KINDS: readonly EdgeKind[] = ["import", "re-export", "dynamic-import", "require"];

export type StoredFile = { id: string; path: string; hash: string };

export async function loadFileInput(
  db: Db,
  analysisId: string,
  filePath: string,
): Promise<{ file: StoredFile; input: FileInput; classify: ClassifyInput } | null> {
  const { data: file, error } = await db
    .from("files")
    .select("id, path, hash, exports, reached_by, skip_reason, file_roles(role, source)")
    .eq("analysis_id", analysisId)
    .eq("path", filePath)
    .maybeSingle();
  if (error) throw new Error(`Reading ${filePath} failed: ${error.message}`);
  if (!file) return null;
  if (file.skip_reason !== null || file.hash === null || file.exports === null) {
    throw new Error(`${filePath} was skipped by the parser, so there's nothing parsed to explain`);
  }

  const edges = await readAll((from, to) =>
    db
      .from("edges")
      .select(
        "id, kinds, source_file_id, target_file_id, source:files!edges_source_file_id_organization_id_fkey(path, exports, file_roles(role, source)), target:files!edges_target_file_id_organization_id_fkey(path, exports, file_roles(role, source))",
      )
      .eq("analysis_id", analysisId)
      .or(`source_file_id.eq.${file.id},target_file_id.eq.${file.id}`)
      .order("id")
      .range(from, to),
  );

  const imports: NeighbourFacts[] = [];
  const importedBy: NeighbourFacts[] = [];
  for (const e of edges) {
    const outgoing = e.source_file_id === file.id;
    const other = outgoing ? e.target : e.source;
    if (!other) throw new Error(`An edge of ${filePath} points at a file that isn't stored`);
    const facts: NeighbourFacts = { path: other.path, role: conventionRole(other.file_roles), exports: other.exports ?? [], kinds: kindsOf(e.kinds) };
    // A file importing itself sits in both lists; the parser's own counts include it that way too.
    if (outgoing) imports.push(facts);
    if (e.target_file_id === file.id) importedBy.push(facts);
  }

  // The file's own role may be the model's: it's what the explanation should
  // describe it as. Neighbours' roles stay convention's (see conventionRole).
  const role = file.file_roles[0]?.role ?? null;
  const byPath = (a: NeighbourFacts, b: NeighbourFacts) => a.path.localeCompare(b.path);
  const input: FileInput = {
    path: file.path,
    hash: file.hash,
    role,
    reachedBy: file.reached_by,
    exports: file.exports,
    imports: imports.sort(byPath),
    importedBy: importedBy.sort(byPath),
  };
  const classify: ClassifyInput = {
    path: file.path,
    hash: file.hash,
    exports: file.exports,
    imports: input.imports.map((n) => ({ path: n.path, role: n.role })),
    importedBy: input.importedBy.map((n) => ({ path: n.path, role: n.role })),
  };
  return { file: { id: file.id, path: file.path, hash: file.hash }, input, classify };
}

// The folder is a group of the same folding the map draws, worked out from the
// same parsed file list, so the question is about the box that was clicked.
export async function loadFolderInput(db: Db, analysisId: string, dir: string): Promise<FolderInput | null> {
  const rows = await readAll((from, to) =>
    db
      .from("files")
      .select("id, path, hash, exports, file_roles(role, source)")
      .eq("analysis_id", analysisId)
      .is("skip_reason", null)
      .order("id")
      .range(from, to),
  );
  const files = rows.map((r) => {
    if (r.hash === null || r.exports === null) throw new Error(`Stored parsed file ${r.path} is missing its measurements`);
    return { ...r, hash: r.hash, exports: r.exports, folder: path.posix.dirname(r.path) };
  });
  const group = foldDirectories(files).groups.find((g) => g.dir === dir);
  if (!group) return null;

  const inside = new Set(group.files);
  const pathOf = new Map(files.map((f) => [f.id, f.path]));
  const edges = await readAll((from, to) =>
    db.from("edges").select("id, source_file_id, target_file_id").eq("analysis_id", analysisId).order("id").range(from, to),
  );
  // Fan-in and fan-out aren't stored; they're the edge list's arithmetic.
  const fanIn = new Map<string, number>();
  const fanOut = new Map<string, number>();
  const incoming: { from: string; to: string }[] = [];
  const outgoing: { from: string; to: string }[] = [];
  for (const e of edges) {
    const source = pathOf.get(e.source_file_id);
    const target = pathOf.get(e.target_file_id);
    if (source === undefined || target === undefined) throw new Error("A stored edge points at a file that isn't a stored parsed file");
    fanOut.set(source, (fanOut.get(source) ?? 0) + 1);
    fanIn.set(target, (fanIn.get(target) ?? 0) + 1);
    // One edge per (source, target) pair is a table constraint, so these are distinct.
    if (!inside.has(source) && inside.has(target)) incoming.push({ from: source, to: target });
    if (inside.has(source) && !inside.has(target)) outgoing.push({ from: source, to: target });
  }

  const byPath = new Map(files.map((f) => [f.path, f]));
  const members: FolderFile[] = group.files.map((p) => {
    const f = byPath.get(p);
    if (!f) throw new Error(`Folded file ${p} isn't in the file list it was folded from`);
    return { path: f.path, hash: f.hash, role: conventionRole(f.file_roles), exports: f.exports, fanIn: fanIn.get(p) ?? 0, fanOut: fanOut.get(p) ?? 0 };
  });
  const order = (a: { from: string; to: string }, b: { from: string; to: string }) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to);
  return { dir, files: members, incoming: incoming.sort(order), outgoing: outgoing.sort(order) };
}

// Other files' roles go to the model only when convention gave them. A label
// the model gave one file later would otherwise change every neighbour's and
// folder's question, and throw away their cached answers for nothing the
// parser found.
function conventionRole(rows: { role: string; source: string }[]): string | null {
  const row = rows[0];
  return row?.source === "convention" ? row.role : null;
}

function kindsOf(stored: string[]): EdgeKind[] {
  for (const k of stored) if (!EDGE_KINDS.some((known) => known === k)) throw new Error(`Stored edge kind "${k}" isn't one the parser produces`);
  return EDGE_KINDS.filter((k) => stored.includes(k));
}
