import fs from 'node:fs';
import path from 'node:path';
import { inspectLink } from './link.js';
import { pc } from './log.js';
import { samePath } from './paths.js';
import { type LinkEntry, linkPathOf } from './registry.js';

export type Health = 'ok' | 'missing' | 'broken' | 'mismatch' | 'blocked' | 'project-missing';

export function linkHealth(entry: LinkEntry, storagePath: string): Health {
  if (!fs.existsSync(entry.projectPath)) return 'project-missing';
  const state = inspectLink(linkPathOf(entry));
  if (state.kind === 'missing') return 'missing';
  if (state.kind === 'other') return 'blocked';
  if (!samePath(state.target, path.join(storagePath, entry.name))) return 'mismatch';
  return state.targetExists ? 'ok' : 'broken';
}

const DESCRIPTIONS: Record<Health, string> = {
  ok: pc.green('ok'),
  missing: pc.yellow('link missing'),
  broken: pc.red('broken (storage folder missing)'),
  mismatch: pc.yellow('points to another location'),
  blocked: pc.red('a real folder is in the way'),
  'project-missing': pc.dim('project folder not found'),
};

export function describeHealth(h: Health): string {
  return DESCRIPTIONS[h];
}
