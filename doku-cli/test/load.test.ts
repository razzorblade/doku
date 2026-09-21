import fs from 'node:fs';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { initCommand } from '../src/commands/init.js';
import { linkCommand } from '../src/commands/link.js';
import { describeChange, loadCommand } from '../src/commands/load.js';
import { zipCommand } from '../src/commands/zip.js';
import type { Prompter } from '../src/prompt.js';
import { loadLinks } from '../src/registry.js';
import { readZip, safeEntryPath } from '../src/zip.js';
import { useSandbox } from './helpers.js';

/** Answers questions in order; records them. Runs out → behaves like closed stdin. */
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

function writeZipFile(file: string, entries: Record<string, string>): string {
  const data = Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, strToU8(v)]));
  fs.writeFileSync(file, zipSync(data));
  return file;
}

function read(...parts: string[]): string {
  return fs.readFileSync(path.join(...parts), 'utf8');
}

describe('doku load', () => {
  const box = useSandbox();

  /** A project zipped with `doku zip`, then removed from storage (as on a fresh machine). */
  function zippedProject(name = 'my-project') {
    initCommand({ storage: box.storage });
    const project = box.mkProject(name);
    linkCommand(project, undefined, {});
    fs.writeFileSync(path.join(project, '.doku', 'notes.md'), 'a\nb\n');
    const zip = zipCommand(name, { cwd: box.root, output: path.join(box.root, `${name}.zip`), silent: true });
    return { project, zip, storageDir: path.join(box.storage, name) };
  }

  it('doku zip writes metadata that names the project', () => {
    const { zip } = zippedProject();
    const contents = readZip(zip);
    expect(contents.meta).toMatchObject({ doku: 1, kind: 'project', name: 'my-project' });
    expect([...contents.files.keys()].sort()).toEqual(['README.md', 'notes.md']);
  });

  it('matches the project from metadata and asks before creating it', async () => {
    initCommand({ storage: box.storage });
    const zip = writeZipFile(path.join(box.root, 'x.zip'), {
      '.doku-meta.json': JSON.stringify({ doku: 1, kind: 'project', name: 'fresh', created: '' }),
      'a.md': 'A',
      'sub/b.md': 'B',
    });

    // Declined: nothing written.
    expect(await loadCommand(zip, { cwd: box.root, prompter: scripted('n') })).toEqual([]);
    expect(fs.existsSync(path.join(box.storage, 'fresh'))).toBe(false);

    // No input at all (non-interactive) also means no.
    expect(await loadCommand(zip, { cwd: box.root, prompter: scripted() })).toEqual([]);
    expect(fs.existsSync(path.join(box.storage, 'fresh'))).toBe(false);

    // Confirmed, link skipped.
    const p = scripted('y', '');
    const [r] = await loadCommand(zip, { cwd: box.root, prompter: p });
    expect(r).toMatchObject({ name: 'fresh', created: true, added: ['a.md', 'sub/b.md'] });
    expect(read(box.storage, 'fresh', 'sub', 'b.md')).toBe('B');
    expect(fs.existsSync(path.join(box.storage, 'fresh', '.doku-meta.json'))).toBe(false);
    expect(p.questions[1]).toMatch(/Project folder to link/);
    expect(loadLinks()).toEqual([]);
  });

  it('links the new project when the user gives a folder', async () => {
    initCommand({ storage: box.storage });
    const project = box.mkProject('target');
    const zip = writeZipFile(path.join(box.root, 'x.zip'), {
      '.doku-meta.json': JSON.stringify({ doku: 1, kind: 'project', name: 'fresh', created: '' }),
      'a.md': 'A',
    });
    // First folder does not exist: warned and asked again.
    const [r] = await loadCommand(zip, { cwd: box.root, prompter: scripted('y', 'nope', project) });
    expect(r.linked?.projectPath).toBe(project);
    expect(read(project, '.doku', 'a.md')).toBe('A');
  });

  it('--project with an existing project: append keeps differing files', async () => {
    const { zip, storageDir } = zippedProject();
    fs.writeFileSync(path.join(storageDir, 'notes.md'), 'changed locally\n');
    fs.rmSync(path.join(storageDir, 'README.md'));

    const [r] = await loadCommand(zip, { cwd: box.root, project: 'my-project', prompter: scripted('a') });
    expect(r).toMatchObject({ added: ['README.md'], kept: ['notes.md'], overwritten: [] });
    expect(read(storageDir, 'notes.md')).toBe('changed locally\n');
    expect(fs.existsSync(path.join(storageDir, 'README.md'))).toBe(true);
  });

  it('overwrite backs up replaced files and never deletes extra ones', async () => {
    const { zip, storageDir } = zippedProject();
    fs.writeFileSync(path.join(storageDir, 'notes.md'), 'changed locally\n');
    fs.writeFileSync(path.join(storageDir, 'only-here.md'), 'keep me');

    const [r] = await loadCommand(zip, { cwd: box.root, prompter: scripted('o') });
    expect(r.overwritten).toEqual(['notes.md']);
    expect(read(storageDir, 'notes.md')).toBe('a\nb\n');
    expect(read(storageDir, 'only-here.md')).toBe('keep me');
    expect(read(r.backup!, 'notes.md')).toBe('changed locally\n');
    expect(r.backup!.startsWith(path.join(box.root, 'home'))).toBe(true);
  });

  it('cancels by default when the user does not choose', async () => {
    const { zip, storageDir } = zippedProject();
    fs.writeFileSync(path.join(storageDir, 'notes.md'), 'changed locally\n');
    expect(await loadCommand(zip, { cwd: box.root, prompter: scripted('') })).toEqual([]);
    expect(await loadCommand(zip, { cwd: box.root, prompter: scripted() })).toEqual([]);
    expect(read(storageDir, 'notes.md')).toBe('changed locally\n');
  });

  it('--project with a missing project asks before creating it', async () => {
    const { zip } = zippedProject();
    const p = scripted('y');
    const [r] = await loadCommand(zip, { cwd: box.root, project: 'copy', prompter: p, link: false });
    expect(r.created).toBe(true);
    expect(p.questions[0]).toMatch(/Create storage project "copy"/);
    expect(read(box.storage, 'copy', 'notes.md')).toBe('a\nb\n');
  });

  it('without metadata, unwraps a single folder and suggests its name', async () => {
    initCommand({ storage: box.storage });
    const zip = writeZipFile(path.join(box.root, 'download.zip'), { 'docs/a.md': 'A' });
    const p = scripted('', 'y', '');
    const [r] = await loadCommand(zip, { cwd: box.root, prompter: p });
    expect(p.questions[0]).toContain('[docs]');
    expect(r.name).toBe('docs');
    expect(read(box.storage, 'docs', 'a.md')).toBe('A');
  });

  it('skips unsafe entries and does not write through links', async () => {
    const { zip: _zip, storageDir, project } = zippedProject();
    fs.symlinkSync(project, path.join(storageDir, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const zip = writeZipFile(path.join(box.root, 'evil.zip'), {
      '.doku-meta.json': JSON.stringify({ doku: 1, kind: 'project', name: 'my-project', created: '' }),
      '../outside.md': 'x',
      'escape/pwned.md': 'x',
      '.git/config': 'x',
      'ok.md': 'ok',
    });
    const [r] = await loadCommand(zip, { cwd: box.root, prompter: scripted('y'), link: false });
    expect(r.added).toEqual(['ok.md']);
    expect(r.blocked).toEqual(['escape/pwned.md']);
    expect(fs.existsSync(path.join(box.root, 'outside.md'))).toBe(false);
    expect(fs.existsSync(path.join(project, 'pwned.md'))).toBe(false);
    expect(safeEntryPath('C:/x.md')).toBeNull();
    expect(safeEntryPath('a\\b.md')).toBe('a/b.md');
  });

  it('loads a whole-storage zip project by project', async () => {
    const { storageDir } = zippedProject();
    const whole = zipCommand(undefined, { cwd: box.root, silent: true });
    fs.renameSync(storageDir, path.join(box.root, 'moved-away'));
    fs.rmSync(path.join(box.storage, 'README.md'));

    const results = await loadCommand(whole, { cwd: box.root, prompter: scripted('y', 'y') });
    expect(results.map((r) => r.name)).toEqual(['my-project']);
    expect(read(storageDir, 'notes.md')).toBe('a\nb\n');
    expect(fs.existsSync(path.join(box.storage, 'README.md'))).toBe(true);
    await expect(loadCommand(whole, { cwd: box.root, project: 'x', prompter: scripted() })).rejects.toThrow(/whole storage/);
  });

  it('describes changes in lines, chars and size', () => {
    const text = describeChange(strToU8('a\nb\n'), strToU8('a\nb\nccc\n')).replace(/\x1b\[\d+m/g, '');
    expect(text).toBe('2 → 3 lines (+1), 4 → 8 chars (+4), 4 B → 8 B (+4 B)');
    expect(describeChange(new Uint8Array([0, 1]), new Uint8Array([0])).replace(/\x1b\[\d+m/g, '')).toBe('2 B → 1 B (-1 B)');
  });
});
