import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatRecoveryKey,
  isEncrypted,
  keyIdHex,
  looksLikeRecoveryKey,
  parseRecoveryKey,
  unwrapKey,
  type PassphraseWrap,
  type StorageKey,
} from './crypto.js';
import { DokuError } from './errors.js';
import { git, tryGit } from './git.js';
import { log } from './log.js';
import { readFileOr, removeBlock, upsertBlock } from './managedBlock.js';
import { askSecret, type Prompter } from './prompt.js';

/**
 * An encrypted storage keeps plain files in its folder (what `.doku/` links point to),
 * while git stores only ciphertext: a clean filter encrypts on `git add`, a smudge
 * filter decrypts on checkout. The key stays on each machine, in the storage's .git.
 */

/** Synced marker that the storage is encrypted, with the key id and the optional passphrase wrap. Never holds the key. */
export const CRYPT_FILE = '.doku-crypt.json';

export interface CryptMeta {
  doku: 1;
  cipher: string;
  /** Hex id of the storage key, to recognise the right key. */
  keyId: string;
  passphrase?: PassphraseWrap;
  created: string;
}

/** `locked`: encrypted, but this machine has no key, so its files are still ciphertext. */
export type CryptState = 'off' | 'locked' | 'unlocked';

export function gitDir(storage: string): string {
  return path.resolve(storage, git(storage, ['rev-parse', '--git-dir']));
}

function dokuDir(storage: string): string {
  return path.join(gitDir(storage), 'doku');
}

function keyFile(storage: string): string {
  return path.join(dokuDir(storage), 'key');
}

function parseMeta(text: string, where: string): CryptMeta {
  try {
    const meta = JSON.parse(text) as CryptMeta;
    if (meta && meta.doku === 1 && typeof meta.keyId === 'string') return meta;
  } catch {
    // reported below
  }
  throw new DokuError(`${where} is not valid doku encryption metadata.`);
}

/** Metadata in the storage folder. */
export function readMeta(storage: string): CryptMeta | null {
  const text = readFileOr(path.join(storage, CRYPT_FILE), '');
  return text ? parseMeta(text, path.join(storage, CRYPT_FILE)) : null;
}

/** Metadata as committed in `rev` (e.g. `HEAD`, `refs/remotes/origin/main`). */
export function readMetaAt(storage: string, rev: string): CryptMeta | null {
  const res = tryGit(storage, ['show', `${rev}:${CRYPT_FILE}`]);
  return res.ok && res.stdout ? parseMeta(res.stdout, `${CRYPT_FILE} in ${rev}`) : null;
}

/** The storage's metadata; also when the file was deleted from the folder but is still committed. */
export function cryptMeta(storage: string): CryptMeta | null {
  return readMeta(storage) ?? readMetaAt(storage, 'HEAD');
}

export function writeMeta(storage: string, meta: CryptMeta): void {
  const clean = { ...meta, passphrase: meta.passphrase ?? undefined };
  fs.writeFileSync(path.join(storage, CRYPT_FILE), JSON.stringify(clean, null, 2) + '\n');
}

/** The key saved on this machine, or null. */
export function readKey(storage: string): StorageKey | null {
  const text = readFileOr(keyFile(storage), '');
  return text.trim() ? parseRecoveryKey(text) : null;
}

export function saveKey(storage: string, key: StorageKey): void {
  fs.mkdirSync(dokuDir(storage), { recursive: true });
  fs.writeFileSync(keyFile(storage), formatRecoveryKey(key) + '\n', { mode: 0o600 });
}

/** Forget the key and local encryption state. */
export function removeLocalCrypt(storage: string): void {
  fs.rmSync(dokuDir(storage), { recursive: true, force: true });
}

export function cryptState(storage: string): CryptState {
  const meta = cryptMeta(storage);
  if (!meta) return 'off';
  const key = readKey(storage);
  return key && keyIdHex(key) === meta.keyId ? 'unlocked' : 'locked';
}

export const LOCKED_HINT =
  'The storage is encrypted, and locked on this machine: its files are still encrypted here. Run `doku unlock` first.';

/** The key of an unlocked storage; throws for off or locked ones. */
export function requireKey(storage: string): StorageKey {
  const state = cryptState(storage);
  if (state === 'off') throw new DokuError('The storage is not encrypted. Turn encryption on with `doku encrypt`.');
  if (state === 'locked') throw new DokuError(LOCKED_HINT);
  return readKey(storage)!;
}

// Local-only state, e.g. a remote whose unencrypted history the next sync replaces.

