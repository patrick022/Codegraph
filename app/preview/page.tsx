import { join } from "node:path";
import { MapWorkspace } from "@/components/map/workspace";
import { readParseResult } from "@/parser/io";

// The parse result doesn't carry the repository's name, so the preview names
// the one it checked in.
const REPOSITORY = "excalidraw";

/**
 * Renders checked-in parser output through the real interface, so the map can
 * be built without an account, a database or a network. Goes away once
 * analyses are stored. Read through the typed reader, so a stale file fails
 * here by field path rather than as a blank map.
 */
export default function PreviewPage() {
  const result = readParseResult(join(process.cwd(), `data/${REPOSITORY}.json`));
  return (
    <div className="flex h-full">
      <MapWorkspace name={REPOSITORY} result={result} />
    </div>
  );
}
