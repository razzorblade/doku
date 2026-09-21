import fs from 'node:fs';
import path from 'node:path';
import { NOTE_FILE, removeAgentsNote } from '../agentsNote.js';
import { requireConfig } from '../config.js';
import { DokuError } from '../errors.js';
import { excludeEntryFor, removeExclude } from '../gitExclude.js';
import { removeLink } from '../link.js';
import { log } from '../log.js';
import { samePath } from '../paths.js';
import { deleteLink, type LinkEntry, linkPathOf, loadLinks } from '../registry.js';
import { projectZipName } from './zip.js';

export interface UnlinkOptions {
  as?: string;
  all?: boolean;
}

/** Match registry entries by project path (if it is one) or by storage name. */
export function findLinks(query: string, linkName?: string): LinkEntry[] {
  const links = loadLinks();
  const asPath = path.resolve(query);
  let matches = links.filter((l) => samePath(l.projectPath, asPath));
  if (matches.length === 0) matches = links.filter((l) => l.name.toLowerCase() === query.toLowerCase());
  if (linkName) matches = matches.filter((l) => l.linkName.toLowerCase() === linkName.toLowerCase());
  return matches;
}

/** Undo everything `applyLink` did in the project. Storage contents are never touched. */
export function unapplyLink(entry: LinkEntry, storagePath?: string): boolean {
  const removed = removeLink(linkPathOf(entry), storagePath);
  if (fs.existsSync(entry.projectPath)) {
    removeExclude(entry.projectPath, excludeEntryFor(entry.projectPath, entry.linkName));
    if (entry.agentsNote && !removeAgentsNote(entry.projectPath, entry.linkName)) {
      removeExclude(entry.projectPath, excludeEntryFor(entry.projectPath, NOTE_FILE));
    }
    // A leftover zip stays hidden until the user deletes it.
    const zipName = projectZipName(entry);
    if (!fs.existsSync(path.join(entry.projectPath, zipName))) {
      removeExclude(entry.projectPath, excludeEntryFor(entry.projectPath, zipName));
    }
  }
  return removed;
}

export function unlinkCommand(query: string, opts: UnlinkOptions): LinkEntry[] {
  const { storagePath } = requireConfig();
  const matches = findLinks(query, opts.as);
  if (matches.length === 0) throw new DokuError(`No doku link found for "${query}". See \`doku list\`.`);
  if (matches.length > 1 && !opts.all) {
    const list = matches.map((m) => `  ${linkPathOf(m)}`).join('\n');
    throw new DokuError(`"${query}" matches several links:\n${list}\nPass a project path, or --all to remove all of them.`);
  }
  for (const entry of matches) {
    const removed = unapplyLink(entry, storagePath);
    deleteLink(entry);
    log.ok(`${removed ? 'Unlinked' : 'Forgot (link was already gone)'} ${linkPathOf(entry)}`);
  }
  log.info(`Docs are kept in ${path.join(storagePath, matches[0].name)}`);
  return matches;
}
