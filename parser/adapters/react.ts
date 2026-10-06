// React has two conventions a file can be read by. A hook's name starts with
// "use", which is React's own rule and its lint enforces it. A component renders JSX,
// which is in the syntax tree rather than in a naming habit, so a .tsx file of
// helpers isn't claimed as one. React has no routing convention, so no routes.

import { Node, type SourceFile } from "ts-morph";
import type { Role } from "../../lib/roles.ts";
import type { FrameworkAdapter } from "../adapter.ts";
import { fileName, NO_ROUTES, toolConventions, toolRole } from "./shared.ts";

const HOOK_NAME = /^use([A-Z0-9]|-[a-z0-9])/;

/** A hook by its name, a component by the JSX it contains, else null. Next.js asks this too. */
export function reactRole(path: string, source: SourceFile): Role | null {
  if (HOOK_NAME.test(fileName(path))) return "hook";
  if (containsJsx(source)) return "component";
  return null;
}

function containsJsx(source: SourceFile): boolean {
  return source.getFirstDescendant((n) => Node.isJsxElement(n) || Node.isJsxSelfClosingElement(n) || Node.isJsxFragment(n)) !== undefined;
}

export const reactAdapter: FrameworkAdapter = {
  name: "React",
  ignoredDirectories: [],
  detects: (deps) => deps.has("react"),
  reachedBy: toolConventions,
  begin: () => ({
    // Tests render JSX too; the runner's pattern says what they are first.
    inspect: (path, source) => toolRole(path) ?? reactRole(path, source),
    routes: () => NO_ROUTES,
  }),
};
