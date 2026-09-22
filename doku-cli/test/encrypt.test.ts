import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { decryptCommand, encryptCommand, keyCommand, unlockCommand } from '../src/commands/encrypt.js';
import { initCommand } from '../src/commands/init.js';
import { loadCommand } from '../src/commands/load.js';
import { zipCommand } from '../src/commands/zip.js';
import { isEncrypted, MAGIC } from '../src/crypto.js';
import {
  CRYPT_FILE,
  cryptState,
  installFilters,
  plaintextBlobs,
  plaintextObjects,
  readLocalState,
  removeFilters,
} from '../src/encryption.js';
import { tryGit } from '../src/git.js';
import type { Prompter } from '../src/prompt.js';
import { syncStorage } from '../src/sync.js';
import { readZip } from '../src/zip.js';
import { gitIn, useSandbox } from './helpers.js';

const CANARY = 'SECRET-CLIENT-CANARY';

/** Answers questions in order. Runs out → behaves like closed stdin. */
function scripted(...answers: string[]): Prompter & { questions: string[] } {
  const questions: string[] = [];
  return {
    questions,
    ask: async (q) => {
      questions.push(q);
      return answers.length ? answers.shift()! : null;
    },
    close: () => {},
  };
}

/** The recovery key most recently printed. */
function printedKey(): string {
  const out = vi.mocked(console.log).mock.calls.map((c) => String(c[0])).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  const keys = out.match(/DOKU1(-[0-9A-Z]{8}){7}/g);
  return keys![keys!.length - 1];
}

