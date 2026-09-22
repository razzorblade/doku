import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { initCommand } from '../src/commands/init.js';
import { originUrl, removeRemoteCommand, setRemoteCommand } from '../src/commands/remote.js';
import { tryGit } from '../src/git.js';
import { syncStorage } from '../src/sync.js';
import { gitIn, useSandbox } from './helpers.js';

describe('remote', () => {
  const box = useSandbox();

  function bareRemote(name: string): string {
    const remote = path.join(box.root, `${name}.git`);
    fs.mkdirSync(remote);
    gitIn(remote, 'init', '-q', '--bare', '-b', 'main');
    return remote;
  }

  function write(rel: string, text: string): void {
    const file = path.join(box.storage, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }

  it('adds a remote that sync then pushes to, and removes it again', () => {
    initCommand({ storage: box.storage });
    const remote = bareRemote('remote');
    setRemoteCommand(remote);
    expect(originUrl(box.storage)).toBe(remote);

    write('proj/a.md', 'hello');
    expect(syncStorage(box.storage)).toMatchObject({ committed: true, pushed: true });
    expect(gitIn(remote, 'show', 'main:proj/a.md')).toBe('hello');

    removeRemoteCommand();
    expect(originUrl(box.storage)).toBeNull();
    expect(syncStorage(box.storage)).toMatchObject({ pushed: false });
  });

  it('moves to a new, empty remote without stale tracking of the old one', () => {
    initCommand({ storage: box.storage });
    const oldRemote = bareRemote('old');
    setRemoteCommand(oldRemote);
    write('proj/a.md', 'v1');
    syncStorage(box.storage);

    const newRemote = bareRemote('new');
    setRemoteCommand(newRemote);
    expect(originUrl(box.storage)).toBe(newRemote);
    expect(tryGit(box.storage, ['rev-parse', '--abbrev-ref', '@{u}']).ok).toBe(false);

    write('proj/a.md', 'v2');
    expect(syncStorage(box.storage)).toMatchObject({ committed: true, pushed: true });
    expect(gitIn(newRemote, 'show', 'main:proj/a.md')).toBe('v2');
    expect(gitIn(oldRemote, 'show', 'main:proj/a.md')).toBe('v1');
  });

  it('tracks a new remote that already has this storage, e.g. a moved repository', () => {
    initCommand({ storage: box.storage });
    const oldRemote = bareRemote('old');
    setRemoteCommand(oldRemote);
    write('proj/a.md', 'v1');
    syncStorage(box.storage);

    const moved = path.join(box.root, 'moved.git');
    gitIn(box.root, 'clone', '-q', '--bare', oldRemote, moved);
    setRemoteCommand(moved);
    expect(gitIn(box.storage, 'rev-parse', '--abbrev-ref', '@{u}')).toBe('origin/main');

    write('proj/b.md', 'new');
    expect(syncStorage(box.storage)).toMatchObject({ committed: true, pulled: true, pushed: true });
    expect(gitIn(moved, 'show', 'main:proj/b.md')).toBe('new');
  });

  it('keeps an unreachable remote, and sync reports the failure', () => {
    initCommand({ storage: box.storage });
    const missing = path.join(box.root, 'missing.git');
    setRemoteCommand(missing);
    expect(originUrl(box.storage)).toBe(missing);
    expect(() => syncStorage(box.storage)).toThrow(/push failed/);
  });

  it('needs a storage repository', () => {
    fs.mkdirSync(box.storage);
    initCommand({ storage: box.storage });
    fs.rmSync(path.join(box.storage, '.git'), { recursive: true, force: true });
    expect(() => setRemoteCommand('x')).toThrow(/not its own git repository/);
  });
});
