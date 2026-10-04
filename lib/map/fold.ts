// Folding the directory tree into a readable number of groups. Pure: paths in,
// groups out. The repository's own shape decides the depth; nothing about
// which folders matter is picked in advance.

export const MAX_GROUPS = 24;
// "Fewer than a couple of files" is the starting rule.
const START_THRESHOLD = 2;

export type Group = { dir: string; files: string[] };

export type Folding = {
  // The lowest threshold that landed at or under MAX_GROUPS.
  threshold: number;
  groups: Group[];
  groupOf: ReadonlyMap<string, string>;
};

/** Fold sparse directories into ancestors using the smallest threshold that meets MAX_GROUPS. */
export function foldDirectories(files: readonly { path: string; folder: string }[]): Folding {
  // At a high enough threshold everything folds into the root, so this ends.
  for (let threshold = START_THRESHOLD; ; threshold++) {
    const groups = foldAt(files, threshold);
    if (groups.length <= MAX_GROUPS) {
      const groupOf = new Map<string, string>();
      for (const g of groups) for (const f of g.files) groupOf.set(f, g.dir);
      return { threshold, groups, groupOf };
    }
  }
}

/** Merge directories below the file threshold from deepest to shallowest, returning sorted nonempty groups. */
function foldAt(files: readonly { path: string; folder: string }[], threshold: number): Group[] {
  // Ancestors holding no files directly are directories too, so an empty level
  // folds away like any other.
  const members = new Map<string, string[]>();
  for (const f of files) {
    for (const dir of [f.folder, ...ancestors(f.folder)]) if (!members.has(dir)) members.set(dir, []);
    members.get(f.folder)?.push(f.path);
  }

  const maxDepth = Math.max(0, ...[...members.keys()].map(depth));
  for (let d = maxDepth; d >= 1; d--) {
    // Decide the whole level before applying any of it, so no merge at this
    // depth changes what another merge at the same depth sees.
    const merging = [...members].filter(([dir, list]) => depth(dir) === d && list.length < threshold);
    for (const [dir, list] of merging) {
      members.get(parentOf(dir))?.push(...list);
      members.delete(dir);
    }
  }

  return [...members]
    .filter(([, list]) => list.length > 0)
    .map(([dir, list]) => ({ dir, files: list.sort() }))
    .sort((a, b) => a.dir.localeCompare(b.dir));
}

/** Count repository-relative directory segments, treating the root marker as depth zero. */
function depth(dir: string): number {
  return dir === "." ? 0 : dir.split("/").length;
}

/** Return a repository-relative parent directory, using a dot for the root. */
function parentOf(dir: string): string {
  const i = dir.lastIndexOf("/");
  return i === -1 ? "." : dir.slice(0, i);
}

/** List parent directories from nearest to root, excluding the input directory. */
function ancestors(dir: string): string[] {
  const out: string[] = [];
  for (let d = dir; d !== "."; ) {
    d = parentOf(d);
    out.push(d);
  }
  return out;
}
