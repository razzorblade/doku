import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dokuHome } from './config.js';
import { DokuError } from './errors.js';
import { assertSegment, samePath } from './paths.js';

/** Folder in the storage holding the kits, one subfolder each. Hidden from `doku list` like any dot-folder. */
export const KITS_DIR = '.kits';

/**
 * One kit copied into one project folder on this machine. Per machine, like the link
 * registry: every machine has its own copies of the files, made at its own time.
 */
export interface KitEntry {
  kit: string;
  projectPath: string;
  /**
   * Posix path in the project → sha256 of the kit's version of that file the project was
   * last brought up to, or that the user chose to keep their own file over. A file whose
   * hash still matches is unchanged in the project; a kit file whose hash differs is new.
   */
  files: Record<string, string>;
}

function kitsFile(): string {
  return path.join(dokuHome(), 'kits.json');
}

export function loadKitEntries(): KitEntry[] {
  try {
    return JSON.parse(fs.readFileSync(kitsFile(), 'utf8')) as KitEntry[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new DokuError(`Cannot read ${kitsFile()}: ${(err as Error).message}`);
  }
}

function saveKitEntries(entries: KitEntry[]): void {
  fs.mkdirSync(dokuHome(), { recursive: true });
  const sorted = [...entries].sort((a, b) => a.kit.localeCompare(b.kit) || a.projectPath.localeCompare(b.projectPath));
  fs.writeFileSync(kitsFile(), JSON.stringify(sorted, null, 2) + '\n');
}

export function sameKitEntry(a: Pick<KitEntry, 'kit' | 'projectPath'>, b: Pick<KitEntry, 'kit' | 'projectPath'>): boolean {
  return samePath(a.projectPath, b.projectPath) && a.kit.toLowerCase() === b.kit.toLowerCase();
}

export function upsertKitEntry(entry: KitEntry): void {
  const entries = loadKitEntries().filter((e) => !sameKitEntry(e, entry));
  entries.push(entry);
  saveKitEntries(entries);
}

export function deleteKitEntry(entry: Pick<KitEntry, 'kit' | 'projectPath'>): void {
  saveKitEntries(loadKitEntries().filter((e) => !sameKitEntry(e, entry)));
}

export function kitDir(storagePath: string, name: string): string {
  assertSegment(name, 'kit name');
  return path.join(storagePath, KITS_DIR, name);
}

export function storageKits(storagePath: string): string[] {
  const dir = path.join(storagePath, KITS_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));
}

export function hashOf(data: Uint8Array): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Every file below `dir`, as posix path → content. Links (junctions too) and `.git` are skipped. */
export function readTree(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (abs: string, rel: string) => {
    for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
      if (d.name === '.git' || d.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(path.join(abs, d.name), childRel);
      else if (d.isFile()) out.set(childRel, fs.readFileSync(path.join(abs, d.name)));
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return new Map([...out].sort(([a], [b]) => a.localeCompare(b)));
}
