// Express has no file conventions of its own; what it has is a folder habit
// its generators and most tutorials share. Repositories spell the folders both
// ways, so singular and plural name the same role.

import type { Role } from "../../lib/roles.ts";
import type { FrameworkAdapter } from "../adapter.ts";
import { reactRole } from "./react.ts";
import { toolConventions, toolRole } from "./shared.ts";

const FOLDER_ROLES: Record<string, Role> = {
  route: "router",
  routes: "router",
  router: "router",
  routers: "router",
  controller: "controller",
  controllers: "controller",
  service: "service",
  services: "service",
  model: "model",
  models: "model",
  middleware: "middleware",
  middlewares: "middleware",
};

// The folder nearest the file decides, so routes/v1/middleware/auth.js is
// middleware rather than a router.
function folderRole(path: string): Role | null {
  const folders = path.split("/").slice(0, -1);
  for (let i = folders.length - 1; i >= 0; i--) {
    // Own keys only: a folder called "constructor" isn't a role.
    const folder = folders[i] ?? "";
    if (Object.hasOwn(FOLDER_ROLES, folder)) return FOLDER_ROLES[folder] ?? null;
  }
  return null;
}

export const expressAdapter: FrameworkAdapter = {
  name: "Express",
  ignoredDirectories: [],
  detects: (deps) => deps.has("express"),
  reachedBy: toolConventions,
  begin: () => ({
    // A test file under routes/ is still a test. Outside the folder habit,
    // React's own conventions still hold: one package often serves both the
    // API and the views it renders, and first-match detection picks Express.
    inspect: (path, source) => toolRole(path) ?? folderRole(path) ?? reactRole(path, source),
    // A pattern is assembled at runtime from the paths each router is mounted
    // on, which can be variables, arrays or regular expressions, through any
    // depth of app.use(). Reading one exactly would mean running the app.
    routes: () => ({
      routes: [],
      omitted: [],
      withheld: "Express puts each route together at runtime from the routers and paths it's mounted on",
    }),
  }),
};