export interface LocalState {
  /** Remote commit (still unencrypted) that the next `doku sync` force-pushes over. */
  replaceRemote?: string;
}

function stateFile(storage: string): string {
  return path.join(dokuDir(storage), 'state.json');
}

export function readLocalState(storage: string): LocalState {
  const text = readFileOr(stateFile(storage), '');
  return text ? (JSON.parse(text) as LocalState) : {};
}

export function writeLocalState(storage: string, state: LocalState): void {
  if (!Object.values(state).some((v) => v !== undefined)) {
    fs.rmSync(stateFile(storage), { force: true });
    return;
  }
  fs.mkdirSync(dokuDir(storage), { recursive: true });
  fs.writeFileSync(stateFile(storage), JSON.stringify(state, null, 2) + '\n');
}

// Git filter setup. It lives in .git/config and .git/info/attributes, so it never syncs
// and a `.gitattributes` inside the docs can't switch it off (info/attributes wins).

/** The built CLI, which git runs as the filter. DOKU_CLI_ENTRY overrides it (tests). */
function cliEntry(): string {
  return process.env.DOKU_CLI_ENTRY ?? fileURLToPath(new URL('../dist/cli.js', import.meta.url));
}

/** Git runs filter commands through a shell (sh, also on Windows). */
function shellQuote(p: string): string {
  return `"${p.replace(/\\/g, '/').replace(/(["$`])/g, '\\$1')}"`;
}

function dokuCommand(...args: string[]): string {
  return [shellQuote(process.execPath), shellQuote(cliEntry()), ...args].join(' ');
}

function filterConfig(): [string, string][] {
  return [
    ['filter.doku.process', dokuCommand('filter-process')],
    ['filter.doku.required', 'true'],
    ['diff.doku.textconv', dokuCommand('textconv')],
    ['merge.doku.name', 'doku: merge encrypted files'],
    ['merge.doku.driver', dokuCommand('merge-driver', '%O', '%A', '%B', '%L')],
  ];
}

const ATTR_MARKERS = { start: '# doku:start', end: '# doku:end' };

const ATTRIBUTES = [
  '# encrypted storage: git keeps only ciphertext (see `doku status`)',
  '* filter=doku diff=doku merge=doku -text',
  '.gitattributes !filter !diff !merge !text',
  `/${CRYPT_FILE} !filter !diff !merge !text`,
].join('\n');

function attributesFile(storage: string): string {
  return path.resolve(storage, git(storage, ['rev-parse', '--git-path', 'info/attributes']));
}

/** Files that stay plaintext in git: the metadata, and .gitattributes git itself reads. */
export function isExempt(rel: string): boolean {
  return rel === CRYPT_FILE || rel === '.gitattributes' || rel.endsWith('/.gitattributes');
}

export function installFilters(storage: string): void {
  for (const [k, v] of filterConfig()) git(storage, ['config', k, v]);
  const file = attributesFile(storage);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, upsertBlock(readFileOr(file), ATTR_MARKERS, ATTRIBUTES));
}

/** True when git is set up to run this doku as the filter. */
export function filtersInstalled(storage: string): boolean {
  const configured = filterConfig().every(([k, v]) => tryGit(storage, ['config', '--get', k]).stdout === v);
  return configured && readFileOr(attributesFile(storage)).includes(ATTRIBUTES);
}

export function removeFilters(storage: string): void {
  for (const section of ['filter.doku', 'diff.doku', 'merge.doku']) tryGit(storage, ['config', '--remove-section', section]);
  const file = attributesFile(storage);
  const text = removeBlock(readFileOr(file), ATTR_MARKERS);
  if (text.trim()) fs.writeFileSync(file, text);
  else fs.rmSync(file, { force: true });
}

// Reading many objects at once.

interface GitObject {
  type: string;
  data: Buffer;
}

/** Contents of objects by id, through one `git cat-file --batch`. */
export function readObjects(storage: string, ids: string[]): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  if (!ids.length) return out;
  const res = spawnSync('git', ['-C', storage, 'cat-file', '--batch'], { input: ids.join('\n') + '\n', maxBuffer: 1024 ** 3 });
  if (res.error) throw new DokuError(`Cannot run git: ${res.error.message}`);
  const buf = res.stdout;
  let pos = 0;
  for (const id of ids) {
    const eol = buf.indexOf(10, pos);
    const [, type, size] = buf.subarray(pos, eol).toString('utf8').split(' ');
    pos = eol + 1;
    if (type === 'missing' || size === undefined) continue;
    out.set(id, { type, data: buf.subarray(pos, pos + Number(size)) });
    pos += Number(size) + 1;
  }
  return out;
}

