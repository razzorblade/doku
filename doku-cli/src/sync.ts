import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyIgnoresToGit } from './dokuignore.js';
import { DokuError } from './errors.js';
import { git, gitInteractive, isRepoRoot, tryGit } from './git.js';
import { log } from './log.js';

export interface SyncResult {
  committed: boolean;
  pulled: boolean;
  pushed: boolean;
}

function rebaseInProgress(repo: string): boolean {
  const gitDir = path.resolve(repo, git(repo, ['rev-parse', '--git-dir']));
  return fs.existsSync(path.join(gitDir, 'rebase-merge')) || fs.existsSync(path.join(gitDir, 'rebase-apply'));
}

/** Commit everything in the storage, then pull --rebase and push if a remote is set up. */
export function syncStorage(storagePath: string, message?: string): SyncResult {
  if (!isRepoRoot(storagePath)) {
    throw new DokuError(`Storage ${storagePath} is not its own git repository. Run \`doku init\` to set it up.`);
  }
  if (rebaseInProgress(storagePath)) {
    throw new DokuError(`A rebase is in progress in ${storagePath}. Resolve it (git rebase --continue / --abort) first.`);
  }
  const result: SyncResult = { committed: false, pulled: false, pushed: false };

  // .dokuignore may have been edited by hand or pulled from another machine.
  const tracked = applyIgnoresToGit(storagePath);
  if (tracked.length) log.warn(`${tracked.length} ignored file(s) were synced before being ignored and keep syncing (see \`doku ignore\`).`);
  git(storagePath, ['add', '-A']);
  if (git(storagePath, ['status', '--porcelain']) !== '') {
    const msg = message ?? `doku sync ${os.hostname()} ${new Date().toISOString()}`;
    git(storagePath, ['commit', '-q', '-m', msg]);
    result.committed = true;
    log.ok(`Committed: ${msg}`);
  } else {
    log.step('Nothing to commit');
  }

  if (git(storagePath, ['remote']) === '') {
    log.warn('No git remote configured for the storage; skipping pull/push. Add one with `git remote add origin <url>`.');
    return result;
  }

  const hasUpstream = tryGit(storagePath, ['rev-parse', '--abbrev-ref', '@{u}']).ok;
  if (hasUpstream) {
    log.step('git pull --rebase');
    if (!gitInteractive(storagePath, ['pull', '--rebase'])) {
      if (rebaseInProgress(storagePath)) {
        throw new DokuError(
          `Pull hit a conflict. Resolve it in ${storagePath}:\n` +
            '  edit the conflicted files, then `git add <files>` and `git rebase --continue`\n' +
            '  (or `git rebase --abort` to go back), then run `doku sync` again.',
        );
      }
      throw new DokuError('git pull --rebase failed (see output above).');
    }
    result.pulled = true;
  }

  log.step('git push');
  const pushArgs = hasUpstream ? ['push'] : ['push', '-u', 'origin', 'HEAD'];
  if (!gitInteractive(storagePath, pushArgs)) throw new DokuError('git push failed (see output above).');
  result.pushed = true;
  return result;
}
