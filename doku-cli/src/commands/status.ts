import { requireConfig } from '../config.js';
import { applyIgnoresToGit } from '../dokuignore.js';
import { isRepoRoot, tryGit } from '../git.js';
import { describeHealth, linkHealth } from '../health.js';
import { log, pc } from '../log.js';
import { linkPathOf, loadLinks } from '../registry.js';

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
  applyIgnoresToGit(storagePath);
  const status = tryGit(storagePath, ['status', '--short', '--branch']);
  log.info(status.stdout.replace(/^/gm, '  '));
}
