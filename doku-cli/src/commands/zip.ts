import fs from 'node:fs';
import path from 'node:path';
import { requireConfig } from '../config.js';
import { applyIgnoresToGit } from '../dokuignore.js';
import { DokuError } from '../errors.js';
import { addExclude, excludeEntryFor } from '../gitExclude.js';
import { log } from '../log.js';
import { assertSegment, isInside } from '../paths.js';
import type { LinkEntry } from '../registry.js';
import { docsContextOf, projectAt } from '../resolve.js';
import { collectFiles, writeZip } from '../zip.js';
import { revealInFolder } from './open.js';

export interface ZipOptions {
  output?: string;
  silent?: boolean;
  cwd?: string;
}

/** Archive name for a linked project: `.doku.zip` in the project root. */
export function projectZipName(entry: Pick<LinkEntry, 'linkName'>): string {
  return `${entry.linkName}.zip`;
}

function isStorageProject(name: string, storagePath: string): boolean {
  try {
    assertSegment(name, 'project name');
  } catch {
    return false;
  }
  return fs.existsSync(path.join(storagePath, name));
}

/** Which storage project `target` means (null = whole storage), and the link it came through. */
function resolveTarget(target: string | undefined, cwd: string, storagePath: string) {
  if (target === undefined) return { name: undefined, entry: undefined };
  const abs = path.resolve(cwd, target);
  const ctx = docsContextOf(abs, storagePath);
  if (ctx) return { name: ctx.name, entry: ctx.entry };
  if (isInside(abs, storagePath)) return { name: undefined, entry: undefined };
  const entry = projectAt(abs);
  if (entry) return { name: entry.name, entry };
  if (isStorageProject(target, storagePath)) return { name: target, entry: undefined };
  throw new DokuError(`Not in a doku project: ${abs}. Pass a linked project path, a storage project name, or nothing for the whole storage.`);
}

/** Default output folder: here, unless here is inside the storage (the zip would include itself). */
function defaultDir(cwd: string, storagePath: string): string {
  return isInside(cwd, storagePath) ? path.dirname(storagePath) : cwd;
}

export function zipCommand(target: string | undefined, opts: ZipOptions = {}): string {
  const { storagePath } = requireConfig();
  const cwd = opts.cwd ?? process.cwd();
  const { name, entry } = resolveTarget(target, cwd, storagePath);

  let out: string;
  if (opts.output) out = path.resolve(cwd, opts.output);
  else if (entry) out = path.join(entry.projectPath, projectZipName(entry));
  else out = path.join(defaultDir(cwd, storagePath), `${name ?? path.basename(storagePath)}.zip`);

  // Keep git's view in sync with .dokuignore while we're at it.
  applyIgnoresToGit(storagePath);
  const { count, bytes } = writeZip(collectFiles(storagePath, name), out);

  if (entry && !opts.output) addExclude(entry.projectPath, excludeEntryFor(entry.projectPath, projectZipName(entry)));

  if (opts.silent) {
    console.log(out);
  } else {
    log.ok(`Zipped ${count} file(s) from ${name ?? 'the whole storage'} (${(bytes / 1024).toFixed(1)} KB)`);
    log.info(`  ${out}`);
    revealInFolder(out);
  }
  return out;
}
