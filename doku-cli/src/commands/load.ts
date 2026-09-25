import fs from 'node:fs';
import path from 'node:path';
import { dokuHome, requireConfig } from '../config.js';
import { keyIdHex, type StorageKey } from '../crypto.js';
import { applyIgnoresToGit } from '../dokuignore.js';
import { askForKey, CRYPT_FILE, cryptState, keyFromFile, readKey } from '../encryption.js';
import { DokuError } from '../errors.js';
import { isRepoRoot } from '../git.js';
import { log, pc } from '../log.js';
import { assertSegment } from '../paths.js';
import { choose, confirm, type Prompter, stdinPrompter } from '../prompt.js';
import { type LinkEntry, loadLinks } from '../registry.js';
import { docsContextOf, projectAt } from '../resolve.js';
import { openEncryptedZip, readZip, type ZipContents } from '../zip.js';
import { linkCommand } from './link.js';

export interface LoadOptions {
  /** Storage project to load into, instead of the one named in the zip. For a whole-storage zip: the one project to load from it. */
  project?: string;
  /** Existing project: add new files, keep existing ones that differ. */
  merge?: boolean;
  /** Existing project: add new files, replace ones that differ (after backing them up). */
  overwrite?: boolean;
  /** Project folder to link a not yet linked project into; false to not offer it. */
  link?: string | false;
  /** Whole-storage zip: load every project in it without asking which. */
  all?: boolean;
  /** Create missing projects without asking. */
  yes?: boolean;
  /** Encrypted zip: file with the recovery key (instead of asking). */
  keyFile?: string;
  cwd?: string;
  prompter?: Prompter;
}

export interface LoadResult {
  name: string;
  created: boolean;
  added: string[];
  overwritten: string[];
  /** Differing files left as they were (merge). */
  kept: string[];
  unchanged: string[];
  /** Paths that could not be written safely (a folder or link in the way). */
  blocked: string[];
  backup?: string;
  linked?: LinkEntry;
}

interface Plan {
  added: string[];
  conflicts: string[];
  unchanged: string[];
  blocked: string[];
}

export function destOf(dir: string, rel: string): string {
  return path.join(dir, ...rel.split('/'));
}

