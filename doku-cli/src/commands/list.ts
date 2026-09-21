import fs from 'node:fs';
import { requireConfig } from '../config.js';
import { log, pc } from '../log.js';
import { linkPathOf, loadLinks } from '../registry.js';

export function storageProjects(storagePath: string): string[] {
  if (!fs.existsSync(storagePath)) return [];
  return fs
    .readdirSync(storagePath, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));
}

export function listCommand(): void {
  const { storagePath } = requireConfig();
  const projects = storageProjects(storagePath);
  const links = loadLinks();
  log.info(pc.dim(`Storage: ${storagePath}`));
  if (projects.length === 0) {
    log.info('No projects in storage yet. Create one with `doku link <projectPath> [name]`.');
  }
  for (const name of projects) {
    const mine = links.filter((l) => l.name === name);
    const where = mine.length ? mine.map((l) => linkPathOf(l)).join(', ') : pc.dim('not linked on this machine');
    log.info(`  ${pc.bold(name)}  ${where}`);
  }
  for (const orphan of links.filter((l) => !projects.includes(l.name))) {
    log.warn(`${orphan.name} is linked at ${linkPathOf(orphan)} but missing from storage (sync or \`doku doctor\`).`);
  }
}