function read(...parts: string[]): string {
  return fs.readFileSync(path.join(...parts), 'utf8');
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

describe('encryption', () => {
  const box = useSandbox();

  /** Switch "machine": each has its own DOKU_HOME (config, links, backups). */
  function machine(name: string): void {
    vi.stubEnv('DOKU_HOME', path.join(box.root, `home-${name}`));
  }

  function bareRemote(): string {
    const remote = path.join(box.root, 'remote.git');
    fs.mkdirSync(remote);
    gitIn(remote, 'init', '-q', '--bare', '-b', 'main');
    return remote;
  }

  /** Machine A: a storage used for a while, with plaintext history. */
  function usedStorage(): void {
    machine('a');
    initCommand({ storage: box.storage });
    for (let i = 1; i <= 3; i++) {
      write(path.join(box.storage, 'proj', 'notes.md'), `${CANARY} v${i}\nline 2\nline 3\nline 4\nline 5\n`);
      syncStorage(box.storage, `sync ${i}`);
    }
  }

  async function encryptA(extra: Parameters<typeof encryptCommand>[0] = {}) {
    const keyFile = path.join(box.root, 'recovery.txt');
    const result = await encryptCommand({ yes: true, keyFile, passphrase: false, prompter: scripted(), ...extra });
    return { ...result!, keyFile };
  }

  it('encrypts an existing storage: one encrypted commit, no plaintext left in .git, files stay plain', async () => {
    usedStorage();
    const { recoveryKey } = await encryptA();

    expect(recoveryKey).toMatch(/^DOKU1-/);
    expect(read(box.root, 'recovery.txt')).toContain(recoveryKey);
    expect(cryptState(box.storage)).toBe('unlocked');
    expect(gitIn(box.storage, 'log', '--format=%s')).toBe('doku: storage encrypted');
    expect(plaintextObjects(box.storage)).toEqual([]);
    expect(read(box.storage, 'proj', 'notes.md')).toContain(`${CANARY} v3`);
    expect(gitIn(box.storage, 'status', '--porcelain')).toBe('');
    // The committed blob is ciphertext; the metadata is not.
    const blob = execBuffer(box.storage, 'cat-file', 'blob', 'HEAD:proj/notes.md');
    expect(blob.subarray(0, MAGIC.length).equals(MAGIC)).toBe(true);
    expect(blob.includes(Buffer.from(CANARY))).toBe(false);
    expect(JSON.parse(gitIn(box.storage, 'show', `HEAD:${CRYPT_FILE}`))).toMatchObject({ doku: 1 });
    // Diffs are readable locally through textconv.
    write(path.join(box.storage, 'proj', 'notes.md'), `${CANARY} v4\n`);
    expect(gitIn(box.storage, 'diff')).toContain(`+${CANARY} v4`);
    await expect(encryptCommand({ yes: true })).rejects.toThrow(/already encrypted/);
  });

  it('asks before encrypting and cancels without the key being confirmed', async () => {
    usedStorage();
    expect(await encryptCommand({ passphrase: false, prompter: scripted('n') })).toBeNull();
    expect(await encryptCommand({ passphrase: false, prompter: scripted('y', 'WRONG') })).toBeNull();
    expect(cryptState(box.storage)).toBe('off');
    expect(gitIn(box.storage, 'rev-list', '--count', 'HEAD')).toBe('3');

    // Confirming with the key's last group goes ahead.
    const p: Prompter = {
      ask: async (q) => (/last group/.test(q) ? printedKey().split('-').pop()! : 'y'),
      close: () => {},
    };
    expect(await encryptCommand({ passphrase: false, prompter: p })).not.toBeNull();
    expect(cryptState(box.storage)).toBe('unlocked');
  });

  it('syncs only ciphertext, and a clone reads it with the key', async () => {
    usedStorage();
    const remote = bareRemote();
    gitIn(box.storage, 'remote', 'add', 'origin', remote);
    const { keyFile } = await encryptA();
    expect(syncStorage(box.storage)).toMatchObject({ pushed: true });
    expect(plaintextBlobs(remote, ['--all'])).toEqual([]);

    // Machine B without the key: locked, files still encrypted, sync and zip refuse.
    machine('b');
    const storageB = path.join(box.root, 'storageB');
    initCommand({ storage: storageB, clone: remote });
    expect(cryptState(storageB)).toBe('locked');
    expect(isEncrypted(fs.readFileSync(path.join(storageB, 'proj', 'notes.md')))).toBe(true);
    expect(() => syncStorage(storageB)).toThrow(/locked on this machine/);
    await expect(zipCommand('proj', { cwd: box.root, silent: true })).rejects.toThrow(/locked/);
    expect(await unlockCommand({ prompter: scripted('') })).toBe(false);

    // With the key: decrypted, and a round trip works.
    expect(await unlockCommand({ keyFile })).toBe(true);
    expect(read(storageB, 'proj', 'notes.md')).toContain(`${CANARY} v3`);
    expect(gitIn(storageB, 'status', '--porcelain')).toBe('');
    write(path.join(storageB, 'proj', 'b.md'), `${CANARY} from B`);
    expect(syncStorage(storageB)).toMatchObject({ committed: true, pushed: true });

    machine('a');
    expect(syncStorage(box.storage)).toMatchObject({ pulled: true });
    expect(read(box.storage, 'proj', 'b.md')).toBe(`${CANARY} from B`);
    expect(plaintextBlobs(remote, ['--all'])).toEqual([]);
  });

  it('unlocks with the passphrase, and `doku key` manages it', async () => {
    usedStorage();
    const remote = bareRemote();
    gitIn(box.storage, 'remote', 'add', 'origin', remote);
    const pass = 'correct horse battery staple';
    await encryptA({ passphrase: true, prompter: scripted('short', pass, pass) });
    syncStorage(box.storage);

    machine('b');
    const storageB = path.join(box.root, 'storageB');
    initCommand({ storage: storageB, clone: remote });
    expect(await unlockCommand({ prompter: scripted('wrong passphrase!!', pass) })).toBe(true);
    expect(read(storageB, 'proj', 'notes.md')).toContain(CANARY);

    machine('a');
    expect(await keyCommand({ prompter: scripted('y') })).toBe(printedKey());
    await keyCommand({ passphrase: false, prompter: scripted() });
    expect(JSON.parse(read(box.storage, CRYPT_FILE)).passphrase).toBeUndefined();
  });

  it('merges concurrent edits of an encrypted file, and conflicts show in plaintext', async () => {
    usedStorage();
    const remote = bareRemote();
    gitIn(box.storage, 'remote', 'add', 'origin', remote);
    const { keyFile } = await encryptA();
    syncStorage(box.storage);
    machine('b');
    const storageB = path.join(box.root, 'storageB');
    initCommand({ storage: storageB, clone: remote });
    await unlockCommand({ keyFile });

    const notes = (s: string) => path.join(s, 'proj', 'notes.md');
    write(notes(storageB), read(notes(storageB)).replace('line 2', 'line 2 from B'));
    syncStorage(storageB);
    machine('a');
    write(notes(box.storage), read(notes(box.storage)).replace('line 5', 'line 5 from A'));
    expect(syncStorage(box.storage)).toMatchObject({ pulled: true, pushed: true });
    expect(read(notes(box.storage))).toMatch(/line 2 from B[\s\S]*line 5 from A/);

    // Same line on both: a conflict, with markers in the decrypted file.
    machine('b');
    syncStorage(storageB);
    write(notes(storageB), read(notes(storageB)).replace('line 3', 'line 3 by B'));
    syncStorage(storageB);
    machine('a');
    write(notes(box.storage), read(notes(box.storage)).replace('line 3', 'line 3 by A'));
    expect(() => syncStorage(box.storage)).toThrow(/conflict/);
    const conflicted = read(notes(box.storage));
    expect(conflicted).toContain('<<<<<<<');
    expect(conflicted).toContain('line 3 by A');
    expect(conflicted).toContain('line 3 by B');
    gitIn(box.storage, 'rebase', '--abort');
  });

  it('refuses to push files committed without the filter', async () => {
    usedStorage();
    gitIn(box.storage, 'remote', 'add', 'origin', bareRemote());
    await encryptA();
    removeFilters(box.storage);
    write(path.join(box.storage, 'proj', 'leak.md'), CANARY);
    gitIn(box.storage, 'add', 'proj/leak.md');
    gitIn(box.storage, 'commit', '-q', '-m', 'by hand');
    installFilters(box.storage);
    expect(() => syncStorage(box.storage)).toThrow(/not encrypted:\s+proj\/leak\.md/);
  });

  it('writes encrypted zips that load with the storage key or the recovery key', async () => {
    usedStorage();
    const { keyFile } = await encryptA();
    const zip = (await zipCommand('proj', { cwd: box.root, output: path.join(box.root, 'proj.zip'), silent: true }))!;
    const raw = readZip(zip);
    expect(raw.meta?.encrypted).toMatchObject({ v: 1 });
    expect([...raw.files.keys()]).toEqual(['payload.dokuenc']);
    expect(fs.readFileSync(zip).includes(Buffer.from('notes.md'))).toBe(false);

    // Same storage: opens with its own key.
    const [r] = await loadCommand(zip, { cwd: box.root, project: 'copy', yes: true, link: false, prompter: scripted() });
    expect(r.added).toEqual(['notes.md']);
    expect(read(box.storage, 'copy', 'notes.md')).toContain(CANARY);

    // A fresh, unencrypted storage: needs the recovery key.
    machine('c');
    const storageC = path.join(box.root, 'storageC');
    initCommand({ storage: storageC });
    await expect(loadCommand(zip, { cwd: box.root, yes: true, link: false, prompter: scripted('') })).rejects.toThrow(/No key given/);
    const [c] = await loadCommand(zip, { cwd: box.root, yes: true, link: false, keyFile, prompter: scripted() });
    expect(c.name).toBe('proj');
    expect(read(storageC, 'proj', 'notes.md')).toContain(CANARY);
    expect(fs.existsSync(path.join(storageC, CRYPT_FILE))).toBe(false);

    // --plain writes an ordinary zip.
    machine('a');
    const plain = (await zipCommand('proj', { cwd: box.root, output: path.join(box.root, 'plain.zip'), silent: true, plain: true }))!;
    expect(readZip(plain).meta?.encrypted).toBeUndefined();
    expect(readZip(plain).files.has('notes.md')).toBe(true);
  });

  it('decrypt turns encryption off everywhere', async () => {
    usedStorage();
    const remote = bareRemote();
    gitIn(box.storage, 'remote', 'add', 'origin', remote);
    const { keyFile } = await encryptA();
    syncStorage(box.storage);
    machine('b');
    const storageB = path.join(box.root, 'storageB');
    initCommand({ storage: storageB, clone: remote });
    await unlockCommand({ keyFile });

    machine('a');
    expect(await decryptCommand({ prompter: scripted('no') })).toBe(false);
    expect(await decryptCommand({ prompter: scripted('decrypt') })).toBe(true);
    expect(cryptState(box.storage)).toBe('off');
    syncStorage(box.storage);
    expect(gitIn(remote, 'show', 'main:proj/notes.md')).toContain(CANARY);

    machine('b');
    write(path.join(storageB, 'proj', 'b.md'), 'after decrypt');
    syncStorage(storageB);
    expect(cryptState(storageB)).toBe('off');
    expect(tryGit(storageB, ['config', '--get-regexp', 'doku']).stdout).toBe('');
    expect(gitIn(remote, 'show', 'main:proj/b.md')).toBe('after decrypt');
    expect(read(storageB, 'proj', 'notes.md')).toContain(CANARY);
  });

  it('replaces unencrypted history already on the remote, and moves old clones over', async () => {
    usedStorage();
    const remote = bareRemote();
    gitIn(box.storage, 'remote', 'add', 'origin', remote);
    syncStorage(box.storage);
    machine('b');
    const storageB = path.join(box.root, 'storageB');
    initCommand({ storage: storageB, clone: remote });
    write(path.join(storageB, 'proj', 'only-b.md'), 'unsynced on B');
    write(path.join(storageB, 'proj', 'notes.md'), 'edited on B, unsynced');

    machine('a');
    const { keyFile, replacesRemote } = await encryptA();
    expect(replacesRemote).toBe(true);
    expect(readLocalState(box.storage).replaceRemote).toBeTruthy();
    expect(syncStorage(box.storage)).toMatchObject({ pushed: true });
    expect(readLocalState(box.storage).replaceRemote).toBeUndefined();
    expect(gitIn(remote, 'rev-list', '--count', 'main')).toBe('1');
    expect(plaintextBlobs(remote, ['--all'])).toEqual([]);

    // B's next sync stops instead of mixing histories; unlock switches it over.
    machine('b');
    expect(() => syncStorage(storageB)).toThrow(/doku unlock/);
    expect(await unlockCommand({ keyFile })).toBe(true);
    expect(cryptState(storageB)).toBe('unlocked');
    expect(plaintextObjects(storageB)).toEqual([]);
    expect(read(storageB, 'proj', 'only-b.md')).toBe('unsynced on B');
    expect(read(storageB, 'proj', 'notes.md')).toContain(`${CANARY} v3`);
    const backups = fs.readdirSync(path.join(box.root, 'home-b', 'backups'));
    expect(read(box.root, 'home-b', 'backups', backups[0], 'proj', 'notes.md')).toBe('edited on B, unsynced');
    expect(syncStorage(storageB)).toMatchObject({ committed: true, pushed: true });
    expect(plaintextBlobs(remote, ['--all'])).toEqual([]);
  });
});

function execBuffer(cwd: string, ...args: string[]): Buffer {
  return execFileSync('git', ['-C', cwd, ...args]);
}
