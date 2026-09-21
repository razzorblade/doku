import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DokuError } from './errors.js';

export interface Config {
  storagePath: string;
}

/** Per-machine state directory. Overridable with DOKU_HOME (used by tests). */
export function dokuHome(): string {
  return process.env.DOKU_HOME ?? path.join(os.homedir(), '.doku');
}

function configFile(): string {
  return path.join(dokuHome(), 'config.json');
}

/** `doku-storage/` next to the `doku-cli/` package (works from both src/ and dist/). */
export function defaultStoragePath(): string {
  return fileURLToPath(new URL('../../doku-storage', import.meta.url));
}

export function loadConfig(): Config | null {
  try {
    return JSON.parse(fs.readFileSync(configFile(), 'utf8')) as Config;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new DokuError(`Cannot read ${configFile()}: ${(err as Error).message}`);
  }
}

export function requireConfig(): Config {
  const config = loadConfig();
  if (!config) throw new DokuError('doku is not initialized on this machine. Run `doku init` first.');
  return config;
}

export function saveConfig(config: Config): void {
  fs.mkdirSync(dokuHome(), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(config, null, 2) + '\n');
}
