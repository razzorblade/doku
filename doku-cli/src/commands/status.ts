import { requireConfig } from '../config.js';
import { CIPHER } from '../crypto.js';
import { applyIgnoresToGit } from '../dokuignore.js';
import { cryptState, readLocalState } from '../encryption.js';
import { isRepoRoot, tryGit } from '../git.js';
import { describeHealth, linkHealth } from '../health.js';
import { log, pc } from '../log.js';
import { linkPathOf, loadLinks } from '../registry.js';
import { originUrl } from './remote.js';

export function statusCommand(): void {
  const { storagePath } = requireConfig();
  const links = loadLinks();

  log.info(pc.bold('Links on this machine'));
  if (links.length === 0) log.info(pc.dim('  none'));
  let problems = 0;
  for (const entry of links) {
    const health = linkHealth(entry, storagePath);
    if (health !== 'ok') problems++;
    log.info(`  ${entry.name.padEnd(24)} ${linkPathOf(entry)}  ${describeHealth(health)}`);
  }
  if (problems) log.warn(`${problems} link(s) need attention. Run \`doku doctor --fix\`.`);

  log.info('');
  log.info(pc.bold('Storage') + pc.dim(`  ${storagePath}`));
  if (!isRepoRoot(storagePath)) {
    log.warn('  not its own git repository; run `doku init` to set it up');
    return;
  }
  const url = originUrl(storagePath);
  log.info(url ? `  remote: ${url}` : pc.dim('  remote: none (`doku remote set <url>` adds one)'));
  const crypt = cryptState(storagePath);
  if (crypt === 'off') log.info(pc.dim('  encryption: off (`doku encrypt` turns it on)'));
  else if (crypt === 'unlocked') log.info(`  encryption: on (${CIPHER}), unlocked on this machine`);
  else log.warn('  encryption: on, LOCKED on this machine: files are still encrypted here. Run `doku unlock`.');
  if (crypt === 'unlocked' && readLocalState(storagePath).replaceRemote) {
    log.warn('  the next `doku sync` replaces the unencrypted history on the remote');
  }
  applyIgnoresToGit(storagePath);
  const status = tryGit(storagePath, ['status', '--short', '--branch']);
  log.info(status.stdout.replace(/^/gm, '  '));
}
