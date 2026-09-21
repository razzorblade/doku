import fs from 'node:fs';
import path from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { createMatcher } from './dokuignore.js';
import { DokuError } from './errors.js';
import { samePath } from './paths.js';

/** Written into every zip by `doku zip` so `doku load` knows what it holds. Never extracted. */
export const META_FILE = '.doku-meta.json';

export interface ZipMeta {
  doku: 1;
  /** One storage project (entries relative to it), or the whole storage (entries start with the project name). */
  kind: 'project' | 'storage';
  /** Storage project name, for `kind: 'project'`. */
  name?: string;
  created: string;
}

export interface ZipFile {
  abs: string;
  /** Posix path inside the archive. */
  entry: string;
}

/**
 * Files of the whole storage, or of one project in it, minus .dokuignore'd files,
 * `.git` folders and links. Entries are relative to the zipped folder.
 */
export function collectFiles(storagePath: string, name?: string): ZipFile[] {
  const matcher = createMatcher(storagePath);
  const files: ZipFile[] = [];
  const walk = (dir: string, rel: string) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      const abs = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (d.name !== '.git' && !matcher(childRel, true)) walk(abs, childRel);
      } else if (d.isFile() && !matcher(childRel, false)) {
        files.push({ abs, entry: name ? childRel.slice(name.length + 1) : childRel });
      }
    }
  };
  walk(name ? path.join(storagePath, name) : storagePath, name ?? '');
  return files.sort((a, b) => a.entry.localeCompare(b.entry));
}

export function writeZip(files: ZipFile[], out: string, meta?: ZipMeta): { count: number; bytes: number } {
  const data: Zippable = {};
  if (meta) data[META_FILE] = strToU8(JSON.stringify(meta, null, 2) + '\n');
  let count = 0;
  for (const f of files) {
    if (samePath(f.abs, out)) continue;
    data[f.entry] = [fs.readFileSync(f.abs), { mtime: fs.statSync(f.abs).mtime }];
    count++;
  }
  const zipped = zipSync(data, { level: 6 });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, zipped);
  return { count, bytes: zipped.length };
}

export interface ZipContents {
  meta: ZipMeta | null;
  /** Posix path → content, relative to the zipped folder. */
  files: Map<string, Uint8Array>;
  /** Folder every entry was in, when the zip wrapped a single folder (e.g. zipped by the OS). */
  topFolder?: string;
  /** Entries left out: absolute paths, `..`, invalid names, `.git`. */
  skipped: string[];
}

/** A zip entry as a safe relative posix path, or null when it could escape the target or is not wanted. */
export function safeEntryPath(entry: string): string | null {
  const rel = entry.replace(/\\/g, '/');
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) return null;
  const segments = rel.split('/');
  const bad = (s: string) =>
    !s || s === '.' || s === '..' || s === '.git' || /[<>:"|?*\x00-\x1f]/.test(s) || /[. ]$/.test(s);
  return segments.some(bad) ? null : rel;
}

function parseMeta(data: Uint8Array): ZipMeta | null {
  try {
    const meta = JSON.parse(strFromU8(data)) as ZipMeta;
    return meta && meta.doku === 1 && (meta.kind === 'project' || meta.kind === 'storage') ? meta : null;
  } catch {
    return null;
  }
}

/** Read a zip into memory, validating every path. Nothing is written. */
export function readZip(file: string): ZipContents {
  let raw: Record<string, Uint8Array>;
  try {
    raw = unzipSync(fs.readFileSync(file));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new DokuError(`${file} does not exist.`);
    throw new DokuError(`${file} is not a readable zip file: ${(err as Error).message}`);
  }
  let files = new Map<string, Uint8Array>();
  const skipped: string[] = [];
  for (const [entry, data] of Object.entries(raw)) {
    if (/[/\\]$/.test(entry)) continue; // folder entry
    const rel = safeEntryPath(entry);
    if (rel) files.set(rel, data);
    else skipped.push(entry);
  }

  // Unwrap a single top folder (a folder zipped by the OS), unless the metadata sits at the root.
  let topFolder: string | undefined;
  const tops = new Set([...files.keys()].map((k) => k.split('/')[0]));
  if (!files.has(META_FILE) && tops.size === 1 && [...files.keys()].every((k) => k.includes('/'))) {
    topFolder = [...tops][0];
    files = new Map([...files].map(([k, v]) => [k.slice(topFolder!.length + 1), v]));
  }

  const metaData = files.get(META_FILE);
  files.delete(META_FILE);
  return { meta: metaData ? parseMeta(metaData) : null, files, topFolder, skipped };
}
