import fs from 'node:fs';
import path from 'node:path';
import { dokuHome } from './config.js';
import { DokuError } from './errors.js';
import { samePath } from './paths.js';

/**
 * One link on this machine. The registry is per-machine because project paths
 * differ between PCs; it never lives in the (synced) storage.
 */
export interface LinkEntry {
  name: string;
  projectPath: string;
  linkName: string;
  agentsNote: boolean;
}

function registryFile(): string {
  return path.join(dokuHome(), 'links.json');
}

export function loadLinks(): LinkEntry[] {
  try {
    return JSON.parse(fs.readFileSync(registryFile(), 'utf8')) as LinkEntry[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new DokuError(`Cannot read ${registryFile()}: ${(err as Error).message}`);
  }
}

export function saveLinks(links: LinkEntry[]): void {
  fs.mkdirSync(dokuHome(), { recursive: true });
  const sorted = [...links].sort((a, b) => a.name.localeCompare(b.name) || a.projectPath.localeCompare(b.projectPath));
  fs.writeFileSync(registryFile(), JSON.stringify(sorted, null, 2) + '\n');
}

export function sameLink(a: Pick<LinkEntry, 'projectPath' | 'linkName'>, b: Pick<LinkEntry, 'projectPath' | 'linkName'>) {
  return samePath(a.projectPath, b.projectPath) && a.linkName.toLowerCase() === b.linkName.toLowerCase();
}

export function upsertLink(entry: LinkEntry): void {
  const links = loadLinks().filter((l) => !sameLink(l, entry));
  links.push(entry);
  saveLinks(links);
}

export function deleteLink(entry: LinkEntry): void {
  saveLinks(loadLinks().filter((l) => !sameLink(l, entry)));
}

export function linkPathOf(entry: Pick<LinkEntry, 'projectPath' | 'linkName'>): string {
  return path.join(entry.projectPath, entry.linkName);
}
