import { textChunks, type AskEvent } from "./ask.ts";

// Reading the agent server's stream, and turning its events into the
// AskEvents the panel shows. Pure, so it runs over a recorded stream as well
// as a live one.

// An "updates" event is one step's output, keyed by the step's name. The
// model's step carries the lookups it's starting, or the answer; the tools'
// step carries each lookup's result.
export function* relay(update: unknown): Generator<AskEvent> {
  if (typeof update !== "object" || update === null) return;
  for (const step of Object.values(update)) {
    const messages: unknown = Reflect.get(Object(step), "messages");
    for (const m of Array.isArray(messages) ? messages : []) {
      const type = text(m, "type");
      if (type === "ai") {
        const calls: unknown = Reflect.get(Object(m), "tool_calls");
        const list = Array.isArray(calls) ? calls : [];
        for (const call of list) {
          const args: Record<string, string> = {};
          for (const [k, v] of Object.entries(Object(Reflect.get(Object(call), "args")))) if (typeof v === "string") args[k] = v;
          yield { type: "call", id: text(call, "id"), name: text(call, "name"), args };
        }
        const answer = words(Reflect.get(Object(m), "content"));
        if (list.length === 0 && answer) yield { type: "answer", text: answer };
      } else if (type === "tool") {
        const failed = text(m, "status") === "error";
        yield { type: "result", id: text(m, "tool_call_id"), ok: !failed, detail: failed ? words(Reflect.get(Object(m), "content")) : null };
      }
    }
  }
}

/** A message's text: a plain string, or the text parts of a content list. */
function words(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (text(part, "type") === "text" ? text(part, "text") : ""))
    .join("")
    .trim();
}

export async function* serverSentEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: unknown }> {
  let buffer = "";
  const parse = (block: string) => {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) return null;
    try {
      const value: unknown = JSON.parse(data.join("\n"));
      return { event, data: value };
    } catch {
      return null;
    }
  };
  for await (const chunk of textChunks(body)) {
    buffer += chunk;
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const parsed = parse(block);
      if (parsed) yield parsed;
    }
  }
  const last = parse(buffer);
  if (last) yield last;
}

export function text(value: unknown, key: string): string {
  const v: unknown = typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
  return typeof v === "string" ? v.trim() : "";
}
