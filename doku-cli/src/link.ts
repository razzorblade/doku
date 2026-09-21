import fs from 'node:fs';
import { DokuError } from './errors.js';
import { assertLocalPath, isInside, normalizeTarget, samePath } from './paths.js';

export type LinkState =
  | { kind: 'missing' }
  | { kind: 'link'; target: string; targetExists: boolean }
  | { kind: 'other' };

/** Describe what sits at `linkPath` without following it. */
export function inspectLink(linkPath: string): LinkState {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(linkPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw err;
  }
  if (!stat.isSymbolicLink()) return { kind: 'other' };
  const target = normalizeTarget(fs.readlinkSync(linkPath));
  return { kind: 'link', target, targetExists: fs.existsSync(target) };
}

/**
 * Create a directory junction (Windows) or directory symlink (elsewhere) at
 * `linkPath` pointing to `target`. Junctions need no admin rights or Developer Mode.
 * Returns false when an identical link already exists.
 */
export function createLink(target: string, linkPath: string): boolean {
  assertLocalPath(target, 'Link target');
  const state = inspectLink(linkPath);
  if (state.kind === 'link' && samePath(state.target, target)) return false;
  if (state.kind === 'link') {
    throw new DokuError(`${linkPath} is already a link to ${state.target}. Run \`doku unlink\` first.`);
  }
  if (state.kind === 'other') {
    throw new DokuError(`${linkPath} already exists and is not a link. Move it away or use --as <otherName>.`);
  }
  fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  return true;
}

/**
 * Remove the link itself, never what it points to. Refuses anything that is not a
 * link, and (when `storagePath` is given) links that point outside the storage.
 * Returns false when there was nothing to remove.
 */
export function removeLink(linkPath: string, storagePath?: string): boolean {
  const state = inspectLink(linkPath);
  if (state.kind === 'missing') return false;
  if (state.kind === 'other') {
    throw new DokuError(`${linkPath} is a real file or folder, not a doku link. Refusing to remove it.`);
  }
  if (storagePath && !isInside(state.target, storagePath)) {
    throw new DokuError(`${linkPath} points to ${state.target}, outside the doku storage. Refusing to remove it.`);
  }
  // unlink/rmdir on a junction or symlink removes only the reparse point, not the target's contents.
  try {
    fs.unlinkSync(linkPath);
  } catch {
    fs.rmdirSync(linkPath);
  }
  return true;
}
