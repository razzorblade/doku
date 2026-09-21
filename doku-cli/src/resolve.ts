import path from 'node:path';
import { DokuError } from './errors.js';
import { isInside, normalizeTarget } from './paths.js';
import { type LinkEntry, linkPathOf, loadLinks } from './registry.js';

/** Where a path sits relative to doku: which storage project, and the path inside its docs. */
export interface DocsContext {
  name: string;
  /** Posix path inside the project's docs folder; '' for the folder itself. */
  rel: string;
  /** The link the path was reached through, if any. */
  entry?: LinkEntry;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** The registered project containing `dir` (innermost first), or null. */
export function projectAt(dir: string): LinkEntry | null {
  const matches = loadLinks().filter((l) => isInside(dir, l.projectPath));
  matches.sort((a, b) => b.projectPath.length - a.projectPath.length);
  return matches[0] ?? null;
}

/** Map an absolute path inside a linked docs folder or the storage to its storage project. */
export function docsContextOf(abs: string, storagePath: string): DocsContext | null {
  for (const entry of loadLinks()) {
    const linkPath = linkPathOf(entry);
    if (isInside(abs, linkPath)) {
      return { name: entry.name, rel: toPosix(path.relative(normalizeTarget(linkPath), normalizeTarget(abs))), entry };
    }
  }
  if (isInside(abs, storagePath)) {
    const [name, ...rest] = toPosix(path.relative(normalizeTarget(storagePath), normalizeTarget(abs))).split('/');
    if (name) return { name, rel: rest.join('/') };
  }
  return null;
}

/**
 * Resolve a user-supplied path (relative to `cwd`) to a location in a project's docs.
 * Inside a linked project, plain paths are taken relative to its docs folder, so
 * `doku ignore file1.md` in the project root means `.doku/file1.md`.
 */
export function resolveDocsPath(arg: string, cwd: string, storagePath: string): DocsContext {
  const direct = docsContextOf(path.resolve(cwd, arg), storagePath);
  if (direct) return direct;

  const project = projectAt(cwd);
  if (!project) {
    if (docsContextOf(cwd, storagePath)) throw new DokuError(`${arg} is outside the project's docs folder.`);
    throw new DokuError(`Not in a doku project: ${cwd}. Run this inside a linked project or its docs folder.`);
  }
  const rel = toPosix(path.normalize(arg)).replace(/^\.(\/|$)/, '').replace(/\/$/, '');
  if (path.isAbsolute(arg) || rel === '..' || rel.startsWith('../')) {
    throw new DokuError(`${arg} is outside the project's docs folder.`);
  }
  return { name: project.name, rel, entry: project };
}

/** The storage project for the current folder, for commands that take no path. */
export function currentProject(cwd: string, storagePath: string): DocsContext {
  const ctx = docsContextOf(cwd, storagePath);
  if (ctx) return ctx;
  const project = projectAt(cwd);
  if (project) return { name: project.name, rel: '', entry: project };
  throw new DokuError(`Not in a doku project: ${cwd}. Run this inside a linked project.`);
}
