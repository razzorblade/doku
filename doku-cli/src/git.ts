import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DokuError } from './errors.js';

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Run git and capture output; never throws on a non-zero exit. */
export function tryGit(cwd: string, args: string[]): GitResult {
  const res = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (res.error) throw new DokuError(`Cannot run git: ${res.error.message}`);
  return { ok: res.status === 0, stdout: res.stdout.trim(), stderr: res.stderr.trim() };
}

/** Run git and capture output; throws a DokuError with git's message on failure. */
export function git(cwd: string, args: string[]): string {
  const res = tryGit(cwd, args);
  if (!res.ok) throw new DokuError(`git ${args.join(' ')} failed:\n${res.stderr || res.stdout}`);
  return res.stdout;
}

/** Run git with output streamed to the terminal. Returns whether it succeeded. */
export function gitInteractive(cwd: string, args: string[]): boolean {
  try {
    execFileSync('git', ['-C', cwd, ...args], { stdio: 'inherit' });
    return true;
  } catch {
    return false;
  }
}

/**
 * True only when `dir` is the top level of its own repository. A folder that merely
 * sits inside some parent repo does not count: git commands run there would act on
 * the parent (the storage may live inside another repo, e.g. next to doku-cli).
 */
export function isRepoRoot(dir: string): boolean {
  const top = repoRoot(dir);
  if (!top) return false;
  const real = (p: string) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  const a = real(top);
  const b = real(dir);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Top level of the work tree containing `dir`, or null when not in a repo. */
export function repoRoot(dir: string): string | null {
  const res = tryGit(dir, ['rev-parse', '--show-toplevel']);
  return res.ok ? res.stdout : null;
}
