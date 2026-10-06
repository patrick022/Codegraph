import type { FrameworkAdapter } from "../adapter.ts";
import { nestjsAdapter } from "./nestjs.ts";
import { nextjsAdapter } from "./nextjs.ts";
import { reactAdapter } from "./react.ts";
import { NO_ROUTES, toolConventions, toolRole } from "./shared.ts";

// Assumes no framework: only the tool conventions give any file a role.
export const fallbackAdapter: FrameworkAdapter = {
  name: "none",
  ignoredDirectories: [],
  detects: () => true,
  reachedBy: toolConventions,
  begin: () => ({ inspect: (path) => toolRole(path), routes: () => NO_ROUTES }),
};

// Fixed order, first match wins. Frameworks built on React come before React
// itself, since they depend on it too, and the fallback stays last.
const ADAPTERS: readonly FrameworkAdapter[] = [nextjsAdapter, nestjsAdapter, reactAdapter, fallbackAdapter];

/** The first adapter whose framework a package.json's dependencies declare. */
export function selectAdapter(dependencies: ReadonlySet<string>): FrameworkAdapter {
  // The fallback detects anything, so find never comes back empty.
  return ADAPTERS.find((a) => a.detects(dependencies))!;
}
