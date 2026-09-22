import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { disableLocally } from './commands/encrypt.js';
import { applyIgnoresToGit } from './dokuignore.js';
import {
  CRYPT_FILE,
  cryptState,
  filtersInstalled,
  installFilters,
  LOCKED_HINT,
  plaintextBlobs,
  readKey,
  readLocalState,
  readMeta,
  readMetaAt,
  writeLocalState,
} from './encryption.js';
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

/**
 * Keep this machine's encryption setup in line with the storage: put back a deleted
 * metadata file, and turn encryption off here once another machine turned it off.
 * Returns true when files were re-added unencrypted.
 */
function reconcileEncryption(storage: string): boolean {
  if (readMeta(storage)) return false;
  if (readMetaAt(storage, 'HEAD')) {
    git(storage, ['checkout', 'HEAD', '--', CRYPT_FILE]);
    log.warn(`${CRYPT_FILE} was deleted; restored it. Use \`doku decrypt\` to turn encryption off.`);
    return false;
  }
  if (!readKey(storage)) return false;
  disableLocally(storage);
  return true;
}

function commitAll(storage: string, message: string | undefined, result: SyncResult): void {
  git(storage, ['add', '-A']);
  if (git(storage, ['status', '--porcelain']) !== '') {
    const msg = message ?? `doku sync ${os.hostname()} ${new Date().toISOString()}`;
    git(storage, ['commit', '-q', '-m', msg]);
    result.committed = true;
    log.ok(`Committed: ${msg}`);
  }
}

/** Refuse to push anything that should be encrypted but isn't. */
function verifyEncrypted(storage: string, revs: string[]): void {
  const bad = plaintextBlobs(storage, revs);
  if (!bad.length) return;
  const shown = bad.slice(0, 10).map((r) => `    ${r}`).join('\n') + (bad.length > 10 ? `\n    … and ${bad.length - 10} more` : '');
  throw new DokuError(
    `Not pushing: ${bad.length} file(s) in the commits to push are not encrypted:\n${shown}\n` +
      'They were committed without the encryption filter (e.g. by hand while it was not set up). To fix it, in the storage run\n' +
      '  git reset --soft @{u}   (or the last pushed commit), then `git add --renormalize .` and `doku sync` again.',
  );
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

  reconcileEncryption(storagePath);
  const crypt = cryptState(storagePath);
  // A locked clone has only ciphertext; anything new added there would go out unencrypted.
  if (crypt === 'locked') throw new DokuError(LOCKED_HINT);
  // Point git at this doku again, e.g. after doku-cli was moved.
  if (crypt === 'unlocked' && !filtersInstalled(storagePath)) installFilters(storagePath);

  // .dokuignore may have been edited by hand or pulled from another machine.
  const tracked = applyIgnoresToGit(storagePath);
  if (tracked.length) {
    log.warn(
      `${tracked.length} file(s) ignored by .dokuignore or .gitignore were synced before being ignored and keep syncing ` +
        '(`doku ignore` lists them).',
    );
  }
  commitAll(storagePath, message, result);
  if (!result.committed) log.step('Nothing to commit');

  if (git(storagePath, ['remote']) === '') {
    log.warn('No git remote configured for the storage; skipping pull/push. Add one with `git remote add origin <url>`.');
    return result;
  }

  // `doku encrypt` replaced the history; the remote still has the old, unencrypted one.
  const { replaceRemote } = readLocalState(storagePath);
  if (replaceRemote) {
    verifyEncrypted(storagePath, ['HEAD']);
    log.step('git push --force-with-lease (replacing the unencrypted history on the remote)');
    const pushed = gitInteractive(storagePath, ['push', '-u', `--force-with-lease=main:${replaceRemote}`, 'origin', 'HEAD']);
    if (!pushed) {
      throw new DokuError(
        'git push failed (see output above). If another machine pushed after `doku encrypt`, its changes are ' +
          'unencrypted: copy them over with `doku zip` / `doku load`, then run `doku sync` again.',
      );
    }
    writeLocalState(storagePath, { ...readLocalState(storagePath), replaceRemote: undefined });
    log.ok('The remote now has only the encrypted history.');
    result.pushed = true;
    return result;
  }

  const hasUpstream = tryGit(storagePath, ['rev-parse', '--abbrev-ref', '@{u}']).ok;
  if (hasUpstream) {
    log.step('git fetch');
    if (!gitInteractive(storagePath, ['fetch', '-q'])) throw new DokuError('git fetch failed (see output above).');
    // A remote with an unrelated history was replaced, e.g. encrypted on another machine.
    if (!tryGit(storagePath, ['merge-base', 'HEAD', '@{u}']).ok) {
      if (readMetaAt(storagePath, '@{u}') && crypt !== 'unlocked') {
        throw new DokuError(
          'The storage was encrypted on another machine, which replaced the history on the remote. ' +
            'Run `doku unlock` to switch this machine over (files only this machine has are kept).',
        );
      }
      throw new DokuError('The remote has a different history than this storage (it was replaced). Nothing was pulled or pushed.');
    }
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
    // The pull may have brought `doku decrypt` from another machine.
    if (reconcileEncryption(storagePath)) commitAll(storagePath, message, result);
  }

  if (cryptState(storagePath) === 'unlocked') verifyEncrypted(storagePath, hasUpstream ? ['HEAD', '--not', '@{u}'] : ['HEAD']);
  log.step('git push');
  const pushArgs = hasUpstream ? ['push'] : ['push', '-u', 'origin', 'HEAD'];
  if (!gitInteractive(storagePath, pushArgs)) throw new DokuError('git push failed (see output above).');
  result.pushed = true;
  return result;
}