/**
 * Paths of plaintext blobs reachable from `revs` (rev-list syntax, e.g. `@{u}..HEAD`)
 * that should have been encrypted. Empty means safe to push.
 */
export function plaintextBlobs(storage: string, revs: string[]): string[] {
  const listed = git(storage, ['rev-list', '--objects', ...revs]);
  const byId = new Map<string, string>();
  for (const line of listed.split('\n')) {
    const space = line.indexOf(' ');
    if (space === -1) continue;
    const rel = line.slice(space + 1);
    if (!isExempt(rel)) byId.set(line.slice(0, space), rel);
  }
  const objects = readObjects(storage, [...byId.keys()]);
  const bad: string[] = [];
  for (const [id, rel] of byId) {
    const o = objects.get(id);
    if (o?.type === 'blob' && o.data.length > 0 && !isEncrypted(o.data)) bad.push(rel);
  }
  return bad.sort();
}

/** Every blob anywhere in the object database, reachable or not, that is plaintext (except the metadata). */
export function plaintextObjects(storage: string): string[] {
  const listed = git(storage, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)']);
  const blobs = listed
    .split('\n')
    .map((l) => l.split(' '))
    .filter(([, type]) => type === 'blob')
    .map(([id]) => id);
  const metaIds = new Set(
    tryGit(storage, ['rev-list', '--objects', '--all'])
      .stdout.split('\n')
      .filter((l) => l.endsWith(` ${CRYPT_FILE}`) || l.endsWith('.gitattributes'))
      .map((l) => l.split(' ')[0]),
  );
  const objects = readObjects(storage, blobs.filter((id) => !metaIds.has(id)));
  return [...objects].filter(([, o]) => o.data.length > 0 && !isEncrypted(o.data)).map(([id]) => id);
}

/**
 * Delete every ref except `keep`, plus reflogs and leftover heads, then drop all
 * unreachable objects: the history they held is gone from this repository.
 */
export function purgeHistory(storage: string, keep: string[]): void {
  const refs = git(storage, ['for-each-ref', '--format=%(refname)']).split('\n').filter(Boolean);
  for (const ref of refs) if (!keep.includes(ref)) git(storage, ['update-ref', '-d', ref]);
  const dir = gitDir(storage);
  for (const f of ['ORIG_HEAD', 'FETCH_HEAD', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'AUTO_MERGE']) {
    fs.rmSync(path.join(dir, f), { force: true });
  }
  git(storage, ['reflog', 'expire', '--expire=now', '--all']);
  git(storage, ['-c', 'gc.cruftPacks=false', 'gc', '-q', '--prune=now']);
}

// Asking for the key.

export interface KeyTarget {
  keyId: string;
  passphrase?: PassphraseWrap;
}

/** Turn a recovery key or passphrase into the key for `target`; throws when it doesn't fit. */
export function keyFromInput(input: string, target: KeyTarget): StorageKey {
  const text = input.replace(/\r?\n$/, '');
  if (looksLikeRecoveryKey(text)) {
    const key = parseRecoveryKey(text);
    if (keyIdHex(key) !== target.keyId) throw new DokuError('That recovery key belongs to a different storage.');
    return key;
  }
  if (!target.passphrase) throw new DokuError('That is not a recovery key (those start with DOKU1-), and no passphrase is set up.');
  const key = unwrapKey(target.passphrase, text);
  if (!key) throw new DokuError('Wrong passphrase.');
  if (keyIdHex(key) !== target.keyId) throw new DokuError('That passphrase unlocks a different key.');
  return key;
}

export function keyFromFile(file: string, target: KeyTarget): StorageKey {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new DokuError(`Cannot read the key file ${file}: ${(err as Error).message}`);
  }
  const line = text.split(/\r?\n/).find((l) => looksLikeRecoveryKey(l));
  return keyFromInput(line ?? text.trim(), target);
}

/** Ask until the recovery key or passphrase fits. Null when the user presses Enter or input ends. */
export async function askForKey(p: Prompter, target: KeyTarget, enterMeans = 'skip'): Promise<StorageKey | null> {
  const question = `${target.passphrase ? 'Recovery key or passphrase' : 'Recovery key'} (Enter to ${enterMeans}): `;
  for (let attempt = 0; attempt < 5; attempt++) {
    const answer = await askSecret(p, question);
    if (answer === null || !answer.trim()) return null;
    try {
      return keyFromInput(answer, target);
    } catch (err) {
      if (!(err instanceof DokuError)) throw err;
      log.warn(err.message);
    }
  }
  return null;
}
