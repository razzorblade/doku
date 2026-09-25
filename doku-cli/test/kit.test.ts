import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { doctorCommand } from '../src/commands/doctor.js';
import { initCommand } from '../src/commands/init.js';
import {
  BESIDE_SUFFIX,
  kitAddCommand,
  kitHints,
  kitNewCommand,
  kitRemoveCommand,
  kitUpdateCommand,
} from '../src/commands/kit.js';
import { linkCommand } from '../src/commands/link.js';
import { storageProjects } from '../src/commands/list.js';
import { KITS_DIR, loadKitEntries } from '../src/kits.js';
import type { Prompter } from '../src/prompt.js';
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

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function read(...parts: string[]): string {
  return fs.readFileSync(path.join(...parts), 'utf8');
}

describe('doku kit', () => {
  const box = useSandbox();

  /** A kit "multi" with CLAUDE.md and .vscode/settings.json, and an empty project folder without git. */
  function setup() {
    initCommand({ storage: box.storage });
    const kit = path.join(box.storage, KITS_DIR, 'multi');
    write(path.join(kit, 'CLAUDE.md'), 'v1\n');
    write(path.join(kit, '.vscode', 'settings.json'), '{}\n');
    const project = box.mkProject('my-project', false);
    return { kit, project };
  }

  it('adds a kit into the current folder and stays out of `doku list`', async () => {
    const { project } = setup();
    const r = await kitAddCommand('multi', { cwd: project, prompter: scripted() });
    expect(r.added.sort()).toEqual(['.vscode/settings.json', 'CLAUDE.md']);
    expect(read(project, 'CLAUDE.md')).toBe('v1\n');
    expect(read(project, '.vscode', 'settings.json')).toBe('{}\n');
    expect(loadKitEntries()).toHaveLength(1);
    expect(storageProjects(box.storage)).toEqual([]);
  });

  it('uses the linked project folder when run in a subfolder', async () => {
    const { project } = setup();
    linkCommand(project, undefined, {});
    const sub = path.join(project, 'unity-project');
    fs.mkdirSync(sub);
    await kitAddCommand('multi', { cwd: sub, prompter: scripted() });
    expect(fs.existsSync(path.join(project, 'CLAUDE.md'))).toBe(true);
    expect(fs.existsSync(path.join(sub, 'CLAUDE.md'))).toBe(false);
  });

  it('updates files unchanged here after asking, and a declined update is asked again', async () => {
    const { kit, project } = setup();
    await kitAddCommand('multi', { cwd: project, prompter: scripted() });
    write(path.join(kit, 'CLAUDE.md'), 'v2\n');
    write(path.join(kit, 'new.md'), 'new\n');
    expect(kitHints(box.storage)).toHaveLength(1);

    // No input: nothing changes, and it stays pending.
    const later = await kitUpdateCommand(undefined, { cwd: project, prompter: scripted() });
    expect(later[0].later.sort()).toEqual(['CLAUDE.md', 'new.md']);
    expect(read(project, 'CLAUDE.md')).toBe('v1\n');

    const [r] = await kitUpdateCommand(undefined, { cwd: project, prompter: scripted('u') });
    expect(r).toMatchObject({ updated: ['CLAUDE.md'], added: ['new.md'] });
    expect(read(project, 'CLAUDE.md')).toBe('v2\n');
    expect(kitHints(box.storage)).toEqual([]);
  });

  it('ignore keeps the files and stops asking until the kit changes them again', async () => {
    const { kit, project } = setup();
    await kitAddCommand('multi', { cwd: project, prompter: scripted() });
    write(path.join(kit, 'CLAUDE.md'), 'v2\n');

    await kitUpdateCommand(undefined, { cwd: project, prompter: scripted('i') });
    expect(read(project, 'CLAUDE.md')).toBe('v1\n');
    expect(kitHints(box.storage)).toEqual([]);

    // The file now counts as the project's own, so the next kit change is a conflict.
    write(path.join(kit, 'CLAUDE.md'), 'v3\n');
    const p = scripted('l');
    await kitUpdateCommand(undefined, { cwd: project, prompter: p });
    expect(p.questions[0]).toMatch(/changed here, and the kit changed it too/);
  });

  it('never touches files changed only here', async () => {
    const { kit, project } = setup();
    await kitAddCommand('multi', { cwd: project, prompter: scripted() });
    write(path.join(project, 'CLAUDE.md'), 'mine\n');
    write(path.join(kit, '.vscode', 'settings.json'), '{"a":1}\n');

    const p = scripted('u');
    const [r] = await kitUpdateCommand(undefined, { cwd: project, prompter: p });
    expect(r.updated).toEqual(['.vscode/settings.json']);
    expect(read(project, 'CLAUDE.md')).toBe('mine\n');
    expect(p.questions).toHaveLength(1);
  });

  it('conflicts: overwrite backs up, keep mine remembers, beside writes next to it', async () => {
    const { kit, project } = setup();
    write(path.join(kit, 'b.md'), 'b1\n');
    write(path.join(kit, 'c.md'), 'c1\n');
    await kitAddCommand('multi', { cwd: project, prompter: scripted() });
    for (const f of ['CLAUDE.md', 'b.md', 'c.md']) {
      write(path.join(project, f), 'mine\n');
      write(path.join(kit, f), 'kit v2\n');
    }

    // Asked in path order: b.md, c.md, CLAUDE.md.
    const [r] = await kitUpdateCommand(undefined, { cwd: project, prompter: scripted('k', 'b', 'o') });
    expect(r).toMatchObject({ overwritten: ['CLAUDE.md'], kept: ['b.md'], beside: ['c.md'] });
    expect(read(project, 'CLAUDE.md')).toBe('kit v2\n');
    expect(read(r.backup!, 'CLAUDE.md')).toBe('mine\n');
    expect(read(project, 'b.md')).toBe('mine\n');
    expect(read(project, 'c.md')).toBe('mine\n');
    expect(read(project, `c.md${BESIDE_SUFFIX}`)).toBe('kit v2\n');

    // All decided: nothing more to ask.
    const p = scripted();
    await kitUpdateCommand(undefined, { cwd: project, prompter: p });
    expect(p.questions).toEqual([]);
  });

  it('--keep-mine applies safe changes and keeps every conflicting file', async () => {
    const { kit, project } = setup();
    await kitAddCommand('multi', { cwd: project, prompter: scripted() });
    write(path.join(project, 'CLAUDE.md'), 'mine\n');
    write(path.join(kit, 'CLAUDE.md'), 'v2\n');
    write(path.join(kit, 'new.md'), 'new\n');

    const p = scripted();
    const [r] = await kitUpdateCommand(undefined, { cwd: project, keepMine: true, prompter: p });
    expect(r).toMatchObject({ added: ['new.md'], kept: ['CLAUDE.md'] });
    expect(p.questions).toEqual([]);
    expect(read(project, 'CLAUDE.md')).toBe('mine\n');
  });

  it('removes files the kit dropped only when unchanged here', async () => {
    const { kit, project } = setup();
    write(path.join(kit, 'tools', 'a.md'), 'a\n');
    write(path.join(kit, 'b.md'), 'b\n');
    await kitAddCommand('multi', { cwd: project, prompter: scripted() });
    write(path.join(project, 'b.md'), 'mine\n');
    fs.rmSync(path.join(kit, 'tools'), { recursive: true });
    fs.rmSync(path.join(kit, 'b.md'));

    const [r] = await kitUpdateCommand(undefined, { cwd: project, yes: true, prompter: scripted() });
    expect(r.removed).toEqual(['tools/a.md']);
    expect(fs.existsSync(path.join(project, 'tools'))).toBe(false);
    expect(read(project, 'b.md')).toBe('mine\n');
    expect(Object.keys(loadKitEntries()[0].files)).not.toContain('b.md');
  });

  it('asks about files that already exist when adding', async () => {
    const { project } = setup();
    write(path.join(project, 'CLAUDE.md'), 'existing\n');
    const p = scripted('k');
    const r = await kitAddCommand('multi', { cwd: project, prompter: p });
    expect(p.questions[0]).toMatch(/already exists here/);
    expect(r).toMatchObject({ added: ['.vscode/settings.json'], kept: ['CLAUDE.md'] });
    expect(read(project, 'CLAUDE.md')).toBe('existing\n');
  });

  it('a file deleted here stays deleted until the kit changes it', async () => {
    const { kit, project } = setup();
    await kitAddCommand('multi', { cwd: project, prompter: scripted() });
    fs.rmSync(path.join(project, 'CLAUDE.md'));
    expect(kitHints(box.storage)).toEqual([]);

    write(path.join(kit, 'CLAUDE.md'), 'v2\n');
    const p = scripted('o');
    const [r] = await kitUpdateCommand(undefined, { cwd: project, prompter: p });
    expect(p.questions[0]).toMatch(/deleted here/);
    expect(r.overwritten).toEqual(['CLAUDE.md']);
    expect(read(project, 'CLAUDE.md')).toBe('v2\n');
  });

  it('kit new seeds a kit from project files and counts the project as up to date', async () => {
    initCommand({ storage: box.storage });
    const project = box.mkProject('p', false);
    write(path.join(project, 'CLAUDE.md'), 'root\n');
    write(path.join(project, '.claude', 'commands', 'x.md'), 'x\n');

    kitNewCommand('unity-generic', ['CLAUDE.md', '.claude'], { cwd: project });
    const kit = path.join(box.storage, KITS_DIR, 'unity-generic');
    expect(read(kit, 'CLAUDE.md')).toBe('root\n');
    expect(read(kit, '.claude', 'commands', 'x.md')).toBe('x\n');
    expect(loadKitEntries()[0]).toMatchObject({ kit: 'unity-generic', projectPath: project });
    expect(kitHints(box.storage)).toEqual([]);
    expect(() => kitNewCommand('unity-generic', [], { cwd: project })).toThrow(/already exists/);
  });

  it('refuses files already provided by another kit', async () => {
    const { project } = setup();
    write(path.join(box.storage, KITS_DIR, 'other', 'CLAUDE.md'), 'other\n');
    await kitAddCommand('multi', { cwd: project, prompter: scripted() });
    await expect(kitAddCommand('other', { cwd: project, prompter: scripted() })).rejects.toThrow(/one kit only/);
  });

  it('remove offers to delete unchanged files and keeps changed ones', async () => {
    const { project } = setup();
    await kitAddCommand('multi', { cwd: project, prompter: scripted() });
    write(path.join(project, 'CLAUDE.md'), 'mine\n');

    const r = await kitRemoveCommand('multi', { cwd: project, prompter: scripted('y') });
    expect(r).toEqual({ deleted: ['.vscode/settings.json'], kept: ['CLAUDE.md'] });
    expect(fs.existsSync(path.join(project, '.vscode'))).toBe(false);
    expect(read(project, 'CLAUDE.md')).toBe('mine\n');
    expect(loadKitEntries()).toEqual([]);
  });

  it('doctor --prune forgets kits of deleted project folders', async () => {
    const { project } = setup();
    await kitAddCommand('multi', { cwd: project, prompter: scripted() });
    fs.rmSync(project, { recursive: true });
    expect(doctorCommand({})).toBe(1);
    doctorCommand({ prune: true });
    expect(loadKitEntries()).toEqual([]);
  });

  it('refuses to work inside the storage, and .kits as a project name', async () => {
    setup();
    await expect(kitAddCommand('multi', { cwd: box.storage, prompter: scripted() })).rejects.toThrow(/not in the storage/);
    const other = box.mkProject('x');
    expect(() => linkCommand(other, KITS_DIR, {})).toThrow(/keeps kits/);
  });
});
