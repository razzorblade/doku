import fs from 'node:fs';
import path from 'node:path';
import { addAgentsNote, NOTE_FILE } from '../agentsNote.js';
import { requireConfig } from '../config.js';
import { DokuError } from '../errors.js';
import { addExclude, excludeEntryFor, isTracked } from '../gitExclude.js';
import { createLink } from '../link.js';
import { log } from '../log.js';
import { assertSegment, isInside } from '../paths.js';
import { type LinkEntry, linkPathOf, upsertLink } from '../registry.js';

export const DEFAULT_LINK_NAME = '.doku';

export interface LinkOptions {
  as?: string;
  agentsNote?: boolean;
}

function starterReadme(name: string): string {
  return `# ${name}\n\nPrivate working docs for ${name}: architecture, decisions, task notes, client notes.\nLinked into the project by doku; not part of the project's git.\n`;
}

/** Apply everything a link needs inside the project (link, git exclude, agents note). Idempotent. */
export function applyLink(entry: LinkEntry, storagePath: string): { created: boolean; excluded: boolean } {
  const target = path.join(storagePath, entry.name);
  const created = createLink(target, linkPathOf(entry));
  const excluded = addExclude(entry.projectPath, excludeEntryFor(entry.projectPath, entry.linkName));
  if (entry.agentsNote) {
    addAgentsNote(entry.projectPath, entry.linkName);
    if (excluded && !isTracked(entry.projectPath, NOTE_FILE)) {
      addExclude(entry.projectPath, excludeEntryFor(entry.projectPath, NOTE_FILE));
    }
  }
  return { created, excluded };
}

export function linkCommand(project: string | undefined, name: string | undefined, opts: LinkOptions): LinkEntry {
  const { storagePath } = requireConfig();
  const projectPath = path.resolve(project ?? process.cwd());
  if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
    throw new DokuError(`Project folder ${projectPath} does not exist.`);
  }
  if (isInside(projectPath, storagePath)) {
    throw new DokuError(
      project
        ? `${projectPath} is inside the doku storage ${storagePath}; link a project folder outside it.`
        : `You are inside the doku storage. Pass the project folder: \`doku link <projectPath> [name]\`.`,
    );
  }
  const entry: LinkEntry = {
    name: name ?? path.basename(projectPath),
    projectPath,
    linkName: opts.as ?? DEFAULT_LINK_NAME,
    agentsNote: opts.agentsNote ?? true,
  };
  assertSegment(entry.name, 'project name');
  assertSegment(entry.linkName, 'link name');

  const target = path.join(storagePath, entry.name);
  if (!fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'README.md'), starterReadme(entry.name));
    log.ok(`Created storage folder ${target}`);
  }

  const { created, excluded } = applyLink(entry, storagePath);
  upsertLink(entry);

  log.ok(`${created ? 'Linked' : 'Already linked'} ${linkPathOf(entry)} → ${target}`);
  if (excluded) log.ok('Hidden from git via .git/info/exclude');
  else log.warn('Project is not a git repository; nothing excluded.');
  if (entry.agentsNote) log.ok(`Added a note for AI assistants to ${NOTE_FILE}`);
  return entry;
}
