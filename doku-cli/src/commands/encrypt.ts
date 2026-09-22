import fs from 'node:fs';
import path from 'node:path';
import { dokuHome, requireConfig } from '../config.js';
import {
  CIPHER,
  decrypt,
  formatRecoveryKey,
  generateKey,
  isEncrypted,
  keyIdHex,
  MIN_PASSPHRASE,
  wrapKey,
  type StorageKey,
} from '../crypto.js';
import { applyIgnoresToGit } from '../dokuignore.js';
import {
  askForKey,
  CRYPT_FILE,
  cryptMeta,
  cryptState,
  gitDir,
  installFilters,
  keyFromFile,
  plaintextObjects,
  purgeHistory,
  readKey,
  readMetaAt,
  readObjects,
  removeFilters,
  removeLocalCrypt,
  requireKey,
  saveKey,
  writeLocalState,
  writeMeta,
  type CryptMeta,
  type KeyTarget,
} from '../encryption.js';
import { DokuError } from '../errors.js';
import { git, gitInteractive, isRepoRoot, tryGit } from '../git.js';
import { log, pc } from '../log.js';
import { askSecret, confirm, type Prompter, stdinPrompter } from '../prompt.js';
import { STORAGE_BRANCH } from './init.js';

const MAIN_REF = `refs/heads/${STORAGE_BRANCH}`;
const REMOTE_REF = `refs/remotes/origin/${STORAGE_BRANCH}`;

function requireRepo(storage: string): void {
  if (!isRepoRoot(storage)) {
    throw new DokuError(`Storage ${storage} is not its own git repository. Run \`doku init\` to set it up.`);
  }
  const dir = gitDir(storage);
  if (fs.existsSync(path.join(dir, 'rebase-merge')) || fs.existsSync(path.join(dir, 'rebase-apply'))) {
    throw new DokuError(`A rebase is in progress in ${storage}. Resolve it (git rebase --continue / --abort) first.`);
  }
}

function hasOrigin(storage: string): boolean {
  return git(storage, ['remote']).split('\n').includes('origin');
}

