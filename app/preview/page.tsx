import { join } from "node:path";
import { MapWorkspace } from "@/components/map/workspace";
import { CategorySwatch } from "@/components/swatch";
import { categoryLabel, countByCategory } from "@/lib/map/view";
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
  const categories = countByCategory(result.files.map((f) => f.path));

  // Fixed widths on the side columns: their content must never push the map around.
  return (
    <div className="flex h-full">
      <nav className="flex w-52 shrink-0 flex-col border-r border-border bg-surface">
        <h2 className="flex h-8 shrink-0 items-center px-3 text-xs text-muted">
          Categories <span className="ml-1 tabular-nums">· {result.files.length} files</span>
        </h2>
        <ul>
          {categories.map(({ category, count }) => (
            <li key={category} className="flex h-6 items-center gap-2 px-3 text-xs">
              <CategorySwatch category={category} />
              <span className="flex-1 font-mono">{categoryLabel(category)}</span>
              <span className="text-muted tabular-nums">{count}</span>
            </li>
          ))}
        </ul>
      </nav>
      <MapWorkspace name={REPOSITORY} result={result} />
    </div>
  );
}
