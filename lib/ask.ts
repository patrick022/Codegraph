// What the Ask relay streams to the browser, one JSON object per line. The
// agent server's own events stay on the server; the panel only knows these.
// Plain data with no imports, so the panel can read it.

export type AskEvent =
  // The conversation this answer belongs to, so the next question continues it.
  | { type: "thread"; id: string }
  // A lookup the agent started, as it started it.
  | { type: "call"; id: string; name: string; args: Record<string, string> }
  // That lookup finished. A failure carries what the lookup said.
  | { type: "result"; id: string; ok: boolean; detail: string | null }
  | { type: "answer"; text: string }
  | { type: "error"; message: string };

/** A byte stream as text, as it arrives. A reader loop: the DOM types here can't iterate a stream. */
export async function* textChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    yield decoder.decode(value, { stream: true });
  }
  const rest = decoder.decode();
  if (rest) yield rest;
}

/** What's selected on the map when the question is asked, if anything. */
export type AskSelection = { kind: "file" | "folder"; path: string } | null;

/** One streamed line, checked rather than trusted, or null if it isn't one of the above. */
export function readAskEvent(line: string): AskEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const get = (key: string): unknown => (typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined);
  const text = (key: string): string | null => {
    const v = get(key);
    return typeof v === "string" ? v : null;
  };
  const id = text("id");
  switch (get("type")) {
    case "thread":
      return id === null ? null : { type: "thread", id };
    case "call": {
      const name = text("name");
      const args = get("args");
      if (id === null || name === null || typeof args !== "object" || args === null) return null;
      const strings: Record<string, string> = {};
      for (const [k, v] of Object.entries(args)) if (typeof v === "string") strings[k] = v;
      return { type: "call", id, name, args: strings };
    }
    case "result": {
      const ok = get("ok");
      return id === null || typeof ok !== "boolean" ? null : { type: "result", id, ok, detail: text("detail") };
    }
    case "answer": {
      const t = text("text");
      return t === null ? null : { type: "answer", text: t };
    }
    case "error": {
      const message = text("message");
      return message === null ? null : { type: "error", message };
    }
    default:
      return null;
  }
}
