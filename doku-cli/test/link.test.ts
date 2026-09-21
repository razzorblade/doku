import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLink, inspectLink, removeLink } from '../src/link.js';
import { useSandbox } from './helpers.js';

describe('link primitives', () => {
  const box = useSandbox();

  function setup() {
    const target = path.join(box.storage, 'proj');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'note.md'), 'hello');
    const linkPath = path.join(box.mkProject('proj', false), '.doku');
    return { target, linkPath };
  }

  it('creates a link that reads and writes through to the target', () => {
    const { target, linkPath } = setup();
    expect(createLink(target, linkPath)).toBe(true);
    expect(fs.readFileSync(path.join(linkPath, 'note.md'), 'utf8')).toBe('hello');
    fs.writeFileSync(path.join(linkPath, 'new.md'), 'from project');
    expect(fs.readFileSync(path.join(target, 'new.md'), 'utf8')).toBe('from project');
    expect(inspectLink(linkPath)).toMatchObject({ kind: 'link', targetExists: true });
  });

  it('is idempotent for the same target', () => {
    const { target, linkPath } = setup();
    createLink(target, linkPath);
    expect(createLink(target, linkPath)).toBe(false);
  });

  it('refuses to replace a real folder', () => {
    const { target, linkPath } = setup();
    fs.mkdirSync(linkPath);
    expect(() => createLink(target, linkPath)).toThrow(/not a link/);
  });

  it('removes only the link, keeping the docs', () => {
    const { target, linkPath } = setup();
    createLink(target, linkPath);
    expect(removeLink(linkPath, box.storage)).toBe(true);
    expect(inspectLink(linkPath).kind).toBe('missing');
    expect(fs.readFileSync(path.join(target, 'note.md'), 'utf8')).toBe('hello');
  });

  it('refuses to remove a real folder', () => {
    const { linkPath } = setup();
    fs.mkdirSync(linkPath);
    fs.writeFileSync(path.join(linkPath, 'keep.md'), 'x');
    expect(() => removeLink(linkPath, box.storage)).toThrow(/Refusing/);
    expect(fs.existsSync(path.join(linkPath, 'keep.md'))).toBe(true);
  });

  it('refuses to remove a link pointing outside the storage', () => {
    const { linkPath } = setup();
    const elsewhere = path.join(box.root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    createLink(elsewhere, linkPath);
    expect(() => removeLink(linkPath, box.storage)).toThrow(/outside/);
  });

  it('reports a broken link when the target disappears', () => {
    const { target, linkPath } = setup();
    createLink(target, linkPath);
    fs.rmSync(target, { recursive: true });
    expect(inspectLink(linkPath)).toMatchObject({ kind: 'link', targetExists: false });
  });
});
