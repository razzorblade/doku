import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NOTE_FILE } from '../src/agentsNote.js';
import { doctorCommand } from '../src/commands/doctor.js';
import { initCommand } from '../src/commands/init.js';
import { linkCommand } from '../src/commands/link.js';
import { unlinkCommand } from '../src/commands/unlink.js';
import { excludeFile } from '../src/gitExclude.js';
import { inspectLink, removeLink } from '../src/link.js';
import { loadLinks } from '../src/registry.js';
import { gitIn, useSandbox } from './helpers.js';

describe('link / unlink / doctor', () => {
  const box = useSandbox();

  it('links a git project end to end and keeps git clean', () => {
    initCommand({ storage: box.storage });
    const project = box.mkProject('my-cool-project');

    linkCommand(project, undefined, {});

    const doc = path.join(project, '.doku', 'decisions.md');
    fs.writeFileSync(doc, '# decisions');
    expect(fs.existsSync(path.join(box.storage, 'my-cool-project', 'decisions.md'))).toBe(true);
    expect(fs.existsSync(path.join(box.storage, 'my-cool-project', 'README.md'))).toBe(true);
    expect(fs.readFileSync(path.join(project, NOTE_FILE), 'utf8')).toContain('.doku/');
    expect(gitIn(project, 'status', '--porcelain')).toBe('');
    expect(loadLinks()).toEqual([{ name: 'my-cool-project', projectPath: project, linkName: '.doku', agentsNote: true }]);
  });

  it('is idempotent when linking twice', () => {
    initCommand({ storage: box.storage });
    const project = box.mkProject('p');
    linkCommand(project, 'p', {});
    linkCommand(project, 'p', {});
    const exclude = fs.readFileSync(excludeFile(project)!, 'utf8');
    expect(exclude.match(/\/\.doku$/gm)).toHaveLength(1);
    expect(fs.readFileSync(path.join(project, NOTE_FILE), 'utf8').match(/doku:start/g)).toHaveLength(1);
    expect(loadLinks()).toHaveLength(1);
  });

  it('unlink restores the project and keeps the docs', () => {
    initCommand({ storage: box.storage });
    const project = box.mkProject('p');
    const excludeBefore = fs.readFileSync(excludeFile(project)!, 'utf8');
    linkCommand(project, 'client-x', { as: 'docs' });
    fs.writeFileSync(path.join(project, 'docs', 'notes.md'), 'keep me');

    unlinkCommand('client-x', {});

    expect(inspectLink(path.join(project, 'docs')).kind).toBe('missing');
    expect(fs.existsSync(path.join(project, NOTE_FILE))).toBe(false);
    expect(fs.readFileSync(excludeFile(project)!, 'utf8')).toBe(excludeBefore);
    expect(fs.readFileSync(path.join(box.storage, 'client-x', 'notes.md'), 'utf8')).toBe('keep me');
    expect(loadLinks()).toEqual([]);
  });

  it('keeps user content in CLAUDE.local.md on unlink', () => {
    initCommand({ storage: box.storage });
    const project = box.mkProject('p');
    fs.writeFileSync(path.join(project, NOTE_FILE), '# my notes\n');
    linkCommand(project, undefined, {});
    unlinkCommand(project, {});
    expect(fs.readFileSync(path.join(project, NOTE_FILE), 'utf8')).toBe('# my notes\n');
  });

  it('works for non-git projects and without the agents note', () => {
    initCommand({ storage: box.storage });
    const project = box.mkProject('plain', false);
    linkCommand(project, undefined, { agentsNote: false });
    expect(inspectLink(path.join(project, '.doku')).kind).toBe('link');
    expect(fs.existsSync(path.join(project, NOTE_FILE))).toBe(false);
  });

  it('refuses when a real .doku folder already exists', () => {
    initCommand({ storage: box.storage });
    const project = box.mkProject('p');
    fs.mkdirSync(path.join(project, '.doku'));
    expect(() => linkCommand(project, undefined, {})).toThrow(/not a link/);
  });

  it('rejects names with path separators', () => {
    initCommand({ storage: box.storage });
    const project = box.mkProject('p');
    expect(() => linkCommand(project, '../escape', {})).toThrow(/Invalid project name/);
  });

  it('asks for disambiguation when a name is linked in several projects', () => {
    initCommand({ storage: box.storage });
    linkCommand(box.mkProject('a'), 'shared', {});
    linkCommand(box.mkProject('b'), 'shared', {});
    expect(() => unlinkCommand('shared', {})).toThrow(/several links/);
    unlinkCommand('shared', { all: true });
    expect(loadLinks()).toEqual([]);
  });

  it('doctor --fix recreates a deleted link and repoints after the storage moves', () => {
    initCommand({ storage: box.storage });
    const project = box.mkProject('p');
    linkCommand(project, undefined, {});

    removeLink(path.join(project, '.doku'));
    expect(doctorCommand({})).toBe(1);
    expect(doctorCommand({ fix: true })).toBe(0);
    expect(inspectLink(path.join(project, '.doku')).kind).toBe('link');

    const moved = path.join(box.root, 'storage2');
    fs.cpSync(box.storage, moved, { recursive: true });
    initCommand({ storage: moved });
    expect(doctorCommand({ fix: true })).toBe(0);
    const state = inspectLink(path.join(project, '.doku'));
    expect(state.kind === 'link' && state.target.toLowerCase()).toBe(path.join(moved, 'p').toLowerCase());
  });

  it('doctor --prune forgets links whose project is gone', () => {
    initCommand({ storage: box.storage });
    const project = box.mkProject('p');
    linkCommand(project, undefined, {});
    fs.rmSync(project, { recursive: true, force: true });
    expect(doctorCommand({})).toBe(1);
    expect(doctorCommand({ prune: true })).toBe(0);
    expect(loadLinks()).toEqual([]);
  });
});
