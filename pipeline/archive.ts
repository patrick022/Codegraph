// A public GitHub repository, fetched as the archive GitHub serves anyone. No
// token, no API, no repository scope: if it isn't public, it isn't reachable.

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";

export type Repository = { owner: string; name: string };

// One deployable app, parsing inside a request: a repository bigger than this
// is a limit stated honestly, not something to build around.
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024;

// A hung request would otherwise hold the run in its stage until it goes
// stale. The archive's limit covers streaming the whole body, so it's longer.
const REDIRECT_TIMEOUT_MS = 15_000;
const ARCHIVE_TIMEOUT_MS = 5 * 60_000;

// GitHub's own rules for owner and repository names.
const OWNER = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;
const NAME = /^[a-z0-9._-]{1,100}$/;

/**
 * Read owner and name from what someone pasted: a github.com URL with or
 * without scheme, `.git`, or a trailing /tree/... path. Null for anything else.
 * Lowercased, because GitHub names aren't case-sensitive and one repository
 * must be one analysis.
 */
export function parseRepositoryUrl(input: string): Repository | null {
  const trimmed = input.trim();
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return null;
  const [owner, rawName] = url.pathname.toLowerCase().split("/").filter(Boolean);
  const name = rawName?.replace(/\.git$/, "");
  if (!owner || !name || !OWNER.test(owner) || !NAME.test(name) || name === "." || name === "..") return null;
  return { owner, name };
}

/**
 * Download the default branch and unpack it into a fresh temporary directory.
 * The commit comes from GitHub's redirect, and the archive is then fetched by
 * that exact commit, so the recorded commit is the one that was parsed.
 * The caller removes `dir`.
 */
export async function fetchArchive(repo: Repository) {
  try {
    return await download(repo);
  } catch (e) {
    // An aborted fetch throws a bare "TimeoutError"; the failed row should say what timed out.
    if (e instanceof Error && e.name === "TimeoutError") {
      throw new Error(`Downloading github.com/${repo.owner}/${repo.name} took too long, so it was stopped`, { cause: e });
    }
    throw e;
  }
}

async function download({ owner, name }: Repository) {
  const head = await fetch(`https://github.com/${owner}/${name}/archive/HEAD.tar.gz`, {
    redirect: "manual",
    signal: AbortSignal.timeout(REDIRECT_TIMEOUT_MS),
  });
  await head.body?.cancel();
  if (head.status === 404) throw new Error(`github.com/${owner}/${name} doesn't exist, or isn't public`);
  const location = head.headers.get("location");
  const commit = location ? /\/tar\.gz\/([0-9a-f]{40})$/.exec(location)?.[1] : undefined;
  if (head.status !== 302 || !location || !commit) {
    throw new Error(`GitHub answered ${head.status} without naming a commit for github.com/${owner}/${name}`);
  }

  // One signal for the request and the body, so the limit is on the whole download.
  const res = await fetch(location, { signal: AbortSignal.timeout(ARCHIVE_TIMEOUT_MS) });
  if (!res.ok || !res.body) throw new Error(`GitHub answered ${res.status} for the archive of ${commit.slice(0, 7)}`);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const reader = res.body.getReader();
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    bytes += chunk.value.byteLength;
    if (bytes > MAX_DOWNLOAD_BYTES) {
      await reader.cancel();
      throw new Error(`Archive is over ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB compressed, larger than this app parses`);
    }
    chunks.push(chunk.value);
  }

  let tar: Buffer;
  try {
    tar = await promisify(gunzip)(Buffer.concat(chunks), { maxOutputLength: MAX_UNPACKED_BYTES });
  } catch (e) {
    if (e instanceof RangeError) throw new Error(`Archive unpacks to over ${MAX_UNPACKED_BYTES / 1024 / 1024} MB, larger than this app parses`);
    throw e;
  }

  const dir = await mkdtemp(path.join(tmpdir(), "codegraph-"));
  try {
    return { dir, commit, bytes, files: await unpack(tar, dir) };
  } catch (e) {
    // The caller never gets dir on failure, so it's removed here.
    await rm(dir, { recursive: true, force: true });
    throw e;
  }
}

/**
 * Write a tar's regular files, directories and symbolic links under `root`,
 * dropping the single top-level folder git archive wraps everything in.
 * Handles exactly what `git archive` emits (ustar plus pax headers); any other
 * entry type, or a path or link leaving `root`, fails rather than being skipped.
 */
async function unpack(tar: Buffer, root: string): Promise<number> {
  const made = new Set<string>();
  /** Create a directory once, however many files land in it. */
  const ensureDir = async (dir: string) => {
    if (made.has(dir)) return;
    await mkdir(dir, { recursive: true });
    made.add(dir);
  };
  /** Resolve an archive path under root, refusing anything that escapes it. */
  const inside = (rel: string) => {
    const dest = path.resolve(root, rel);
    if (!dest.startsWith(root + path.sep)) throw new Error(`Archive entry ${JSON.stringify(rel)} points outside the repository`);
    return dest;
  };

  // Links are made last: Windows needs to know whether the target is a
  // directory, which it can only tell once the target exists.
  const links: { dest: string; target: string }[] = [];
  let files = 0;
  let pax: Record<string, string> = {};

  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    /** Read a NUL-terminated header field. */
    const field = (start: number, length: number) => {
      const raw = header.subarray(start, start + length);
      const end = raw.indexOf(0);
      return raw.subarray(0, end === -1 ? length : end).toString("utf8");
    };
    const size = parseInt(field(124, 12).trim() || "0", 8);
    if (!Number.isSafeInteger(size)) throw new Error("Archive has an entry with an unreadable size");
    const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;

    if (type === "g") continue; // git's global header: the commit id, already known
    if (type === "x") {
      pax = paxRecords(body);
      continue;
    }

    const prefix = field(345, 155);
    const full = pax.path ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    const linkTarget = pax.linkpath ?? field(157, 100);
    pax = {};
    const rel = full.split("/").slice(1).join("/").replace(/\/$/, "");
    if (!rel) continue;
    const dest = inside(rel);

    if (type === "5") await ensureDir(dest);
    else if (type === "0") {
      await ensureDir(path.dirname(dest));
      await writeFile(dest, body);
      files++;
    } else if (type === "2") {
      inside(path.relative(root, path.resolve(path.dirname(dest), linkTarget)));
      links.push({ dest, target: linkTarget });
    } else throw new Error(`Archive entry ${JSON.stringify(rel)} has tar type ${JSON.stringify(type)}, which git archive never writes`);
  }

  for (const { dest, target } of links) {
    await ensureDir(path.dirname(dest));
    await symlink(target, dest);
  }
  return files;
}

/** Parse pax extended header records: "<length> <key>=<value>\n", repeated. */
function paxRecords(body: Buffer): Record<string, string> {
  const records: Record<string, string> = {};
  let at = 0;
  while (at < body.length) {
    const space = body.indexOf(0x20, at);
    const length = parseInt(body.subarray(at, space).toString("utf8"), 10);
    if (space === -1 || !(length > 0)) break;
    const record = body.subarray(space + 1, at + length - 1).toString("utf8");
    const eq = record.indexOf("=");
    records[record.slice(0, eq)] = record.slice(eq + 1);
    at += length;
  }
  return records;
}
