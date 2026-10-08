import { createMiddleware } from "langchain";
import { defineDeepAgent } from "managed-deepagents";
import { context, filesByRole, neighbours, routes, searchFiles, summary, walk } from "./tools.ts";

const lookups = [summary, searchFiles, filesByRole, neighbours, walk, routes];

// The runtime always installs its scratch filesystem, todo list and sub-agent
// tools, and nothing it accepts turns them off. None of our questions need
// them, and each is a way to answer without looking anything up, so the model
// is only ever offered the graph lookups.
const lookupsOnly = createMiddleware({
  name: "LookupsOnly",
  wrapModelCall: (request, handler) => {
    const names = new Set<string>(lookups.map((t) => t.name));
    return handler({ ...request, tools: request.tools.filter((t) => names.has(String(Reflect.get(t, "name")))) });
  },
});

// The system prompt is instructions.md. No web search: an answer has to come
// from this repository's analysis, not from what the model or the web knows.
export const agent = defineDeepAgent({
  name: "codegraph",
  model: "openai:gpt-5.5",
  tools: lookups,
  middleware: [lookupsOnly],
  contextSchema: context,
});
