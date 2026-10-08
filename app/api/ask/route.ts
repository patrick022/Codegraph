import type { NextRequest } from "next/server";
import { mintAgentCredential } from "@/lib/agent-credential";
import { relay, serverSentEvents, text } from "@/lib/agent-events";
import type { AskEvent } from "@/lib/ask";
import { env } from "@/lib/env";
import { supabase } from "@/lib/supabase";
import { SCHEMA_VERSION } from "@/parser/types";

// The one way into the agent. It proves the asker can read the analysis,
// mints that analysis's credential, opens or continues a conversation, and
// relays the agent's progress as AskEvents while it works. The agent server's
// own events never reach the browser.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_QUESTION = 2000;
const ASSISTANT = "codegraph";

export async function POST(req: NextRequest) {
  const body: unknown = await req.json().catch(() => null);
  const analysisId = text(body, "analysisId");
  const question = text(body, "question");
  const threadId = text(body, "threadId");
  const selected = selection(Reflect.get(Object(body), "selected"));
  if (!UUID.test(analysisId)) return Response.json({ error: "analysisId must be a uuid" }, { status: 400 });
  if (!question || question.length > MAX_QUESTION) return Response.json({ error: `A question of 1 to ${MAX_QUESTION} characters` }, { status: 400 });
  if (threadId && !UUID.test(threadId)) return Response.json({ error: "threadId must be a uuid" }, { status: 400 });

  // Read with the member's own token: if the policies don't return the row,
  // they can't ask about it. The organization comes off that row, never input.
  const { data, error } = await supabase().from("analyses").select("id, organization_id, status, schema_version").eq("id", analysisId).maybeSingle();
  if (error) throw new Error(`Couldn't load analysis: ${error.message}`);
  if (!data) return Response.json({ error: "Analysis not found" }, { status: 404 });
  if (data.status !== "complete") return Response.json({ error: "The analysis isn't complete yet" }, { status: 409 });
  // Every lookup would refuse an older parser's analysis, so say so before
  // starting a run that could only fail.
  if (data.schema_version !== SCHEMA_VERSION) {
    return Response.json({ error: "This analysis was stored by an older parser. Re-run it to ask about it." }, { status: 409 });
  }
  const owner = { analysis_id: data.id, organization_id: data.organization_id };
  const credential = mintAgentCredential({ analysisId: data.id, organizationId: data.organization_id });

  // The selection is the asker's own context, said as such, so "this file"
  // has something to resolve to. The analysis itself is never named.
  const content = selected ? `${question}\n\n(Selected on the map: the ${selected.kind} \`${selected.path}\`)` : question;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: AskEvent) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      try {
        const thread = threadId ? await continueThread(threadId, owner) : await openThread(owner);
        send({ type: "thread", id: thread });
        const res = await agent(`/threads/${thread}/runs/stream`, {
          method: "POST",
          body: JSON.stringify({
            assistant_id: ASSISTANT,
            input: { messages: [{ role: "user", content }] },
            context: { credential },
            stream_mode: ["updates"],
          }),
          signal: req.signal,
        });
        if (!res.ok || !res.body) throw new AgentError(`The agent refused the question (${res.status}): ${await res.text()}`);
        // Ended means answered or said why not; silence is never the last thing the panel sees.
        let ended = false;
        for await (const { event, data } of serverSentEvents(res.body)) {
          if (event === "error") {
            ended = true;
            send({ type: "error", message: `The agent failed: ${text(data, "message") || "no reason given"}` });
          }
          if (event !== "updates") continue;
          for (const event of relay(data)) {
            if (event.type === "answer") ended = true;
            send(event);
          }
        }
        if (!ended) send({ type: "error", message: "The agent finished without answering." });
      } catch (e) {
        if (req.signal.aborted) return;
        send({ type: "error", message: e instanceof AgentError ? e.message : `The agent isn't reachable at ${env.agentUrl}. Everything else still works.` });
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed by the browser leaving.
        }
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
}

/** A failure the agent reported, as opposed to the agent not being there. */
class AgentError extends Error {}

type Owner = { analysis_id: string; organization_id: string };

function agent(pathname: string, init: RequestInit): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  // A deployed agent checks this against the workspace; local dev accepts any caller.
  if (process.env.LANGSMITH_API_KEY) headers.set("x-api-key", process.env.LANGSMITH_API_KEY);
  return fetch(new URL(pathname, env.agentUrl), { ...init, headers });
}

// The thread records whose conversation it is. That's for this check alone:
// the agent never sees thread metadata.
async function openThread(owner: Owner): Promise<string> {
  const res = await agent("/threads", { method: "POST", body: JSON.stringify({ metadata: owner }) });
  const id = text(await res.json().catch(() => null), "thread_id");
  if (!res.ok || !id) throw new AgentError(`The agent couldn't open a conversation (${res.status})`);
  return id;
}

async function continueThread(id: string, owner: Owner): Promise<string> {
  const res = await agent(`/threads/${id}`, { method: "GET" });
  if (res.status === 404) throw new AgentError("That conversation is gone. Start a new one.");
  const metadata: unknown = Reflect.get(Object(await res.json().catch(() => null)), "metadata");
  if (!res.ok || text(metadata, "analysis_id") !== owner.analysis_id || text(metadata, "organization_id") !== owner.organization_id) {
    throw new AgentError("That conversation isn't about this analysis. Start a new one.");
  }
  return id;
}

function selection(value: unknown): { kind: "file" | "folder"; path: string } | null {
  const kind = text(value, "kind");
  const path = text(value, "path");
  return (kind === "file" || kind === "folder") && path && path.length < 500 ? { kind, path } : null;
}
