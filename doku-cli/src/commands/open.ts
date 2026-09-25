import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { requireConfig } from '../config.js';
import { DokuError } from '../errors.js';
import { assertSegment } from '../paths.js';

/** Absolute storage path, or the path of one project inside it. */
export function storagePathFor(name?: string): string {
  const { storagePath } = requireConfig();
  if (!name) return storagePath;
  assertSegment(name, 'project name');
  const dir = path.join(storagePath, name);
  if (!fs.existsSync(dir)) throw new DokuError(`No project "${name}" in storage ${storagePath}.`);
  return dir;
}

/** Open the system file manager at `file`'s folder, selecting it where supported. */
export function revealInFolder(file: string): void {
  const child =
    process.platform === 'win32'
      ? spawn('explorer.exe', [`/select,"${file}"`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true })
      : process.platform === 'darwin'
        ? spawn('open', ['-R', file], { detached: true, stdio: 'ignore' })
        : spawn('xdg-open', [path.dirname(file)], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

export function openCommand(name?: string): void {
  openInCode(storagePathFor(name));
}

export function openInCode(dir: string): void {
  // `code` is a .cmd shim on Windows, which needs a shell to run.
  const child = spawn('code', [`"${dir}"`], { stdio: 'inherit', shell: true });
  child.on('exit', (code) => {
    if (code) {
      console.error('Could not start VS Code; is `code` on your PATH?');
      process.exitCode = code;
    }
  });
}
