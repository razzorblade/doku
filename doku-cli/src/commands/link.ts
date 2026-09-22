import fs from 'node:fs';
import path from 'node:path';
import { addAgentsNote, NOTE_FILE } from '../agentsNote.js';
import { requireConfig } from '../config.js';
import { DokuError } from '../errors.js';
import { addExclude, excludeEntryFor, isTracked } from '../gitExclude.js';
import { createLink, inspectLink, removeLink } from '../link.js';
import { log, pc } from '../log.js';
import { assertSegment, isInside, normalizeTarget, samePath } from '../paths.js';
import { choose, type Prompter, stdinPrompter } from '../prompt.js';
import { type LinkEntry, linkPathOf, loadLinks, sameLink, upsertLink } from '../registry.js';
import { storageProjects } from './list.js';

export const DEFAULT_LINK_NAME = '.doku';

export interface LinkOptions {
  as?: string;
  agentsNote?: boolean;
  /** Folder that a relative project path is resolved against (default: the current folder). */
  cwd?: string;
  /** Point a link that already goes to other docs in the storage at these ones instead of failing. */
  replace?: boolean;
}

export interface CliLinkOptions extends LinkOptions {
  prompter?: Prompter;
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

function isDir(p: string): boolean {
  return fs.existsSync(p) && fs.statSync(p).isDirectory();
}

function projectPathFor(project: string | undefined, opts: LinkOptions, storagePath: string): string {
  const projectPath = path.resolve(opts.cwd ?? process.cwd(), project ?? '.');
  if (!isDir(projectPath)) throw new DokuError(`Project folder ${projectPath} does not exist.`);
  if (isInside(projectPath, storagePath)) {
    throw new DokuError(
      project
        ? `${projectPath} is inside the doku storage ${storagePath}; link a project folder outside it.`
        : `You are inside the doku storage. Pass the project folder: \`doku link <projectPath> [name]\`.`,
    );
  }
  return projectPath;
}

/** The link this machine has for the project under `linkName`, if any. */
function registered(projectPath: string, linkName: string): LinkEntry | undefined {
  return loadLinks().find((l) => sameLink(l, { projectPath, linkName }));
}

/** Name of the docs a link points at, when that is a project folder directly in the storage. */
function linkedDocsName(linkPath: string, storagePath: string): string | null {
  const state = inspectLink(linkPath);
  if (state.kind !== 'link') return null;
  const rel = path.relative(normalizeTarget(storagePath), state.target);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.includes(path.sep) ? rel : null;
}

/** Remove docs `doku link` created but nobody used: just the untouched starter README, linked nowhere. */
function removeIfUnused(name: string, storagePath: string): boolean {
  const dir = path.join(storagePath, name);
  if (!isDir(dir) || loadLinks().some((l) => l.name.toLowerCase() === name.toLowerCase())) return false;
  const files = fs.readdirSync(dir);
  const untouched =
    files.length === 0 ||
    (files.length === 1 &&
      files[0] === 'README.md' &&
      fs.readFileSync(path.join(dir, 'README.md'), 'utf8') === starterReadme(name));
  if (untouched) fs.rmSync(dir, { recursive: true, force: true });
  return untouched;
}

export function linkCommand(project: string | undefined, name: string | undefined, opts: LinkOptions): LinkEntry {
  const { storagePath } = requireConfig();
  const projectPath = projectPathFor(project, opts, storagePath);
  const linkName = opts.as ?? DEFAULT_LINK_NAME;
  const entry: LinkEntry = {
    // Re-running `doku link` in a linked project keeps the docs it is linked to.
    name: name ?? registered(projectPath, linkName)?.name ?? path.basename(projectPath),
    projectPath,
    linkName,
    agentsNote: opts.agentsNote ?? true,
  };
  assertSegment(entry.name, 'project name');
  assertSegment(entry.linkName, 'link name');

  const target = path.join(storagePath, entry.name);
  const linkPath = linkPathOf(entry);
  const previous = linkedDocsName(linkPath, storagePath);
  const switching = previous !== null && !samePath(path.join(storagePath, previous), target);
  if (switching && !opts.replace) {
    throw new DokuError(
      `${linkPath} is already linked to the docs "${previous}". To switch, run \`doku link ${entry.name}\` in the project.`,
    );
  }
  if (!fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'README.md'), starterReadme(entry.name));
    log.ok(`Created storage folder ${target}`);
  }

  if (switching) removeLink(linkPath, storagePath);
  const { created, excluded } = applyLink(entry, storagePath);
  upsertLink(entry);

  if (switching) {
    log.ok(`Switched ${linkPath} from the docs "${previous}" to "${entry.name}" (${target})`);
    if (removeIfUnused(previous, storagePath)) log.ok(`Removed the unused, empty docs "${previous}" from the storage`);
    else log.info(pc.dim(`  The docs "${previous}" stay in the storage.`));
  } else {
    log.ok(`${created ? 'Linked' : 'Already linked'} ${linkPath} → ${target}`);
  }
  if (excluded) log.ok('Hidden from git via .git/info/exclude');
  else log.warn('Project is not a git repository; nothing excluded.');
  if (entry.agentsNote) log.ok(`Added a note for AI assistants to ${NOTE_FILE}`);
  return entry;
}

