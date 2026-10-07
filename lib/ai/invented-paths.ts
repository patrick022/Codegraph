// The invented-path check: every path-shaped token in an explanation, tested
// against the exact set of paths the model was shown. Set membership, so it's
// code with an exact answer, never a model grading a model.

/** Only the paths of an explanation's input: all the check needs to know. */
export type ShownInput =
  | { path: string; imports: { path: string }[]; importedBy: { path: string }[] }
  | { dir: string; files: { path: string }[]; incoming: { from: string; to: string }[]; outgoing: { from: string; to: string }[] };

/**
 * The paths the model was shown: the input's files, and for a file, every
 * path-shaped token in the source exactly as it was sent. A path the code
 * itself mentions was shown; repeating it isn't inventing it.
 */
export function shownPaths(input: ShownInput, source?: string): Set<string> {
  const listed =
    "dir" in input
      ? [...input.files.map((f) => f.path), ...[...input.incoming, ...input.outgoing].flatMap((e) => [e.from, e.to])]
      : [input.path, ...input.imports.map((n) => n.path), ...input.importedBy.map((n) => n.path)];
  return new Set([...listed, ...(source === undefined ? [] : tokens(source))]);
}

// A file name ending in a code, data, style or documentation extension, with
// the characters real repository paths use: route groups, dynamic segments, dots.
const FILE = /[\w@.~$([-][\w@.~$+\-[\]()/]*\.(?:[cm]?[jt]sx?|json|mdx?|css|scss|html|ya?ml)(?![\w])/g;
const CODE_SPAN = /`([^`]+)`/g;

/**
 * The path-shaped tokens of an explanation the model wasn't shown, each once.
 * A token with a slash counts anywhere. One without a slash counts only inside
 * backticks, where the prompt has the model put every path: in running prose
 * "Next.js" is a product, not a file. So a bare filename in prose, outside
 * backticks, isn't checked.
 */
export function inventedPaths(body: string, shown: Set<string>): string[] {
  const found = [...tokens(body).filter((t) => t.includes("/")), ...[...body.matchAll(CODE_SPAN)].flatMap((s) => tokens(s[1]).filter((t) => !t.includes("/")))];
  return [...new Set(found.filter((t) => !shown.has(t)))];
}

function tokens(text: string): string[] {
  return [...text.matchAll(FILE)].map((m) => unwrapped(m[0]));
}

// A path can start with a route group or a dynamic segment, so a leading
// bracket is kept when it closes inside the token: `(workspace)/page.tsx`,
// `[id]/page.tsx`. One that doesn't close is the prose around it: "(lib/x.ts)".
function unwrapped(token: string): string {
  let t = token;
  while ((t[0] === "(" && count(t, "(") > count(t, ")")) || (t[0] === "[" && count(t, "[") > count(t, "]"))) t = t.slice(1);
  return t;
}

function count(s: string, c: string): number {
  return s.split(c).length - 1;
}