function fetchOrigin(storage: string): void {
  log.step('git fetch origin');
  if (!gitInteractive(storage, ['fetch', '-q', 'origin'])) throw new DokuError('git fetch failed (see output above).');
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function backupDir(storage: string, what: string): string {
  return path.join(dokuHome(), 'backups', `${path.basename(storage)}-${what}-${stamp()}`);
}

/** Uses the prompter given in options, or stdin (closed afterwards). */
async function withPrompter<T>(opts: { prompter?: Prompter }, fn: (p: Prompter) => Promise<T>): Promise<T> {
  const p = opts.prompter ?? stdinPrompter();
  try {
    return await fn(p);
  } finally {
    if (!opts.prompter) p.close();
  }
}

/** A new passphrase, typed twice. Null when the user gives up. */
async function askNewPassphrase(p: Prompter): Promise<string | null> {
  for (;;) {
    const first = await askSecret(p, `New passphrase (at least ${MIN_PASSPHRASE} characters, Enter to cancel): `);
    if (first === null || first === '') return null;
    if ([...first].length < MIN_PASSPHRASE) {
      log.warn(`Too short. Use at least ${MIN_PASSPHRASE} characters; a few random words work well.`);
      continue;
    }
    const again = await askSecret(p, 'Type it again: ');
    if (again === null) return null;
    if (again === first) return first;
    log.warn('The two passphrases differ. Try again.');
  }
}

function showRecoveryKey(recovery: string, passphrase: boolean): void {
  log.info('');
  log.info(pc.bold('  Your recovery key:'));
  log.info('');
  log.info(`      ${pc.bold(pc.cyan(recovery))}`);
  log.info('');
  log.warn(pc.bold('Save it now, in at least two safe places (a password manager, a printed copy).'));
  log.info(`  Other machines need it${passphrase ? ' (or the passphrase)' : ''} to read the synced docs and encrypted zips.`);
  log.info('  doku never puts it in the repository or sends it anywhere.');
  log.info('  If you lose it and every machine where the storage is unlocked, nobody can read the');
  log.info('  encrypted copies again, not even you. Your files stay readable on unlocked machines,');
  log.info('  and `doku key` shows the key again there.');
  log.info('');
}

async function confirmSaved(p: Prompter, recovery: string): Promise<boolean> {
  const last = recovery.split('-').pop()!;
  for (let attempt = 0; attempt < 3; attempt++) {
    const answer = await p.ask(`To confirm you saved it, type the last group of the key (…-${'?'.repeat(last.length)}): `);
    if (answer === null || !answer.trim()) return false;
    if (answer.trim().toUpperCase() === last) return true;
    log.warn('That does not match the end of the key.');
  }
  return false;
}

export interface EncryptOptions {
  /** true: also set a passphrase; false: recovery key only; undefined: ask. */
  passphrase?: boolean;
  /** Also write the recovery key to this file. */
  keyFile?: string;
  /** Keep the old, unencrypted history as a git bundle in ~/.doku/backups/. */
  backupHistory?: boolean;
  /** Don't ask for the go-ahead. With --key-file, also skip confirming the key was saved. */
  yes?: boolean;
  cwd?: string;
  prompter?: Prompter;
}

export interface EncryptResult {
  recoveryKey: string;
  replacesRemote: boolean;
  historyBackup?: string;
}

/**
 * Turn encryption on for the whole storage. The history so far (plaintext) is replaced by
 * one encrypted commit and purged from .git; a remote that already has it is replaced on
 * the next `doku sync`. Returns null when cancelled; nothing is changed then.
 */
export async function encryptCommand(opts: EncryptOptions = {}): Promise<EncryptResult | null> {
  const { storagePath: storage } = requireConfig();
  requireRepo(storage);
  const state = cryptState(storage);
  if (state === 'unlocked') throw new DokuError('The storage is already encrypted. `doku status` shows it, `doku key` shows the recovery key.');
  if (state === 'locked') throw new DokuError('The storage is already encrypted, but locked on this machine. Run `doku unlock`.');
  const keyOut = opts.keyFile ? path.resolve(opts.cwd ?? process.cwd(), opts.keyFile) : undefined;
  if (keyOut && fs.existsSync(keyOut)) throw new DokuError(`${keyOut} already exists; pick another file for the recovery key.`);

  return withPrompter(opts, async (p) => {
    // Nothing from other machines may get lost, and we need to know whether the remote already has plaintext.
    let remoteHead: string | undefined;
    if (hasOrigin(storage)) {
      fetchOrigin(storage);
      const r = tryGit(storage, ['rev-parse', '-q', '--verify', REMOTE_REF]);
      if (r.ok) {
        remoteHead = r.stdout;
        if (!tryGit(storage, ['merge-base', '--is-ancestor', remoteHead, 'HEAD']).ok) {
          throw new DokuError('The remote has changes this machine does not have yet. Run `doku sync` first, then `doku encrypt`.');
        }
      }
    }
    const count = tryGit(storage, ['rev-list', '--count', 'HEAD']);
    const commits = count.ok ? Number(count.stdout) : 0;

    log.info(pc.bold(`Encrypting the storage ${storage}`));
    log.info(`  • Files in this folder (and in every linked .doku/) stay plain and editable as before.`);
    log.info(`  • Git stores them encrypted (${CIPHER}): every commit, every push, every \`doku zip\`.`);
    log.info('    File and folder names stay readable on the remote; their contents do not.');
    if (commits) {
      log.info(`  • The ${commits} existing commit(s) hold unencrypted files, so the history is replaced by one`);
      log.info('    encrypted commit and the old history is deleted from this repository.');
    }
    if (remoteHead) {
      log.warn('The remote already holds the unencrypted history. The next `doku sync` replaces it (force push).');
      log.info('  Hosts like GitHub can keep deleted commits cached for a while, and forks or other clones keep');
      log.info('  theirs. The safest option is a new, empty repository: `doku remote set <new-url>` now.');
      log.info('  Other machines then run `doku unlock` once to switch to the encrypted history.');
    }
    if (!opts.yes && !(await confirm(p, 'Encrypt the storage?'))) {
      log.warn('Cancelled; nothing changed.');
      return null;
    }

    const wantsPassphrase =
      opts.passphrase ?? (await confirm(p, 'Also allow unlocking with a passphrase, in addition to the recovery key?'));
    let passphrase: string | undefined;
    if (wantsPassphrase) {
      log.info(pc.dim('  The passphrase-protected key is stored in the repository, so pick a long one: anyone with'));
      log.info(pc.dim('  access to the repository can try to guess it offline.'));
      passphrase = (await askNewPassphrase(p)) ?? undefined;
      if (!passphrase) {
        log.warn('Cancelled; nothing changed.');
        return null;
      }
    }

    const key = generateKey();
    const recovery = formatRecoveryKey(key);
    showRecoveryKey(recovery, !!passphrase);
    if (keyOut) {
      fs.mkdirSync(path.dirname(keyOut), { recursive: true });
      fs.writeFileSync(keyOut, `doku recovery key for ${storage}\n${recovery}\n`, { flag: 'wx', mode: 0o600 });
      log.ok(`Recovery key also written to ${keyOut}. Move it somewhere safe, off this machine.`);
    }
    if (!(opts.yes && keyOut) && !(await confirmSaved(p, recovery))) {
      log.warn('Cancelled; nothing changed. Run `doku encrypt` again when you are ready to save the key.');
      return null;
    }

    let historyBackup: string | undefined;
    if (opts.backupHistory && commits) {
      historyBackup = `${backupDir(storage, 'unencrypted-history')}.bundle`;
      fs.mkdirSync(path.dirname(historyBackup), { recursive: true });
      git(storage, ['bundle', 'create', '-q', historyBackup, '--all']);
      log.ok(`Old history saved to ${historyBackup} (unencrypted, outside the storage)`);
    }

    const meta: CryptMeta = {
      doku: 1,
      cipher: CIPHER,
      keyId: keyIdHex(key),
      passphrase: passphrase ? wrapKey(key, passphrase) : undefined,
      created: new Date().toISOString(),
    };
    saveKey(storage, key);
    writeMeta(storage, meta);
    installFilters(storage);
    applyIgnoresToGit(storage);
    git(storage, ['add', '--renormalize', '.']);
    git(storage, ['add', '-A']);
    const tree = git(storage, ['write-tree']);
    const commit = git(storage, ['commit-tree', tree, '-m', 'doku: storage encrypted']);
    git(storage, ['update-ref', MAIN_REF, commit]);
    git(storage, ['symbolic-ref', 'HEAD', MAIN_REF]);
    purgeHistory(storage, [MAIN_REF]);

    const leaks = plaintextObjects(storage);
    if (leaks.length) {
      throw new DokuError(`${leaks.length} unencrypted object(s) are still in the repository. Do not push; please report this.`);
    }
    if (remoteHead) writeLocalState(storage, { replaceRemote: remoteHead });

    log.ok('Storage encrypted.');
    log.info(
      hasOrigin(storage)
        ? '  Run `doku sync` to push it. On other machines: `doku init --clone <url>` (asks for the key), or `doku unlock` in an existing clone.'
        : '  Add a remote with `doku remote set <url>` and run `doku sync` to push it; `doku init --clone <url>` on other machines asks for the key.',
    );
    return { recoveryKey: recovery, replacesRemote: !!remoteHead, historyBackup };
  });
}

export interface UnlockOptions {
  keyFile?: string;
  cwd?: string;
  prompter?: Prompter;
}

/** Decrypt the files of a locked clone: drop the index so a hard reset checks everything out through the filter. */
function decryptWorkingTree(storage: string): void {
  fs.rmSync(path.join(gitDir(storage), 'index'), { force: true });
  git(storage, ['reset', '-q', '--hard', 'HEAD']);
}

/** Files of a commit's tree, decrypted. */
function treeFiles(storage: string, rev: string, key: StorageKey): Map<string, Buffer> {
  const entries = git(storage, ['ls-tree', '-r', '-z', rev])
    .split('\0')
    .filter(Boolean)
    .map((e) => {
      const [info, rel] = e.split('\t');
      const [, type, id] = info.split(' ');
      return { type, id, rel };
    })
    .filter((e) => e.type === 'blob');
  const objects = readObjects(storage, entries.map((e) => e.id));
  const files = new Map<string, Buffer>();
  for (const e of entries) {
    const data = objects.get(e.id)?.data ?? Buffer.alloc(0);
    files.set(e.rel, isEncrypted(data) ? decrypt(key, data) : Buffer.from(data));
  }
  return files;
}

/**
 * This machine still has the old, unencrypted history while the remote was encrypted
 * elsewhere: back up what only this machine has, switch to the remote's history, put
 * local-only files back (they get synced encrypted), and purge the old history.
 */
function switchToEncryptedRemote(storage: string, key: StorageKey): void {
  const remote = treeFiles(storage, REMOTE_REF, key);
  const local = git(storage, ['ls-files', '-z', '-c', '-o', '--exclude-standard'])
    .split('\0')
    .filter((rel) => rel && rel !== CRYPT_FILE);
  const localOnly: string[] = [];
  const differs: string[] = [];
  for (const rel of new Set(local)) {
    const abs = path.join(storage, ...rel.split('/'));
    let data: Buffer;
    try {
      if (!fs.lstatSync(abs).isFile()) continue;
      data = fs.readFileSync(abs);
    } catch {
      continue; // deleted locally
    }
    const theirs = remote.get(rel);
    if (!theirs) localOnly.push(rel);
    else if (!theirs.equals(data)) differs.push(rel);
  }

  let backup: string | undefined;
  if (localOnly.length || differs.length) {
    backup = backupDir(storage, 'before-unlock');
    for (const rel of [...localOnly, ...differs]) {
      const dest = path.join(backup, ...rel.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(storage, ...rel.split('/')), dest);
    }
  }

  saveKey(storage, key);
  installFilters(storage);
  git(storage, ['symbolic-ref', 'HEAD', MAIN_REF]);
  git(storage, ['reset', '-q', '--hard', REMOTE_REF]);
  for (const rel of localOnly) {
    const dest = path.join(storage, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(backup!, ...rel.split('/')), dest);
  }
  tryGit(storage, ['branch', '-q', `--set-upstream-to=origin/${STORAGE_BRANCH}`, STORAGE_BRANCH]);
  purgeHistory(storage, [MAIN_REF, REMOTE_REF]);
  writeLocalState(storage, {});

  log.ok('Switched to the encrypted storage from the remote; the old unencrypted history was removed from this machine.');
  if (localOnly.length) log.info(`  Kept ${localOnly.length} file(s) the remote doesn't have; the next \`doku sync\` adds them encrypted.`);
  if (differs.length) {
    log.warn(`${differs.length} file(s) differed from the remote; the remote's version is used:`);
    log.info(differs.slice(0, 10).map((r) => `    ${r}`).join('\n') + (differs.length > 10 ? pc.dim(`\n    … and ${differs.length - 10} more`) : ''));
    log.info(`  This machine's versions are in ${backup}. Copy back what you want to keep.`);
  }
}

/**
 * Give this machine the key of an encrypted storage: after `doku init --clone`, or in an
 * old clone whose remote was encrypted on another machine. Returns false when no key was given.
 */
export async function unlockCommand(opts: UnlockOptions = {}): Promise<boolean> {
  const { storagePath: storage } = requireConfig();
  requireRepo(storage);
  const state = cryptState(storage);
  if (state === 'unlocked') {
    log.ok('The storage is already unlocked on this machine.');
    return true;
  }

  let meta: CryptMeta | null;
  let switching = false;
  if (state === 'locked') {
    meta = cryptMeta(storage);
    const changed = git(storage, ['status', '--porcelain', '--untracked-files=no']);
    if (changed) {
      throw new DokuError(
        `These encrypted files were changed on this machine while locked:\n${changed}\n` +
          'Undo that with `git checkout -- .` in the storage (new files are kept), then run `doku unlock` again.',
      );
    }
  } else {
    meta = null;
    if (hasOrigin(storage)) {
      fetchOrigin(storage);
      meta = readMetaAt(storage, REMOTE_REF);
    }
    if (!meta) throw new DokuError('The storage is not encrypted, so there is nothing to unlock. `doku encrypt` turns encryption on.');
    switching = true;
    log.info('The storage was encrypted on another machine; this machine still has the old, unencrypted history.');
  }

  const target: KeyTarget = meta!;
  const key = await withPrompter(opts, async (p) => {
    if (opts.keyFile) return keyFromFile(path.resolve(opts.cwd ?? process.cwd(), opts.keyFile), target);
    log.info(`Enter the recovery key${target.passphrase ? ' or the passphrase' : ''} of this storage.`);
    return askForKey(p, target);
  });
  if (!key) {
    log.warn('No key given; the storage stays locked. Run `doku unlock` when you have the recovery key or passphrase.');
    return false;
  }

  if (switching) {
    switchToEncryptedRemote(storage, key);
  } else {
    saveKey(storage, key);
    installFilters(storage);
    decryptWorkingTree(storage);
    log.ok('Unlocked: the files in the storage are decrypted on this machine.');
  }
  return true;
}

export interface KeyOptions {
  /** true: set or change the passphrase; false: remove it; undefined: show the recovery key. */
  passphrase?: boolean;
  prompter?: Prompter;
}

export async function keyCommand(opts: KeyOptions = {}): Promise<string | null> {
  const { storagePath: storage } = requireConfig();
  requireRepo(storage);
  const key = requireKey(storage);
  const meta = cryptMeta(storage)!;
  return withPrompter(opts, async (p) => {
    if (opts.passphrase === undefined) {
      if (!(await confirm(p, 'Show the recovery key on screen?'))) return null;
      const recovery = formatRecoveryKey(key);
      showRecoveryKey(recovery, !!meta.passphrase);
      return recovery;
    }
    if (opts.passphrase === false) {
      if (!meta.passphrase) {
        log.info('No passphrase is set up; the recovery key is the only way to unlock.');
        return null;
      }
      writeMeta(storage, { ...meta, passphrase: undefined });
      log.ok('Passphrase removed. From the next `doku sync` on, only the recovery key unlocks the storage.');
      log.info('  Zips made earlier and older commits still accept the old passphrase.');
      return null;
    }
    const passphrase = await askNewPassphrase(p);
    if (!passphrase) {
      log.warn('Cancelled; nothing changed.');
      return null;
    }
    writeMeta(storage, { ...meta, passphrase: wrapKey(key, passphrase) });
    log.ok(`Passphrase ${meta.passphrase ? 'changed' : 'set'}. Run \`doku sync\` to share it with other machines.`);
    if (meta.passphrase) log.info('  Zips made earlier and older commits still accept the old passphrase.');
    return null;
  });
}

/** Store the key outside the storage, where old encrypted commits and zips can still be opened with it. */
function retireKey(storage: string, key: StorageKey): string {
  const file = `${backupDir(storage, 'key')}.txt`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `doku recovery key of ${storage} (encryption turned off)\n${formatRecoveryKey(key)}\n`, { mode: 0o600 });
  removeLocalCrypt(storage);
  return file;
}

