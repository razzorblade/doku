import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { initCommand } from '../src/commands/init.js';
import { linkCommand, linkFromCli } from '../src/commands/link.js';
import { inspectLink } from '../src/link.js';
import type { Prompter } from '../src/prompt.js';
import { loadLinks } from '../src/registry.js';
import { useSandbox } from './helpers.js';

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

describe('linking a project named differently than its docs', () => {
  const box = useSandbox();

  /** Docs synced from another machine, where the project folder was called web-shop. */
  function clonedStorage(): void {
    initCommand({ storage: box.storage });
    fs.mkdirSync(path.join(box.storage, 'web-shop'));
    fs.writeFileSync(path.join(box.storage, 'web-shop', 'notes.md'), 'from the other PC');
  }

  function linkTarget(project: string): string | undefined {
    const state = inspectLink(path.join(project, '.doku'));
    return state.kind === 'link' ? path.basename(state.target) : undefined;
  }

  it('links the current folder to docs named as the only argument', async () => {
    clonedStorage();
    const project = box.mkProject('shop-frontend');
    await linkFromCli('web-shop', undefined, { cwd: project });

    expect(fs.readFileSync(path.join(project, '.doku', 'notes.md'), 'utf8')).toBe('from the other PC');
    expect(loadLinks()).toMatchObject([{ name: 'web-shop', projectPath: project }]);
    expect(fs.existsSync(path.join(box.storage, 'shop-frontend'))).toBe(false);

    // Running `doku link` again in the project keeps its docs.
    await linkFromCli(undefined, undefined, { cwd: project, prompter: scripted() });
    expect(linkTarget(project)).toBe('web-shop');
    expect(fs.existsSync(path.join(box.storage, 'shop-frontend'))).toBe(false);
  });

  it('prefers a folder over docs of the same name', async () => {
    clonedStorage();
    const folder = box.mkProject('web-shop');
    await linkFromCli('web-shop', undefined, { cwd: path.dirname(folder) });
    expect(loadLinks()).toMatchObject([{ name: 'web-shop', projectPath: folder }]);
  });

  it('rejects an argument that is neither a folder nor docs', async () => {
    clonedStorage();
    const project = box.mkProject('shop-frontend');
    await expect(linkFromCli('nope', undefined, { cwd: project })).rejects.toThrow(/no docs named "nope"/);
  });

  it('offers docs not linked on this machine before creating new ones', async () => {
    clonedStorage();
    const project = box.mkProject('shop-frontend');
    const p = scripted('1');
    await linkFromCli(undefined, undefined, { cwd: project, prompter: p });
    expect(p.questions[0]).toContain('[1] web-shop');
    expect(linkTarget(project)).toBe('web-shop');

    // Declining creates new docs under the folder name.
    const other = box.mkProject('other');
    fs.mkdirSync(path.join(box.storage, 'unlinked'));
    await linkFromCli(undefined, undefined, { cwd: other, prompter: scripted('n') });
    expect(linkTarget(other)).toBe('other');
  });

  it('does not ask when docs with the folder name exist', async () => {
    clonedStorage();
    fs.mkdirSync(path.join(box.storage, 'shop-frontend'));
    const project = box.mkProject('shop-frontend');
    const p = scripted('1');
    await linkFromCli(undefined, undefined, { cwd: project, prompter: p });
    expect(p.questions).toEqual([]);
    expect(linkTarget(project)).toBe('shop-frontend');
  });

  it('switches a project linked to new, unused docs over, removing those', async () => {
    clonedStorage();
    const project = box.mkProject('shop-frontend');
    linkCommand(project, undefined, {});
    expect(fs.existsSync(path.join(box.storage, 'shop-frontend', 'README.md'))).toBe(true);

    await linkFromCli('web-shop', undefined, { cwd: project });
    expect(linkTarget(project)).toBe('web-shop');
    expect(loadLinks()).toMatchObject([{ name: 'web-shop', projectPath: project }]);
    expect(fs.existsSync(path.join(box.storage, 'shop-frontend'))).toBe(false);
  });

  it('keeps the old docs when they were used', async () => {
    clonedStorage();
    const project = box.mkProject('shop-frontend');
    linkCommand(project, undefined, {});
    fs.writeFileSync(path.join(project, '.doku', 'todo.md'), 'written here');

    await linkFromCli(project, 'web-shop', {});
    expect(linkTarget(project)).toBe('web-shop');
    expect(fs.readFileSync(path.join(box.storage, 'shop-frontend', 'todo.md'), 'utf8')).toBe('written here');
  });

  it('only switches from `doku link`, not from other commands', () => {
    clonedStorage();
    const project = box.mkProject('shop-frontend');
    linkCommand(project, undefined, {});
    expect(() => linkCommand(project, 'web-shop', {})).toThrow(/already linked to the docs "shop-frontend"/);
    expect(linkTarget(project)).toBe('shop-frontend');
  });
});
