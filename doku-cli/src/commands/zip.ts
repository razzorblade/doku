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
import { confirm, type Prompter, stdinPrompter } from '../prompt.js';
import { collectFiles, writeZip, type ZipMeta } from '../zip.js';
import { storageProjects } from './list.js';
import { revealInFolder } from './open.js';

export interface ZipOptions {
  output?: string;
  silent?: boolean;
  /** Zip the whole storage without asking. */
  all?: boolean;
  cwd?: string;
  prompter?: Prompter;
}

/** Archive name for a linked project, in the project root: `my-project.doku.zip`. */
export function projectZipName(entry: Pick<LinkEntry, 'name' | 'linkName'>): string {
  return `${entry.name}.${entry.linkName.replace(/^\./, '')}.zip`;
}

/** Name used before the project name was added (`.doku.zip`); still cleaned up by unlink. */
export function legacyZipName(entry: Pick<LinkEntry, 'linkName'>): string {
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

interface Target {
  /** Storage project, or undefined for the whole storage. */
  name?: string;
  /** The link it was reached through, if any. */
  entry?: LinkEntry;
}

/** The project of the current folder, when it is a linked project, its docs, or a project folder in the storage. */
function projectHere(cwd: string, storagePath: string): Target | null {
  const ctx = docsContextOf(cwd, storagePath);
  if (ctx) return { name: ctx.name, entry: ctx.entry };
  const entry = projectAt(cwd);
  return entry ? { name: entry.name, entry } : null;
}

/** Which storage project `target` means (name undefined = whole storage), and the link it came through. */
function resolveTarget(target: string, cwd: string, storagePath: string): Target {
  const abs = path.resolve(cwd, target);
  const ctx = docsContextOf(abs, storagePath);
  if (ctx) return { name: ctx.name, entry: ctx.entry };
  if (isInside(abs, storagePath)) return { name: undefined, entry: undefined };
  const entry = projectAt(abs);
  if (entry) return { name: entry.name, entry };
  if (isStorageProject(target, storagePath)) return { name: target, entry: undefined };
  throw new DokuError(`Not in a doku project: ${abs}. Pass a linked project path, a storage project name, or --all for the whole storage.`);
}

/** Default output folder: here, unless here is inside the storage (the zip would include itself). */
function defaultDir(cwd: string, storagePath: string): string {
  return isInside(cwd, storagePath) ? path.dirname(storagePath) : cwd;
}

/**
 * What to zip: the given target, else the project we're in, else (after asking) the
 * whole storage. Null when the user declined.
 */
async function pickTarget(target: string | undefined, opts: ZipOptions, cwd: string, storagePath: string): Promise<Target | null> {
  if (opts.all) {
    if (target !== undefined) throw new DokuError('Pass either a project or --all, not both.');
    return {};
  }
  if (target !== undefined) return resolveTarget(target, cwd, storagePath);
  const here = projectHere(cwd, storagePath);
  if (here) return here;

  const count = storageProjects(storagePath).length;
  log.info(`${cwd} is not in a doku project.`);
  const p = opts.prompter ?? stdinPrompter();
  try {
    return (await confirm(p, `Zip the whole storage (${count} project(s))?`)) ? {} : null;
  } finally {
    if (!opts.prompter) p.close();
  }
}

/** Zip one project or the whole storage. Returns the zip path, or null when the user declined. */
export async function zipCommand(target: string | undefined, opts: ZipOptions = {}): Promise<string | null> {
  const { storagePath } = requireConfig();
  const cwd = opts.cwd ?? process.cwd();
  const picked = await pickTarget(target, opts, cwd, storagePath);
  if (!picked) {
    log.warn('Nothing zipped. Pass a project (`doku zip <project>`), or `--all` for the whole storage.');
    return null;
  }
  const { name, entry } = picked;

  let out: string;
  if (opts.output) out = path.resolve(cwd, opts.output);
  else if (entry) out = path.join(entry.projectPath, projectZipName(entry));
  else out = path.join(defaultDir(cwd, storagePath), `${name ?? path.basename(storagePath)}.zip`);

  // Keep git's view in sync with .dokuignore while we're at it.
  applyIgnoresToGit(storagePath);
  const meta: ZipMeta = name
    ? { doku: 1, kind: 'project', name, created: new Date().toISOString() }
    : { doku: 1, kind: 'storage', created: new Date().toISOString() };
  const { count, bytes } = writeZip(collectFiles(storagePath, name), out, meta);

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
