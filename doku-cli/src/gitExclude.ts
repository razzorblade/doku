import fs from 'node:fs';
import path from 'node:path';
import { tryGit } from './git.js';
import { readBlock, readFileOr, removeBlock, upsertBlock } from './managedBlock.js';

const MARKERS = { start: '# doku:start', end: '# doku:end' };

/**
 * Path of the repo-local ignore file (`.git/info/exclude`), resolved through git so
 * worktrees and submodules (where `.git` is a file) work. Null when not a git repo.
 */
export function excludeFile(projectPath: string): string | null {
  const res = tryGit(projectPath, ['rev-parse', '--git-path', 'info/exclude']);
  return res.ok ? path.resolve(projectPath, res.stdout) : null;
}

function entriesIn(text: string): string[] {
  const body = readBlock(text, MARKERS);
  return body ? body.split(/\r?\n/).filter(Boolean) : [];
}

function write(file: string, text: string, entries: string[]): void {
  const next = entries.length ? upsertBlock(text, MARKERS, entries.join('\n')) : removeBlock(text, MARKERS);
  if (next === text) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
}

/** Exclude a path relative to the repo root, e.g. `/.doku`. Returns false when not a git repo. */
export function addExclude(projectPath: string, entry: string): boolean {
  const file = excludeFile(projectPath);
  if (!file) return false;
  const text = readFileOr(file);
  const entries = entriesIn(text);
  if (!entries.includes(entry)) entries.push(entry);
  write(file, text, entries);
  return true;
}

export function removeExclude(projectPath: string, entry: string): void {
  const file = excludeFile(projectPath);
  if (!file) return;
  const text = readFileOr(file);
  write(file, text, entriesIn(text).filter((e) => e !== entry));
}

/** Replace all of doku's entries at once. Returns false when not a git repo. */
export function setExcludes(repoPath: string, entries: string[]): boolean {
  const file = excludeFile(repoPath);
  if (!file) return false;
  write(file, readFileOr(file), entries);
  return true;
}

/** The exclude pattern for a path inside the project, anchored at the repo root. */
export function excludeEntryFor(projectPath: string, relPath: string): string {
  const top = tryGit(projectPath, ['rev-parse', '--show-toplevel']);
  const root = top.ok ? top.stdout : projectPath;
  const rel = path.relative(root, path.join(projectPath, relPath)).split(path.sep).join('/');
  // No trailing slash: a junction/symlink is matched as a file by git, a directory otherwise.
  return '/' + rel;
}

export function isTracked(projectPath: string, relPath: string): boolean {
  return tryGit(projectPath, ['ls-files', '--error-unmatch', '--', relPath]).ok;
}
