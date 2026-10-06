import type { Coverage, Edge, FileNode } from "../../parser/types.ts";

// What the map draws: the parser's result minus each file's import records.
// Those aren't stored (coverage keeps their counts), so the map is typed not
// to need them rather than handed empty lists that would claim a file imports
// nothing. A full ParseResult still fits, which is what the scripts pass.
export type MapFile = Omit<FileNode, "imports">;

export type MapData = {
  adapter: string;
  files: MapFile[];
  edges: Edge[];
  coverage: Coverage;
};
