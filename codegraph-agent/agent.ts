import { defineDeepAgent } from "managed-deepagents";
import { context, filesByRole, neighbours, routes, searchFiles, summary, walk } from "./tools.ts";

// The system prompt is instructions.md. No web search: an answer has to come
// from this repository's analysis, not from what the model or the web knows.
export const agent = defineDeepAgent({
  name: "codegraph",
  model: "openai:gpt-5.5",
  tools: [summary, searchFiles, filesByRole, neighbours, walk, routes],
  contextSchema: context,
});
