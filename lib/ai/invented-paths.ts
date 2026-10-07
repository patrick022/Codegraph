// The invented-path check: every path-shaped token in an explanation, tested
// against the exact set of paths the model was shown. Set membership, so it's
// code with an exact answer, never a model grading a model.

/** Only the paths of an explanation's input: all the check needs to know. */
export type ShownInput =
  | { path: string; imports: { path: string }[]; importedBy: { path: string }[] }
  | { dir: string; files: { path: string }[]; incoming: { from: string; to: string }[]; outgoing: { from: string; to: string }[] };

export function shownPaths(input: ShownInput): Set<string> {
  if ("dir" in input) return new Set([...input.files.map((f) => f.path), ...[...input.incoming, ...input.outgoing].flatMap((e) => [e.from, e.to])]);
  return new Set([input.path, ...input.imports.map((n) => n.path), ...input.importedBy.map((n) => n.path)]);
}

// A file name ending in a JavaScript, TypeScript or JSON extension, with the
// characters real repository paths use: route groups, dynamic segments, dots.
const FILE = /[\w@.~$-][\w@.~$+\-[\]()/]*\.(?:[cm]?[jt]sx?|json)(?![\w])/g;
const CODE_SPAN = /`([^`]+)`/g;

/**
 * The path-shaped tokens of an explanation the model wasn't shown, each once. A token with a slash counts anywhere. One without
 * a slash counts only inside backticks, where the prompt has the model put
 * every path: in running prose "Next.js" is a product, not a file. So a bare
 * filename in prose, outside backticks, isn't checked.
 */
export function inventedPaths(body: string, shown: Set<string>): string[] {
  const tokens: string[] = [];
  for (const m of body.matchAll(FILE)) if (m[0].includes("/")) tokens.push(m[0]);
  for (const span of body.matchAll(CODE_SPAN)) for (const m of span[1].matchAll(FILE)) if (!m[0].includes("/")) tokens.push(m[0]);
  return [...new Set(tokens.filter((t) => !shown.has(t)))];
}
