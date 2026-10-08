import { ToolMessage, tool } from "langchain";
import type { ManagedToolRuntime } from "managed-deepagents";
import { z } from "zod";

// Every tool is a lookup against the app's read-only surface, which runs the
// same graph functions that draw the canvas. Nothing here computes structure:
// the agent picks a file and a direction, the app does the walking.

// What the caller attaches to each run. The credential names one analysis and
// its organization; it never enters a message, so nothing the model reads or
// writes can point a tool at a different analysis.
export const context = z.object({ credential: z.string().min(1) });
type Context = z.infer<typeof context>;
type Runtime = ManagedToolRuntime<unknown, Context>;

async function lookup(name: string, args: object, runtime: Runtime): Promise<string | ToolMessage> {
  const base = process.env.CODEGRAPH_URL;
  if (!base) throw new Error("CODEGRAPH_URL is not set");
  const credential = runtime.context?.credential;
  if (!credential) throw new Error("This run carries no analysis credential");
  const res = await fetch(new URL(`/api/agent/${name}`, base), {
    method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  const body = await res.text();
  // A lookup that answered "not there" or "not valid" goes back to the model
  // marked as failed, so it can say so and carry on. Anything else means the
  // system is broken, and the run fails rather than answering around it.
  if (res.status >= 400 && res.status < 500 && res.status !== 401) {
    return new ToolMessage({ content: `Lookup failed: ${body}`, tool_call_id: runtime.toolCallId, status: "error" });
  }
  if (!res.ok) throw new Error(`Lookup ${name} failed with ${res.status}: ${body}`);
  return body;
}

const path = z.string().describe("A repo-relative file path exactly as a previous lookup returned it.");

export const summary = tool((_: object, runtime: Runtime) => lookup("summary", {}, runtime), {
  name: "analysis_summary",
  description:
    "Overview of the whole analysis: repository, detected projects and frameworks, file and edge counts, " +
    "how many files each role has, route count, and what the parser skipped or couldn't resolve.",
  schema: z.object({}),
});

export const searchFiles = tool(({ query }: { query: string }, runtime: Runtime) => lookup("search", { query }, runtime), {
  name: "search_files",
  description: "Find files whose path contains the given text, case-insensitive. Use it to turn a name or topic into real paths.",
  schema: z.object({ query: z.string().min(1).describe("Part of a path, such as 'auth' or 'lib/db'.") }),
});

export const filesByRole = tool(({ role }: { role: string }, runtime: Runtime) => lookup("role", { role }, runtime), {
  name: "files_by_role",
  description:
    "List the files a framework convention gave a role, such as page-route, api-endpoint or middleware, " +
    "or 'unclassified' for files no convention identified. analysis_summary lists the roles this repository has. " +
    "Files a model labelled come back separately; say so when you name one.",
  schema: z.object({ role: z.string().min(1) }),
});

export const neighbours = tool(({ file }: { file: string }, runtime: Runtime) => lookup("neighbours", { file }, runtime), {
  name: "file_neighbours",
  description: "The files one import away from a file: what it imports and what imports it.",
  schema: z.object({ file: path }),
});

const direction = z
  .enum(["dependents", "dependencies"])
  .describe("dependents: what imports this file, transitively (what breaks if it changes). dependencies: what it imports, transitively.");

export const walk = tool(
  ({ file, direction }: { file: string; direction: "dependents" | "dependencies" }, runtime: Runtime) =>
    lookup("walk", { file, direction }, runtime),
  {
    name: "walk_graph",
    description:
      "Walk the import graph from a file in one direction, grouped by how many steps away each file is, " +
      "plus a count of files further out than the walk lists.",
    schema: z.object({ file: path, direction }),
  },
);

export const routes = tool((_: object, runtime: Runtime) => lookup("routes", {}, runtime), {
  name: "route_table",
  description:
    "Every route the parser recovered: method, full path pattern, and the file and line declaring it. " +
    "Also lists routes left out because their method or path isn't written in the code.",
  schema: z.object({}),
});
