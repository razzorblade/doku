import fs from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { ignoreCommand, unignoreCommand } from '../src/commands/ignore.js';
import { initCommand } from '../src/commands/init.js';
import { linkCommand } from '../src/commands/link.js';
import { unlinkCommand } from '../src/commands/unlink.js';
import { zipCommand } from '../src/commands/zip.js';
import { createMatcher, IGNORE_FILE, toRootPattern } from '../src/dokuignore.js';
import { gitIn, useSandbox } from './helpers.js';

function zipEntries(file: string): string[] {
  return Object.keys(unzipSync(fs.readFileSync(file))).sort();
}

describe('.dokuignore patterns', () => {
  it('rewrites project patterns for the storage root with gitignore semantics', () => {
    expect(toRootPattern('p', '/file1.md')).toBe('/p/file1.md');
    expect(toRootPattern('p', 'folder/')).toBe('/p/**/folder/');
    expect(toRootPattern('p', 'a/b.md')).toBe('/p/a/b.md');
    expect(toRootPattern('p', '*.pdf')).toBe('/p/**/*.pdf');
    expect(toRootPattern('p', '!keep.pdf')).toBe('!/p/**/keep.pdf');
    expect(toRootPattern('', '*.secret')).toBe('*.secret');
    expect(toRootPattern('', '/p/x')).toBe('/p/x');
  });
});

describe('ignore + zip', () => {
  const box = useSandbox();

  /** The layout from the feature request. */
  function myProject() {
    initCommand({ storage: box.storage });
    const project = box.mkProject('my-project');
    fs.mkdirSync(path.join(project, 'project-files'));
    fs.writeFileSync(path.join(project, 'Readme.md'), 'readme');
    linkCommand(project, undefined, {});
    const docs = path.join(project, '.doku');
    fs.writeFileSync(path.join(docs, 'file1.md'), '1');
    fs.writeFileSync(path.join(docs, 'file2.md'), '2');
    fs.mkdirSync(path.join(docs, 'folder'));
    fs.writeFileSync(path.join(docs, 'folder', 'inner.md'), 'x');
    return { project, docs, storageDir: path.join(box.storage, 'my-project') };
  }

  it('matches the feature example: ignore two paths, zip only the rest', () => {
    const { project, storageDir } = myProject();

    ignoreCommand(['file1.md'], { cwd: project });
    ignoreCommand(['folder/'], { cwd: project });
    expect(fs.readFileSync(path.join(storageDir, IGNORE_FILE), 'utf8')).toBe('/file1.md\n/folder/\n');

    const out = zipCommand('.', { cwd: project, silent: true });
    expect(out).toBe(path.join(project, '.doku.zip'));
    expect(zipEntries(out)).toEqual(['.dokuignore', 'README.md', 'file2.md']);

    // The zip is hidden from the project's git, the ignored docs from the storage's git.
    expect(gitIn(project, 'status', '--porcelain', '--untracked-files=all')).toBe('?? Readme.md');
    const storageStatus = gitIn(box.storage, 'status', '--porcelain', '--untracked-files=all');
    expect(storageStatus).toContain('my-project/file2.md');
    expect(storageStatus).not.toContain('file1.md');
    expect(storageStatus).not.toContain('folder/');
  });

  it('resolves paths from inside the docs folder and through .doku/', () => {
    const { project, docs, storageDir } = myProject();
    ignoreCommand(['inner.md'], { cwd: path.join(docs, 'folder') });
    ignoreCommand(['.doku/file2.md'], { cwd: project });
    ignoreCommand(['*.pdf'], { cwd: path.join(project, 'project-files') });
    expect(fs.readFileSync(path.join(storageDir, IGNORE_FILE), 'utf8')).toBe('/folder/inner.md\n/file2.md\n*.pdf\n');
  });

  it('works from the storage project folder too', () => {
    const { storageDir } = myProject();
    ignoreCommand(['file1.md'], { cwd: storageDir });
    expect(fs.readFileSync(path.join(storageDir, IGNORE_FILE), 'utf8')).toBe('/file1.md\n');
  });

  it('fails outside a doku project', () => {
    myProject();
    const elsewhere = box.mkProject('unrelated');
    expect(() => ignoreCommand(['file1.md'], { cwd: elsewhere })).toThrow(/Not in a doku project/);
    expect(() => ignoreCommand([], { cwd: elsewhere })).toThrow(/Not in a doku project/);
    expect(() => zipCommand('.', { cwd: elsewhere, silent: true })).toThrow(/Not in a doku project/);
  });

  it('refuses paths outside the docs folder and the docs folder itself', () => {
    const { project, docs } = myProject();
    expect(() => ignoreCommand(['../x.md'], { cwd: project })).toThrow(/outside/);
    expect(() => ignoreCommand(['.'], { cwd: docs })).toThrow(/whole docs folder/);
  });

  it('is idempotent and unignore accepts the same path', () => {
    const { project, storageDir } = myProject();
    ignoreCommand(['file1.md'], { cwd: project });
    expect(ignoreCommand(['file1.md'], { cwd: project })).toEqual([]);
    expect(unignoreCommand(['file1.md'], { cwd: project })).toEqual(['/file1.md']);
    expect(fs.existsSync(path.join(storageDir, IGNORE_FILE))).toBe(false);
  });

  it('zips the whole storage without .git and ignored files', () => {
    const { project } = myProject();
    fs.writeFileSync(path.join(box.storage, IGNORE_FILE), '*.secret\n');
    fs.writeFileSync(path.join(box.storage, 'my-project', 'keys.secret'), 's');
    ignoreCommand(['folder'], { cwd: project });

    const out = zipCommand(undefined, { cwd: box.root, silent: true });
    expect(out).toBe(path.join(box.root, 'storage.zip'));
    expect(zipEntries(out)).toEqual([
      '.dokuignore',
      'README.md',
      'my-project/.dokuignore',
      'my-project/README.md',
      'my-project/file1.md',
      'my-project/file2.md',
    ]);
  });

  it('never writes a default zip into the storage', () => {
    myProject();
    const out = zipCommand(undefined, { cwd: path.join(box.storage, 'my-project'), silent: true });
    expect(out).toBe(path.join(box.root, 'storage.zip'));
  });

  it('matcher applies root and project rules', () => {
    myProject();
    fs.writeFileSync(path.join(box.storage, IGNORE_FILE), 'tmp/\n');
    fs.writeFileSync(path.join(box.storage, 'my-project', IGNORE_FILE), '/folder/\n*.log\n');
    const m = createMatcher(box.storage);
    expect(m('my-project/folder', true)).toBe(true);
    expect(m('my-project/sub/folder', true)).toBe(false);
    expect(m('my-project/a/b.log', false)).toBe(true);
    expect(m('my-project/deep/tmp', true)).toBe(true);
    expect(m('my-project/file2.md', false)).toBe(false);
  });

  it('unlink drops the zip exclude once the zip is deleted', () => {
    const { project } = myProject();
    const out = zipCommand('.', { cwd: project, silent: true });
    fs.rmSync(out);
    unlinkCommand(project, {});
    const exclude = fs.readFileSync(path.join(project, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).not.toContain('doku');
  });
});

describe('link from inside the storage', () => {
  const box = useSandbox();
  it('is refused', () => {
    initCommand({ storage: box.storage });
    fs.mkdirSync(path.join(box.storage, 'x'));
    expect(() => linkCommand(path.join(box.storage, 'x'), undefined, {})).toThrow(/inside the doku storage/);
  });

  it('re-running init keeps the configured storage', () => {
    initCommand({ storage: box.storage });
    expect(initCommand({})).toBe(box.storage);
  });
});
