import { requireConfig } from '../config.js';
import { cryptState, readMetaAt } from '../encryption.js';
import { DokuError } from '../errors.js';
import { git, gitInteractive, isRepoRoot, tryGit } from '../git.js';
import { log, pc } from '../log.js';
import { STORAGE_BRANCH } from './init.js';

const REMOTE_REF = `refs/remotes/origin/${STORAGE_BRANCH}`;

function requireStorageRepo(): string {
  const { storagePath } = requireConfig();
  if (!isRepoRoot(storagePath)) {
    throw new DokuError(`Storage ${storagePath} is not its own git repository. Run \`doku init\` to set it up.`);
  }
  return storagePath;
}

/** URL of the storage's `origin`, or null when there is none. */
export function originUrl(storage: string): string | null {
  const res = tryGit(storage, ['remote', 'get-url', 'origin']);
  return res.ok ? res.stdout : null;
}

export function showRemoteCommand(): void {
  const url = originUrl(requireStorageRepo());
  if (url) log.info(url);
  else log.info(pc.dim('No remote. Add one with `doku remote set <url>`.'));
}

/** Add `origin` to the storage, or point it at another URL, then check what the remote holds. */
export function setRemoteCommand(url: string): void {
  const storage = requireStorageRepo();
  url = url.trim();
  if (!url) throw new DokuError('Give the URL of the remote repository.');

  const previous = originUrl(storage);
  if (previous === url) {
    log.ok(`The storage's remote is already ${url}`);
    return;
  }
  // Removing drops the old remote's tracking refs and upstream, so nothing stale points at the new one.
  if (previous) git(storage, ['remote', 'remove', 'origin']);
  git(storage, ['remote', 'add', 'origin', url]);
  log.ok(previous ? `Remote changed from ${previous} to ${url}` : `Remote set to ${url}`);

  log.step('git fetch origin');
  if (!gitInteractive(storage, ['fetch', '-q', 'origin'])) {
    log.warn('Could not fetch from the remote (see output above). Check the URL and your access, then run `doku sync`.');
    return;
  }
  if (!tryGit(storage, ['rev-parse', '-q', '--verify', REMOTE_REF]).ok) {
    if (cryptState(storage) === 'off') {
      log.info(pc.dim('  Keep the repository private, or run `doku encrypt` before the first sync to encrypt it.'));
    }
    log.info('The remote is empty. `doku sync` pushes the storage to it.');
    return;
  }

  if (!tryGit(storage, ['rev-parse', '-q', '--verify', 'HEAD']).ok) {
    log.warn(
      'The remote already holds a storage, and this one has no commits yet. To use the remote one, run\n' +
        `  doku init --storage <empty folder> --clone ${url}`,
    );
    return;
  }
  git(storage, ['branch', '-q', '--set-upstream-to', `origin/${STORAGE_BRANCH}`]);
  if (!tryGit(storage, ['merge-base', 'HEAD', REMOTE_REF]).ok) {
    if (readMetaAt(storage, REMOTE_REF) && cryptState(storage) !== 'unlocked') {
      log.warn('The remote holds this storage encrypted on another machine. Run `doku unlock` to switch this machine over.');
      return;
    }
    log.warn(
      'The remote holds a different storage (unrelated history), so `doku sync` will not push to it. ' +
        'Use an empty repository, or clone the remote one with `doku init --storage <empty folder> --clone <url>`.',
    );
    return;
  }
  log.info('`doku sync` now pulls from and pushes to it.');
}

export function removeRemoteCommand(): void {
  const storage = requireStorageRepo();
  const previous = originUrl(storage);
  if (!previous) {
    log.warn('The storage has no remote.');
    return;
  }
  git(storage, ['remote', 'remove', 'origin']);
  log.ok(`Removed the remote ${previous}. \`doku sync\` now only commits locally.`);
}
