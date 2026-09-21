import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';

export interface Sandbox {
  root: string;
  storage: string;
  mkProject(name: string, gitInit?: boolean): string;
}

export function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

/** Fresh DOKU_HOME, storage and project folders per test; console output silenced. */
export function useSandbox(): Sandbox {
  const box = {} as Sandbox;
  beforeEach(() => {
    box.root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doku-test-')));
    box.storage = path.join(box.root, 'storage');
    box.mkProject = (name, gitInit = true) => {
      const dir = path.join(box.root, 'projects', name);
      fs.mkdirSync(dir, { recursive: true });
      if (gitInit) gitIn(dir, 'init', '-q');
      return dir;
    };
    vi.stubEnv('DOKU_HOME', path.join(box.root, 'home'));
    vi.stubEnv('GIT_AUTHOR_NAME', 'doku test');
    vi.stubEnv('GIT_AUTHOR_EMAIL', 'test@example.com');
    vi.stubEnv('GIT_COMMITTER_NAME', 'doku test');
    vi.stubEnv('GIT_COMMITTER_EMAIL', 'test@example.com');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(box.root, { recursive: true, force: true });
  });
  return box;
}
