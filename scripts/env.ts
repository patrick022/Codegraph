// Import first, before anything that reads process.env at import time. Loads
// the files `next dev` loads, in its order: a value already set wins over any
// file, and an earlier file wins over a later one, exactly as Next resolves it.

import { existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
for (const name of [".env.development.local", ".env.local", ".env.development", ".env"]) {
  const file = path.join(root, name);
  if (existsSync(file)) process.loadEnvFile(file);
}
