import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { initCommand } from '../src/commands/init.js';
import { syncStorage } from '../src/sync.js';
import { gitIn, useSandbox } from './helpers.js';

describe('sync', () => {
  const box = useSandbox();

  it('commits locally when there is no remote', () => {
    initCommand({ storage: box.storage });
    const result = syncStorage(box.storage, 'first');
    expect(result).toEqual({ committed: true, pulled: false, pushed: false });
    expect(gitIn(box.storage, 'log', '--format=%s')).toBe('first');
    expect(gitIn(box.storage, 'branch', '--show-current')).toBe('main');
    expect(syncStorage(box.storage).committed).toBe(false);
  });

  it('round-trips changes between two machines through a remote', () => {
    const remote = path.join(box.root, 'remote.git');
    fs.mkdirSync(remote);
    gitIn(remote, 'init', '-q', '--bare', '-b', 'main');

    // Machine A: new storage, add remote, first push.
    initCommand({ storage: box.storage });
    gitIn(box.storage, 'remote', 'add', 'origin', remote);
    fs.mkdirSync(path.join(box.storage, 'proj'));
    fs.writeFileSync(path.join(box.storage, 'proj', 'a.md'), 'from A');
    expect(syncStorage(box.storage)).toMatchObject({ committed: true, pushed: true });

    // Machine B: clone, edit, sync.
    const storageB = path.join(box.root, 'storageB');
    initCommand({ storage: storageB, clone: remote });
    expect(fs.readFileSync(path.join(storageB, 'proj', 'a.md'), 'utf8')).toBe('from A');
    fs.writeFileSync(path.join(storageB, 'proj', 'b.md'), 'from B');
    expect(syncStorage(storageB)).toMatchObject({ committed: true, pulled: true, pushed: true });

    // Machine A edits a different file meanwhile, then syncs: rebase picks up B's change.
    fs.writeFileSync(path.join(box.storage, 'proj', 'a2.md'), 'more from A');
    expect(syncStorage(box.storage)).toMatchObject({ committed: true, pulled: true, pushed: true });
    expect(fs.readFileSync(path.join(box.storage, 'proj', 'b.md'), 'utf8')).toBe('from B');
  });

  it('fails clearly when the storage is not a git repo', () => {
    fs.mkdirSync(box.storage);
    expect(() => syncStorage(box.storage)).toThrow(/not its own git repository/);
  });

  it('never touches a parent repo when the storage sits inside one', () => {
    // Like the default layout: doku-storage/ inside the (git-tracked) tool repo, ignored by it.
    const outer = box.mkProject('outer');
    fs.writeFileSync(path.join(outer, '.gitignore'), 'storage/\n');
    fs.writeFileSync(path.join(outer, 'code.ts'), 'uncommitted work');
    const inner = path.join(outer, 'storage');

    // A plain folder inside the parent repo must not pass as a repo.
    fs.mkdirSync(inner);
    expect(() => syncStorage(inner)).toThrow(/not its own git repository/);

    // init gives it its own repo; sync commits there and leaves the parent alone.
    initCommand({ storage: inner });
    expect(fs.existsSync(path.join(inner, '.git'))).toBe(true);
    expect(syncStorage(inner, 'notes').committed).toBe(true);
    expect(gitIn(inner, 'log', '--format=%s')).toBe('notes');
    expect(() => gitIn(outer, 'log')).toThrow();
    expect(gitIn(outer, 'status', '--porcelain')).toContain('code.ts');
  });
});
