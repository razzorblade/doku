import fs from 'node:fs';
import path from 'node:path';
import { zipSync, type Zippable } from 'fflate';
import { createMatcher } from './dokuignore.js';
import { samePath } from './paths.js';

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

export function writeZip(files: ZipFile[], out: string): { count: number; bytes: number } {
  const data: Zippable = {};
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
