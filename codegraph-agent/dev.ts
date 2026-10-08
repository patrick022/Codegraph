// `mda dev` can't find npx on Windows (0.9.0 and 0.9.1-dev.2 alike), so this
// does what it does: compile with `mda build`, install the build's locked
// dependencies, give it the project's .env plus the local-only values mda dev
// injects, and start the LangGraph dev server on :2024.
// ponytail: no rebuild on save, restart after changing the agent. Back to `mda dev` once it runs on Windows.

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync } from "node:fs";
import path from "node:path";

const root = import.meta.dirname;
const build = path.join(root, ".mda", "build");

function run(command: string, args: string[], cwd: string): void {
  // shell: the .cmd shims these resolve to on Windows only run through one.
  const { status } = spawnSync(command, args, { cwd, stdio: "inherit", shell: true });
  if (status !== 0) process.exit(status ?? 1);
}

run(path.join(root, "node_modules", ".bin", "mda"), ["build", "."], root);
copyFileSync(path.join(root, ".env"), path.join(build, ".env"));
// Local only: accept the app's calls without a LangSmith key check, as mda dev
// does. A deployment verifies the key instead.
appendFileSync(path.join(build, ".env"), "\nMDA_LOCAL_DEV=1\nMDA_PUBLIC_API_URL=http://localhost:2024\n");
run("npm", ["ci", "--no-audit", "--no-fund"], build);

const server = spawn(path.join(build, "node_modules", ".bin", "langgraphjs"), ["dev", "--no-browser", "--port", "2024"], {
  cwd: build,
  stdio: "inherit",
  shell: true,
});
server.on("exit", (code) => process.exit(code ?? 1));