/** False when a parent of `rel` inside `dir` is a file or a link (writing there could escape `dir`). */
export function parentsWritable(dir: string, rel: string): boolean {
  let p = dir;
  for (const seg of rel.split('/').slice(0, -1)) {
    p = path.join(p, seg);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch {
      return true; // the rest gets created
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return false;
  }
  return true;
}

/** Compare the zip's files with `dir` without touching anything. */
function planFiles(dir: string, files: Map<string, Uint8Array>): Plan {
  const plan: Plan = { added: [], conflicts: [], unchanged: [], blocked: [] };
  for (const [rel, data] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    if (!parentsWritable(dir, rel)) {
      plan.blocked.push(rel);
      continue;
    }
    let st: fs.Stats | undefined;
    try {
      st = fs.lstatSync(destOf(dir, rel));
    } catch {
      plan.added.push(rel);
      continue;
    }
    if (!st.isFile()) plan.blocked.push(rel);
    else if (Buffer.from(data).equals(fs.readFileSync(destOf(dir, rel)))) plan.unchanged.push(rel);
    else plan.conflicts.push(rel);
  }
  return plan;
}

function writeFiles(dir: string, rels: string[], files: Map<string, Uint8Array>, replace: boolean): void {
  for (const rel of rels) {
    const dest = destOf(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // 'wx' fails instead of replacing a file that appeared since the plan was made.
    fs.writeFileSync(dest, files.get(rel)!, { flag: replace ? 'w' : 'wx' });
  }
}

/** Copy the files about to be replaced to ~/.doku/backups/, outside the storage. */
export function backupFiles(dir: string, rels: string[], name: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(dokuHome(), 'backups', `${name}-${stamp}`);
  for (const rel of rels) {
    const dest = destOf(backup, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(destOf(dir, rel), dest, fs.constants.COPYFILE_EXCL);
  }
  return backup;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function signed(n: number): string {
  return n > 0 ? pc.green(`+${n}`) : n < 0 ? pc.red(String(n)) : pc.dim('±0');
}

/** Text stats for a file, or null for binary content. */
function textStats(data: Uint8Array): { lines: number; chars: number } | null {
  if (data.includes(0)) return null;
  const text = Buffer.from(data).toString('utf8');
  const lines = text === '' ? 0 : text.split(/\r?\n/).length - (/\r?\n$/.test(text) ? 1 : 0);
  return { lines, chars: [...text].length };
}

/** One line describing how a file changes: lines, characters and size, storage version → zip version. */
export function describeChange(before: Uint8Array, after: Uint8Array): string {
  const parts: string[] = [];
  const a = textStats(before);
  const b = textStats(after);
  if (a && b) {
    parts.push(`${a.lines} → ${b.lines} lines (${signed(b.lines - a.lines)})`);
    parts.push(`${a.chars} → ${b.chars} chars (${signed(b.chars - a.chars)})`);
  }
  parts.push(`${formatSize(before.length)} → ${formatSize(after.length)} (${signed(after.length - before.length)} B)`);
  return parts.join(', ');
}

/** Changes of the differing files, storage version → zip version. */
function changeReport(dir: string, rels: string[], files: Map<string, Uint8Array>, max = 20): string {
  const shown = rels.slice(0, max).map((rel) => `    ${rel}  ${pc.dim(describeChange(fs.readFileSync(destOf(dir, rel)), files.get(rel)!))}`);
  if (rels.length > max) shown.push(pc.dim(`    … and ${rels.length - max} more`));
  return shown.join('\n');
}

function totalSize(rels: string[], files: Map<string, Uint8Array>): string {
  return formatSize(rels.reduce((sum, rel) => sum + files.get(rel)!.length, 0));
}

function preview(rels: string[], max = 5): string {
  const shown = rels.slice(0, max).map((r) => `    ${r}`);
  if (rels.length > max) shown.push(pc.dim(`    … and ${rels.length - max} more`));
  return shown.join('\n');
}

/** Which storage project a single-project zip goes into. Null when the user gave no name. */
async function pickName(zip: ZipContents, zipPath: string, opts: LoadOptions, cwd: string, p: Prompter) {
  if (opts.project) {
    assertSegment(opts.project, 'project name');
    if (zip.meta?.name && zip.meta.name !== opts.project) {
      log.info(`The zip holds docs of "${zip.meta.name}"; loading them into "${opts.project}" as requested.`);
    }
    return opts.project;
  }
  if (zip.meta?.name) {
    assertSegment(zip.meta.name, 'project name in the zip');
    log.info(`The zip holds docs of project "${zip.meta.name}".`);
    return zip.meta.name;
  }

  const base = path.basename(zipPath).replace(/(\.doku)?\.zip$/i, '');
  const candidates = [zip.topFolder, base.startsWith('.') ? undefined : base, projectAt(cwd)?.name];
  const guess = candidates.find((c) => {
    if (!c) return false;
    try {
      assertSegment(c, 'project name');
      return true;
    } catch {
      return false;
    }
  });
  log.info('The zip has no doku metadata, so it does not say which project it belongs to.');
  if (opts.yes && guess) return guess;
  for (;;) {
    const answer = await p.ask(`Storage project to load it into${guess ? ` [${guess}]` : ''}: `);
    if (answer === null) return guess ?? null;
    const name = answer.trim() || guess;
    if (!name) continue;
    try {
      assertSegment(name, 'project name');
      return name;
    } catch (err) {
      log.warn((err as Error).message);
    }
  }
}

/** Put `files` into storage/<name>, asking before creating the project or touching existing files. */
async function loadInto(
  name: string,
  files: Map<string, Uint8Array>,
  storagePath: string,
  opts: LoadOptions,
  p: Prompter,
): Promise<LoadResult | null> {
  const dir = path.join(storagePath, name);
  let exists = false;
  try {
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new DokuError(`${dir} exists but is not a folder. Refusing to load into it.`);
    exists = true;
  } catch (err) {
    if (err instanceof DokuError) throw err;
  }

  const plan = planFiles(dir, files);
  const result: LoadResult = { name, created: false, added: [], overwritten: [], kept: [], unchanged: plan.unchanged, blocked: plan.blocked };
  if (plan.blocked.length) {
    log.warn(`${plan.blocked.length} file(s) can't be written because a folder or link is in the way; they are skipped:\n${preview(plan.blocked)}`);
  }

  if (!exists) {
    log.info(`There is no project "${name}" in the storage yet.`);
    const ok = opts.yes || (await confirm(p, `Create storage project "${name}" with ${plan.added.length} file(s)?`));
    if (!ok) {
      log.warn('Cancelled; nothing was written. Pick another project with `--project <name>`.');
      return null;
    }
    fs.mkdirSync(dir);
    writeFiles(dir, plan.added, files, false);
    log.ok(`Created ${dir} with ${plan.added.length} file(s) (${totalSize(plan.added, files)})`);
    return { ...result, created: true, added: plan.added };
  }

  log.info(
    `Storage project "${name}" already exists: ${plan.added.length} new, ${plan.conflicts.length} different, ` +
      `${plan.unchanged.length} identical file(s).`,
  );
  if (!plan.added.length && !plan.conflicts.length) {
    log.ok('Nothing to load; the project already has these files.');
    return result;
  }
  if (plan.added.length) log.info(`New (${totalSize(plan.added, files)}):\n${preview(plan.added)}`);
  // Computed before anything is written, so the numbers compare the storage version with the zip's.
  const report = plan.conflicts.length ? changeReport(dir, plan.conflicts, files) : '';
  if (report) log.info(`Different (storage → zip):\n${report}`);

  let mode: 'merge' | 'overwrite' | 'cancel';
  if (opts.overwrite) mode = 'overwrite';
  else if (opts.merge) mode = 'merge';
  else if (!plan.conflicts.length) mode = (await confirm(p, `Add ${plan.added.length} new file(s) to "${name}"?`)) ? 'merge' : 'cancel';
  else {
    mode = await choose(
      p,
      `How should the zip be loaded into "${name}"? No files are deleted either way.`,
      [
        { key: 'a', value: 'merge', label: `append: add ${plan.added.length} new file(s), keep the ${plan.conflicts.length} existing one(s) as they are` },
        {
          key: 'o',
          value: 'overwrite',
          label: `overwrite: add new files and replace the ${plan.conflicts.length} different one(s) (backed up first)`,
        },
        { key: 'c', value: 'cancel', label: 'cancel: change nothing' },
      ],
      'cancel',
    );
  }
  if (mode === 'cancel') {
    log.warn('Cancelled; nothing was written.');
    return null;
  }

  if (mode === 'overwrite' && plan.conflicts.length) {
    result.backup = backupFiles(dir, plan.conflicts, name);
    log.ok(`Backed up ${plan.conflicts.length} file(s) to ${result.backup}`);
    writeFiles(dir, plan.conflicts, files, true);
    result.overwritten = plan.conflicts;
  } else {
    result.kept = plan.conflicts;
  }
  writeFiles(dir, plan.added, files, false);
  result.added = plan.added;

  log.ok(`Loaded into ${dir}: ${result.added.length} added, ${result.overwritten.length} replaced`);
  if (result.added.length) log.info(`  Added (${totalSize(result.added, files)}):\n${preview(result.added, 20)}`);
  if (result.overwritten.length) log.info(`  Replaced (old → new):\n${report}`);
  if (result.kept.length) log.info(`  Kept ${result.kept.length} existing file(s); run again with --overwrite to replace them.`);
  return result;
}

/** Offer to link a project that has no link on this machine. Never fails the load. */
async function offerLink(name: string, opts: LoadOptions, cwd: string, p: Prompter): Promise<LinkEntry | undefined> {
  if (opts.link === false) return undefined;
  const later = `Link it later with \`doku link <projectPath> ${name}\`.`;
  if (typeof opts.link === 'string') {
    try {
      return linkCommand(path.resolve(cwd, opts.link), name, {});
    } catch (err) {
      if (!(err instanceof DokuError)) throw err;
      throw new DokuError(`The docs were loaded, but linking failed: ${err.message} ${later}`);
    }
  }
  if (loadLinks().some((l) => l.name === name)) return undefined;

  log.info(`"${name}" is not linked into any project folder on this machine.`);
  for (;;) {
    const answer = await p.ask(`Project folder to link it into (Enter to skip, . for the current folder): `);
    const folder = answer?.trim();
    if (!folder) {
      log.info(later);
      return undefined;
    }
    try {
      return linkCommand(path.resolve(cwd, folder), name, {});
    } catch (err) {
      if (!(err instanceof DokuError)) throw err;
      log.warn(err.message);
    }
  }
}

/** Split a whole-storage zip into its projects and the files at the storage root. */
function splitStorageZip(zip: ZipContents) {
  const groups = new Map<string, Map<string, Uint8Array>>();
  const rootFiles = new Map<string, Uint8Array>();
  for (const [rel, data] of zip.files) {
    const slash = rel.indexOf('/');
    const top = slash === -1 ? '' : rel.slice(0, slash);
    if (!top || top.startsWith('.')) {
      if (rel !== CRYPT_FILE) rootFiles.set(rel, data);
      continue;
    }
    if (!groups.has(top)) groups.set(top, new Map());
    groups.get(top)!.set(rel.slice(slash + 1), data);
  }
  return { groups: new Map([...groups].sort(([a], [b]) => a.localeCompare(b))), rootFiles };
}

/**
 * Which projects of a whole-storage zip to load: `--project`, `--all`, or ask
 * (offering just the project we're in, when the zip has it). Null = cancelled.
 */
async function pickStorageProjects(names: string[], opts: LoadOptions, cwd: string, storagePath: string, p: Prompter) {
  if (opts.project) {
    if (!names.includes(opts.project)) {
      throw new DokuError(`The zip has no project "${opts.project}". It holds: ${names.join(', ')}.`);
    }
    return [opts.project];
  }
  if (opts.all) return names;

  const here = docsContextOf(cwd, storagePath)?.name ?? projectAt(cwd)?.name;
  if (here && names.includes(here)) {
    const pick = await choose(
      p,
      `You are in project "${here}". What should be loaded?`,
      [
        { key: 'p', value: 'project', label: `only "${here}"` },
        { key: 'a', value: 'all', label: `all ${names.length} project(s)` },
        { key: 'c', value: 'cancel', label: 'cancel: change nothing' },
      ],
      'cancel',
    );
    return pick === 'project' ? [here] : pick === 'all' ? names : null;
  }
  return (await confirm(p, `Load all ${names.length} project(s) from it?`)) ? names : null;
}

/**
 * A whole-storage zip: each chosen project goes through the same questions as a
 * single-project zip. Root files are only loaded with all projects, and only ever added.
 */
async function loadStorageZip(zip: ZipContents, storagePath: string, opts: LoadOptions, cwd: string, p: Prompter) {
  const { groups, rootFiles } = splitStorageZip(zip);
  const names = [...groups.keys()];
  log.info(`The zip holds the whole storage: ${names.length} project(s) (${names.join(', ')}).`);
  const selected = await pickStorageProjects(names, opts, cwd, storagePath, p);
  if (!selected) {
    log.warn('Cancelled; nothing was written. Pick one project with `--project <name>`, or all with `--all`.');
    return [];
  }
  if (typeof opts.link === 'string' && selected.length > 1) {
    throw new DokuError('--link needs a single project; add `--project <name>`, or link projects afterwards with `doku link`.');
  }
  const single = selected.length === 1;

  const results: LoadResult[] = [];
  for (const name of selected) {
    if (!single) {
      log.info('');
      log.info(pc.bold(name));
    }
    const r = await loadInto(name, groups.get(name)!, storagePath, opts, p);
    if (!r) continue;
    if (single) r.linked = await offerLink(name, opts, cwd, p);
    results.push(r);
  }

  if (!single && rootFiles.size) {
    const plan = planFiles(storagePath, rootFiles);
    log.info('');
    if (plan.added.length && (opts.yes || (await confirm(p, `Add ${plan.added.length} file(s) at the storage root?\n${preview(plan.added)}\n`)))) {
      writeFiles(storagePath, plan.added, rootFiles, false);
      log.ok(`Added ${plan.added.length} file(s) at the storage root`);
    }
    if (plan.conflicts.length) log.info(`Kept ${plan.conflicts.length} existing file(s) at the storage root as they are.`);
  }

  const unlinked = single ? [] : results.filter((r) => !loadLinks().some((l) => l.name === r.name));
  if (unlinked.length) {
    log.info(`Not linked on this machine: ${unlinked.map((r) => r.name).join(', ')}. Link each with \`doku link <projectPath> <name>\`.`);
  }
  return results;
}

/**
 * Load a zip made by `doku zip` (or any zipped docs folder) into the storage.
 * Never deletes anything: existing files are only replaced after the user chose to
 * overwrite, and then a copy goes to ~/.doku/backups/ first.
 */
export async function loadCommand(zipFile: string, opts: LoadOptions = {}): Promise<LoadResult[]> {
  const { storagePath } = requireConfig();
  if (!fs.existsSync(storagePath)) throw new DokuError(`The storage ${storagePath} is missing. Run \`doku init\` first.`);
  if (opts.merge && opts.overwrite) throw new DokuError('Pass either --merge or --overwrite, not both.');
  const cwd = opts.cwd ?? process.cwd();
  const zipPath = path.resolve(cwd, zipFile);
  const p = opts.prompter ?? stdinPrompter();
  try {
    const zip = await decryptIfNeeded(readZip(zipPath), zipPath, storagePath, opts, cwd, p);
    return await loadZip(zip, zipPath, storagePath, opts, cwd, p);
  } finally {
    if (!opts.prompter) p.close();
  }
}

/** An encrypted zip opens with this storage's key when it is the same one; otherwise ask for its key. */
async function decryptIfNeeded(zip: ZipContents, zipPath: string, storagePath: string, opts: LoadOptions, cwd: string, p: Prompter) {
  const info = zip.meta?.encrypted;
  if (!info) return zip;
  let key: StorageKey | null = null;
  if (isRepoRoot(storagePath) && cryptState(storagePath) === 'unlocked') {
    const own = readKey(storagePath);
    if (own && keyIdHex(own) === info.keyId) key = own;
  }
  if (!key) {
    log.info(`The zip is encrypted with another key than this storage's. Enter its recovery key${info.passphrase ? ' or passphrase' : ''}.`);
    key = opts.keyFile ? keyFromFile(path.resolve(cwd, opts.keyFile), info) : await askForKey(p, info, 'cancel');
    if (!key) throw new DokuError('No key given; nothing was loaded.');
  }
  return openEncryptedZip(zip, key, zipPath);
}

async function loadZip(zip: ZipContents, zipPath: string, storagePath: string, opts: LoadOptions, cwd: string, p: Prompter) {
  if (zip.skipped.length) {
    log.warn(`Skipping ${zip.skipped.length} entr${zip.skipped.length === 1 ? 'y' : 'ies'} with unsafe paths or .git:\n${preview(zip.skipped)}`);
  }
  if (!zip.files.size) throw new DokuError(`${zipPath} contains no files to load.`);

  let results: LoadResult[];
  if (zip.meta?.kind === 'storage') {
    results = await loadStorageZip(zip, storagePath, opts, cwd, p);
  } else {
    if (opts.all) throw new DokuError(`This zip holds a single project${zip.meta?.name ? ` ("${zip.meta.name}")` : ''}, so --all does not apply.`);
    const name = await pickName(zip, zipPath, opts, cwd, p);
    if (!name) throw new DokuError('No project name given; nothing was written. Pass one with `--project <name>`.');
    const r = await loadInto(name, zip.files, storagePath, opts, p);
    if (r) r.linked = await offerLink(name, opts, cwd, p);
    results = r ? [r] : [];
  }

  if (results.some((r) => r.added.length || r.overwritten.length)) {
    applyIgnoresToGit(storagePath);
    if (isRepoRoot(storagePath)) log.info('Run `doku sync` to commit and push the loaded docs.');
  }
  return results;
}