/** After another machine turned encryption off: remove the filter here and re-add the files unencrypted. */
export function disableLocally(storage: string): void {
  const key = readKey(storage);
  removeFilters(storage);
  if (!key) {
    removeLocalCrypt(storage);
    return;
  }
  const file = retireKey(storage, key);
  git(storage, ['add', '--renormalize', '.']);
  log.info(`Encryption was turned off on another machine; turned it off here too. The old key is in ${file}.`);
}

export interface DecryptOptions {
  prompter?: Prompter;
}

/**
 * Turn encryption off. Needs an unlocked machine, but not the key: this machine already
 * has it and every file in plaintext. The next sync pushes all files unencrypted.
 */
export async function decryptCommand(opts: DecryptOptions = {}): Promise<boolean> {
  const { storagePath: storage } = requireConfig();
  requireRepo(storage);
  const key = requireKey(storage);
  return withPrompter(opts, async (p) => {
    log.warn(pc.bold('This turns encryption off for the whole storage.'));
    log.info('  The next `doku sync` pushes every file unencrypted, and zips are no longer encrypted.');
    log.info('  Earlier commits stay encrypted; the key is kept in ~/.doku/backups so they can still be read.');
    const answer = await p.ask('Type "decrypt" to confirm: ');
    if (answer?.trim().toLowerCase() !== 'decrypt') {
      log.warn('Cancelled; nothing changed.');
      return false;
    }
    removeFilters(storage);
    fs.rmSync(path.join(storage, CRYPT_FILE), { force: true });
    const file = retireKey(storage, key);
    applyIgnoresToGit(storage);
    git(storage, ['add', '-A']);
    git(storage, ['add', '--renormalize', '.']);
    git(storage, ['commit', '-q', '-m', 'doku: encryption turned off']);
    log.ok('Encryption turned off. Run `doku sync` to push the files unencrypted.');
    log.info(`  The old key is in ${file}.`);
    return true;
  });
}
