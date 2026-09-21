import fs from 'node:fs';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { isRepoRoot, tryGit } from './git.js';
import { setExcludes } from './gitExclude.js';
import { readFileOr } from './managedBlock.js';

/**
 * `.dokuignore` marks docs that stay on this machine only: not synced by git and
 * not included in zips. Same syntax as .gitignore. One file per storage project
 * (`storage/<name>/.dokuignore`), plus an optional one at the storage root that
 * applies to every project.
 */
export const IGNORE_FILE = '.dokuignore';

function activeRules(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l && !l.startsWith('#'));
}

export function readRules(dir: string): string[] {
  return activeRules(readFileOr(path.join(dir, IGNORE_FILE)));
}

/** Append patterns not already present. Returns the ones added. */
export function addRules(dir: string, patterns: string[]): string[] {
  const file = path.join(dir, IGNORE_FILE);
  const text = readFileOr(file);
  const existing = new Set(activeRules(text));
  const added = [...new Set(patterns)].filter((p) => !existing.has(p));
  if (added.length) {
    const sep = text && !text.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(file, text + sep + added.join('\n') + '\n');
  }
  return added;
}

/** Remove exact pattern lines. Deletes the file when nothing is left. Returns the ones removed. */
export function removeRules(dir: string, patterns: string[]): string[] {
  const file = path.join(dir, IGNORE_FILE);
  const lines = readFileOr(file).split(/\r?\n/);
  const removed = patterns.filter((p) => lines.some((l) => l.trimEnd() === p));
  if (!removed.length) return [];
  const kept = lines.filter((l) => !patterns.includes(l.trimEnd())).join('\n');
  if (kept.trim() === '') fs.rmSync(file);
  else fs.writeFileSync(file, kept.replace(/\n*$/, '\n'));
  return removed;
}

function storageProjectDirs(storagePath: string): string[] {
  if (!fs.existsSync(storagePath)) return [];
  return fs
    .readdirSync(storagePath, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name);
}

/**
 * Rewrite a .dokuignore pattern from `storage/<prefix>/` so it works from the
 * storage root, keeping gitignore semantics: patterns with an inner or leading
 * slash are anchored to the project folder, others match at any depth below it.
 */
export function toRootPattern(prefix: string, line: string): string {
  let rule = line;
  let neg = '';
  if (rule.startsWith('!')) {
    neg = '!';
    rule = rule.slice(1);
  }
  const anchored = rule.replace(/\/$/, '').includes('/');
  rule = rule.replace(/^\//, '');
  if (!prefix) return neg + (anchored ? '/' : '') + rule;
  const escaped = prefix.replace(/[[\]!#]/g, '\\$&');
  return `${neg}/${escaped}${anchored ? '/' : '/**/'}${rule}`;
}

export function gitPatterns(storagePath: string): string[] {
  const patterns = readRules(storagePath).map((l) => toRootPattern('', l));
  for (const name of storageProjectDirs(storagePath)) {
    patterns.push(...readRules(path.join(storagePath, name)).map((l) => toRootPattern(name, l)));
  }
  return patterns;
}

/**
 * Mirror all .dokuignore files into the storage's local git exclude. Returns files
 * that are ignored but were already committed (git keeps syncing those).
 */
export function applyIgnoresToGit(storagePath: string): string[] {
  if (!isRepoRoot(storagePath)) return [];
  setExcludes(storagePath, gitPatterns(storagePath));
  const res = tryGit(storagePath, ['ls-files', '--cached', '--ignored', '--exclude-standard']);
  return res.ok && res.stdout ? res.stdout.split('\n') : [];
}

/** Tests a posix path relative to the storage root against the root and project .dokuignore files. */
export type Matcher = (rel: string, isDir: boolean) => boolean;

export function createMatcher(storagePath: string): Matcher {
  const root = ignore().add(readRules(storagePath));
  const projects = new Map<string, Ignore>();
  const forProject = (name: string) => {
    let ig = projects.get(name);
    if (!ig) projects.set(name, (ig = ignore().add(readRules(path.join(storagePath, name)))));
    return ig;
  };
  return (rel, isDir) => {
    const suffix = isDir ? '/' : '';
    if (root.ignores(rel + suffix)) return true;
    const slash = rel.indexOf('/');
    if (slash === -1) return false;
    return forProject(rel.slice(0, slash)).ignores(rel.slice(slash + 1) + suffix);
  };
}
