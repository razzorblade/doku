import fs from 'node:fs';
import path from 'node:path';
import { requireConfig } from '../config.js';
import { cryptState, filtersInstalled, installFilters } from '../encryption.js';
import { isRepoRoot } from '../git.js';
import { describeHealth, linkHealth } from '../health.js';
import { deleteKitEntry, loadKitEntries } from '../kits.js';
import { removeLink } from '../link.js';
import { log } from '../log.js';
import { deleteLink, linkPathOf, loadLinks } from '../registry.js';
import { applyLink } from './link.js';

export interface DoctorOptions {
  fix?: boolean;
  prune?: boolean;
}

/**
 * Check every registered link and, with --fix, re-create what is missing or points
 * to an old storage location (e.g. after moving the storage or re-cloning a project).
 */
export function doctorCommand(opts: DoctorOptions): number {
  const { storagePath } = requireConfig();
  let remaining = 0;

  if (!fs.existsSync(storagePath)) {
    log.error(`Storage folder ${storagePath} does not exist. Run \`doku init\`.`);
    return 1;
  }

  for (const entry of loadLinks()) {
    const health = linkHealth(entry, storagePath);
    const label = `${entry.name} at ${linkPathOf(entry)}`;

    if (health === 'project-missing') {
      if (opts.prune) {
        deleteLink(entry);
        log.ok(`Forgot ${label} (project folder is gone)`);
      } else {
        log.warn(`${label}: ${describeHealth(health)}. Use --prune to forget it.`);
        remaining++;
      }
      continue;
    }

    if (health === 'ok' && !opts.fix) continue;
    // A real folder in the way is never touched automatically.
    if (health === 'blocked' || !opts.fix) {
      log.warn(`${label}: ${describeHealth(health)}`);
      remaining++;
      continue;
    }

    // --fix: recreate storage folder if needed, replace stale links, re-apply excludes and notes.
    fs.mkdirSync(path.join(storagePath, entry.name), { recursive: true });
    if (health === 'mismatch' || health === 'broken') removeLink(linkPathOf(entry));
    applyLink(entry, storagePath);
    log.ok(health === 'ok' ? `${label}: ok` : `${label}: repaired`);
  }

  for (const entry of loadKitEntries()) {
    if (fs.existsSync(entry.projectPath)) continue;
    const label = `kit "${entry.kit}" at ${entry.projectPath}`;
    if (opts.prune) {
      deleteKitEntry(entry);
      log.ok(`Forgot ${label} (project folder is gone)`);
    } else {
      log.warn(`${label}: project folder is missing. Use --prune to forget it.`);
      remaining++;
    }
  }

  // Encryption: git must run this doku as the filter (its path changes when doku-cli moves).
  if (isRepoRoot(storagePath) && cryptState(storagePath) === 'unlocked' && !filtersInstalled(storagePath)) {
    if (opts.fix) {
      installFilters(storagePath);
      log.ok('Encryption filter: repaired');
    } else {
      log.warn('Encryption filter: git is not set up to run this doku (e.g. doku-cli was moved)');
      remaining++;
    }
  }

  if (remaining === 0) log.ok('All links healthy');
  else if (!opts.fix) log.info('Run `doku doctor --fix` to repair.');
  return remaining ? 1 : 0;
}
