import fs from 'node:fs';
import path from 'node:path';
import { defaultStoragePath, loadConfig, saveConfig } from '../config.js';
import { DokuError } from '../errors.js';
import { git, gitInteractive, isRepoRoot, tryGit } from '../git.js';
import { log } from '../log.js';
import { assertLocalPath, samePath } from '../paths.js';

export interface InitOptions {
  storage?: string;
  clone?: string;
}

/** The storage always uses `main`, whatever git's init.defaultBranch is on this machine. */
export const STORAGE_BRANCH = 'main';

const STORAGE_README =`# doku storage

Private per-project working docs. One folder per project; each folder is linked
into its project as \`.doku/\` by \`doku link\`.

Sync between machines with \`doku sync\` (commit, pull --rebase, push).
`;

export function initCommand(opts: InitOptions): string {
  const previous = loadConfig();
  // Re-running `doku init` keeps the configured storage unless another one is given.
  const storagePath = path.resolve(opts.storage ?? previous?.storagePath ?? defaultStoragePath());
  assertLocalPath(storagePath, 'Storage path');

  if (opts.clone) {
    if (fs.existsSync(storagePath) && fs.readdirSync(storagePath).length > 0) {
      throw new DokuError(`Cannot clone into ${storagePath}: the folder is not empty.`);
    }
    fs.mkdirSync(path.dirname(storagePath), { recursive: true });
    log.step(`git clone ${opts.clone}`);
    if (!gitInteractive(path.dirname(storagePath), ['clone', opts.clone, storagePath])) {
      throw new DokuError('git clone failed (see output above).');
    }
  } else {
    fs.mkdirSync(storagePath, { recursive: true });
    if (!isRepoRoot(storagePath)) {
      git(storagePath, ['init', '-q', '-b', STORAGE_BRANCH]);
      log.ok(`Initialized git repository in ${storagePath} (branch ${STORAGE_BRANCH})`);
    } else if (!tryGit(storagePath, ['rev-parse', '--verify', '-q', 'HEAD']).ok) {
      // No commits yet: safe to move an unborn default branch (e.g. master) to main.
      git(storagePath, ['symbolic-ref', 'HEAD', `refs/heads/${STORAGE_BRANCH}`]);
    }
    const readme = path.join(storagePath, 'README.md');
    if (!fs.existsSync(readme)) fs.writeFileSync(readme, STORAGE_README);
  }

  if (previous && !samePath(previous.storagePath, storagePath)) {
    log.warn(`Storage changed from ${previous.storagePath}. Run \`doku doctor --fix\` to repoint existing links.`);
  }
  saveConfig({ storagePath });
  log.ok(`Storage: ${storagePath}`);
  return storagePath;
}
