import fs from 'node:fs';
import path from 'node:path';
import { requireConfig } from '../config.js';
import { addRules, applyIgnoresToGit, IGNORE_FILE, readRules, removeRules } from '../dokuignore.js';
import { DokuError } from '../errors.js';
import { log, pc } from '../log.js';
import { currentProject, type DocsContext, resolveDocsPath } from '../resolve.js';

export interface IgnoreOptions {
  cwd?: string;
}

/**
 * Turn a user path into a .dokuignore pattern. Bare globs (`*.pdf`) match at any
 * depth; everything else is anchored to the project's docs folder (`/file1.md`,
 * `/folder/`).
 */
function patternFor(arg: string, ctx: DocsContext, storagePath: string): string {
  if (ctx.rel === '') throw new DokuError(`${arg} is the whole docs folder; ignore files or folders inside it.`);
  if (/[*?[]/.test(arg) && !ctx.rel.includes('/')) return ctx.rel;
  const full = path.join(storagePath, ctx.name, ctx.rel);
  const isDir = /[/\\]$/.test(arg) || (fs.existsSync(full) && fs.statSync(full).isDirectory());
  return `/${ctx.rel}${isDir ? '/' : ''}`;
}

function resolveAll(paths: string[], cwd: string, storagePath: string): { name: string; patterns: string[] } {
  const resolved = paths.map((p) => ({ arg: p, ctx: resolveDocsPath(p, cwd, storagePath) }));
  const names = new Set(resolved.map((r) => r.ctx.name));
  if (names.size > 1) throw new DokuError(`Paths belong to different projects: ${[...names].join(', ')}.`);
  return {
    name: resolved[0].ctx.name,
    patterns: resolved.map((r) => patternFor(r.arg, r.ctx, storagePath)),
  };
}

function warnTracked(storagePath: string): void {
  const tracked = applyIgnoresToGit(storagePath);
  if (!tracked.length) return;
  log.warn('These ignored files were already synced, so git keeps syncing them:');
  for (const f of tracked) log.info(`    ${f}`);
  log.info(
    pc.dim(
      `  To stop, run \`git rm --cached <file>\` in ${storagePath} and \`doku sync\`.\n` +
        '  Other machines will then delete their copy on their next sync (it stays in git history).',
    ),
  );
}

export function ignoreCommand(paths: string[], opts: IgnoreOptions = {}): string[] {
  const { storagePath } = requireConfig();
  const cwd = opts.cwd ?? process.cwd();

  if (paths.length === 0) {
    const { name } = currentProject(cwd, storagePath);
    const rules = readRules(path.join(storagePath, name));
    log.info(pc.dim(`${path.join(storagePath, name, IGNORE_FILE)}`));
    if (rules.length === 0) log.info('  nothing ignored');
    for (const r of rules) log.info(`  ${r}`);
    warnTracked(storagePath);
    return rules;
  }

  const { name, patterns } = resolveAll(paths, cwd, storagePath);
  const added = addRules(path.join(storagePath, name), patterns);
  for (const p of patterns) {
    log.ok(added.includes(p) ? `Ignored ${p} in ${name}` : `${p} was already ignored in ${name}`);
  }
  warnTracked(storagePath);
  return added;
}

export function unignoreCommand(paths: string[], opts: IgnoreOptions = {}): string[] {
  const { storagePath } = requireConfig();
  const cwd = opts.cwd ?? process.cwd();
  const { name, patterns } = resolveAll(paths, cwd, storagePath);
  // Accept the pattern with or without its anchoring slash / directory slash.
  const variants = new Set(
    patterns.flatMap((p) => {
      const bare = p.replace(/^\//, '').replace(/\/$/, '');
      return [bare, `/${bare}`, `${bare}/`, `/${bare}/`];
    }),
  );
  const removed = removeRules(path.join(storagePath, name), [...variants]);
  if (removed.length === 0) log.warn(`None of these are in ${name}'s ${IGNORE_FILE}. See \`doku ignore\`.`);
  for (const r of removed) log.ok(`No longer ignored: ${r}`);
  applyIgnoresToGit(storagePath);
  return removed;
}
