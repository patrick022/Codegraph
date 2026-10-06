// Framework knowledge enters the parser only through this interface. The
// parser asks the adapter questions; it never checks which framework it is
// looking at. The adapters, and detection, live in adapters/.
//
// A project is the repository root or any folder holding a package.json, and
// each project gets its own adapter, so a Next.js example inside a repository
// that isn't Next.js still has its pages recognised. Every path an adapter is
// asked about is relative to its project, not the repository.

import type { SourceFile } from "ts-morph";
import type { Framework, Role } from "../lib/roles.ts";
import type { OmittedRoute, Route } from "./types.ts";

export interface FrameworkAdapter {
  name: Framework;
  // Directory names the framework generates, skipped like node_modules. The
  // generic ones (dot-directories, dist, build, out, coverage) are skipped by
  // the walker regardless of adapter.
  ignoredDirectories: readonly string[];
  // Whether a package.json's dependencies and devDependencies say this framework.
  detects: (dependencies: ReadonlySet<string>) => boolean;
  // How something other than an import reaches this file: the framework
  // routing to it, a tool loading it by name, a test runner collecting it. Null
  // when only imports would. Answered from the path alone, so it's a
  // convention the file sits in, never a guess about what it does.
  reachedBy: (path: string) => string | null;
  // One reading of one project.
  begin: () => AdapterRun;
}

export interface AdapterRun {
  // Called once per parsed file while its syntax tree is open. Returns the
  // file's role from a convention: where it sits, what it's named, or a
  // directive or syntax it contains. Null when none applies; the file stays
  // unclassified rather than getting the nearest fit.
  inspect: (path: string, source: SourceFile) => Role | null;
  // Called after every file, with the project's code files that couldn't be
  // parsed and so could hold something that changes every route.
  routes: (unparsed: readonly string[]) => RouteReport;
}

export type RouteReport = {
  // Routes whose method and full pattern are both written in the syntax.
  routes: Route[];
  // Declared as routes, but the method or full pattern isn't written there.
  omitted: OmittedRoute[];
  // Set when something project-wide makes every pattern uncertain. Then
  // nothing is listed, not even what was omitted.
  withheld: string | null;
};
