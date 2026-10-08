// Mints the agent's credential for one analysis and checks, against the
// running app and the real database, everything the agent will rely on: each
// lookup answers, a bad credential doesn't, and the policies alone narrow the
// credential to its analysis. Needs `pnpm dev` running.
//
//   pnpm agent-check <analysis id> --org <clerk org id>

import "./env.ts";
import { createClient } from "@supabase/supabase-js";
import { mintAgentCredential } from "../lib/agent-credential.ts";
import type { Database } from "../lib/database.types.ts";
import { env } from "../lib/env.ts";

const args = process.argv.slice(2);
const orgAt = args.indexOf("--org");
const org = orgAt === -1 ? undefined : args[orgAt + 1];
const [analysisId] = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--org");
if (!analysisId || !org) {
  console.error("usage: pnpm agent-check <analysis id> --org <clerk org id>");
  process.exit(1);
}

const app = process.env.CODEGRAPH_URL ?? "http://localhost:3000";
const credential = mintAgentCredential({ analysisId, organizationId: org });
let failed = 0;

function check(ok: boolean, label: string, detail = ""): void {
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
}

// A field of a JSON answer, and the length of one that should be a list.
const get = (v: unknown, key: string): unknown => (typeof v === "object" && v !== null ? Reflect.get(v, key) : undefined);
const len = (v: unknown): number | string => (Array.isArray(v) ? v.length : "?");

async function lookup(tool: string, body: object, token = credential): Promise<{ status: number; json: unknown }> {
  const res = await fetch(new URL(`/api/agent/${tool}`, app), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {
    console.error(`Couldn't reach ${app}. Start the app with pnpm dev first.`);
    process.exit(1);
  });
  const json: unknown = await res.json();
  return { status: res.status, json };
}

const items = (v: unknown): string[] => {
  const list = get(v, "items");
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
};

console.log(`Lookups for ${analysisId} at ${app}`);

const summary = await lookup("summary", {});
check(summary.status === 200, "summary", `${get(summary.json, "repository")} · ${get(summary.json, "files")} files · ${get(summary.json, "edges")} edges · ${get(summary.json, "routes")} routes`);

// Every path contains a "." somewhere; this lists real files to look up next.
const search = await lookup("search", { query: "." });
check(search.status === 200 && items(search.json).length > 0, "search", `${get(search.json, "total")} files`);

const roles = get(summary.json, "roles");
const used = Array.isArray(roles) ? roles.find((r: unknown) => Number(get(r, "files")) > 0) : undefined;
const role = used === undefined ? "unclassified" : String(get(used, "role"));
const byRole = await lookup("role", { role });
check(byRole.status === 200, "role", `${role}: ${get(get(byRole.json, "byConvention"), "total")} by convention, ${get(get(byRole.json, "labelledByModel"), "total")} labelled by a model`);

// A walk from an isolated file proves nothing, so check from the first file
// with neighbours on both sides, or failing that on either.
let file = items(search.json)[0];
let near = await lookup("neighbours", { file });
let fallback: { file: string; near: typeof near } | null = null;
for (const candidate of items(search.json).slice(0, 25)) {
  const n = await lookup("neighbours", { file: candidate });
  const imports = len(get(n.json, "imports"));
  const importedBy = len(get(n.json, "importedBy"));
  if (imports !== 0 && importedBy !== 0) {
    [file, near, fallback] = [candidate, n, null];
    break;
  }
  if (!fallback && (imports !== 0 || importedBy !== 0)) fallback = { file: candidate, near: n };
}
if (fallback) ({ file, near } = fallback);
check(near.status === 200, "neighbours", `${file} imports ${len(get(near.json, "imports"))}, imported by ${len(get(near.json, "importedBy"))}`);

for (const direction of ["dependents", "dependencies"]) {
  const walk = await lookup("walk", { file, direction });
  const steps = get(walk.json, "steps");
  check(walk.status === 200, `walk ${direction}`, `per step ${Array.isArray(steps) ? steps.map(len).join(", ") : "?"}, ${get(walk.json, "beyond")} beyond`);
}

const routes = await lookup("routes", {});
check(routes.status === 200, "routes", `${len(get(routes.json, "routes"))} listed, ${len(get(routes.json, "omitted"))} omitted`);

console.log("\nRefusals");
check((await lookup("neighbours", { file: "no/such/file.ts" })).status === 404, "an unknown file is 404");
check((await lookup("walk", { file, direction: "sideways" })).status === 400, "an unknown direction is 400");
check((await lookup("summary", {}, "not-a-credential")).status === 401, "a malformed credential is 401");
const [head, , signature] = credential.split(".");
const forgedBody = Buffer.from(JSON.stringify({ role: "authenticated", org_id: org, analysis_id: analysisId, exp: 9999999999 })).toString("base64url");
check((await lookup("summary", {}, `${head}.${forgedBody}.${signature}`)).status === 401, "a tampered credential is 401");
const elsewhere = mintAgentCredential({ analysisId, organizationId: "org_not_this_one" });
check((await lookup("summary", {}, elsewhere)).status === 404, "a signed credential for another organization finds nothing");

// Straight to Supabase with no filter at all: whatever comes back is what the
// policies let this credential see.
console.log("\nWhat the policies let the credential read, unfiltered");
const db = createClient<Database>(env.supabaseUrl, env.supabasePublishableKey, { accessToken: async () => credential });
const analyses = await db.from("analyses").select("id");
check(analyses.data?.length === 1 && analyses.data[0].id === analysisId, "analyses: only this one", analyses.error?.message ?? `${analyses.data?.length} row(s)`);
const projects = await db.from("projects").select("id", { count: "exact", head: true });
check(projects.count === 1, "projects: only its repository", projects.error?.message ?? `${projects.count} row(s)`);
for (const table of ["files", "edges", "routes", "insights"] as const) {
  const { data, error } = await db.from(table).select("analysis_id").neq("analysis_id", analysisId).limit(1);
  check(!error && data.length === 0, `${table}: nothing from another analysis`, error?.message ?? "");
}
const cache = await db.from("ai_cache").select("id", { count: "exact", head: true });
check(cache.count === 0, "ai_cache: nothing", cache.error?.message ?? `${cache.count} row(s)`);
const organizations = await db.from("organizations").select("id", { count: "exact", head: true });
check(organizations.count === 0, "organizations: nothing", organizations.error?.message ?? `${organizations.count} row(s)`);

console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