/** The storage project called `name`: the exact spelling first, then ignoring case. */
function findDocs(projects: string[], name: string): string | undefined {
  return projects.find((p) => p === name) ?? projects.find((p) => p.toLowerCase() === name.toLowerCase());
}

/**
 * Docs to link a project that is not linked yet to, when the storage has none under its folder
 * name but has docs not linked on this machine: e.g. after `doku init --clone` on a machine where
 * the project folder is named differently. Undefined means new docs under the folder name.
 */
async function pickDocs(projectPath: string, projects: string[], opts: CliLinkOptions): Promise<string | undefined> {
  const own = path.basename(projectPath);
  if (registered(projectPath, opts.as ?? DEFAULT_LINK_NAME) || findDocs(projects, own)) return undefined;
  const links = loadLinks();
  const unlinked = projects.filter((p) => !links.some((l) => l.name.toLowerCase() === p.toLowerCase()));
  if (!unlinked.length) return undefined;
  if (!opts.prompter && !process.stdin.isTTY) {
    log.info(pc.dim(`If this project's docs are in the storage under another name, run \`doku link <name>\` here to switch.`));
    return undefined;
  }
  const p = opts.prompter ?? stdinPrompter();
  try {
    const choices = unlinked.map((name, i) => ({ key: String(i + 1), value: name, label: name }));
    choices.push({ key: 'n', value: own, label: `new, empty docs named "${own}"` });
    return await choose(p, `The storage has no docs named "${own}". Link existing docs to this project, or start new ones?`, choices, own);
  } finally {
    if (!opts.prompter) p.close();
  }
}

/**
 * `doku link` as typed. A single argument that is no folder but names docs in the storage links
 * the current folder to those docs. Without a name, existing docs are offered before new ones are
 * created. A project linked to other docs is switched over.
 */
export async function linkFromCli(project: string | undefined, name: string | undefined, opts: CliLinkOptions): Promise<LinkEntry> {
  const { storagePath } = requireConfig();
  const projects = storageProjects(storagePath);
  const cwd = opts.cwd ?? process.cwd();
  if (project !== undefined && name === undefined && !isDir(path.resolve(cwd, project))) {
    const docs = findDocs(projects, project);
    if (!docs) {
      throw new DokuError(
        `${path.resolve(cwd, project)} is not a folder, and the storage has no docs named "${project}" (\`doku list\` shows them).`,
      );
    }
    return linkCommand(undefined, docs, { ...opts, replace: true });
  }
  const projectPath = projectPathFor(project, opts, storagePath);
  const docs = name === undefined ? await pickDocs(projectPath, projects, opts) : (findDocs(projects, name) ?? name);
  return linkCommand(projectPath, docs, { ...opts, replace: true });
}
