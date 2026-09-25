import fs from 'node:fs';
import path from 'node:path';
import { requireConfig } from '../config.js';
import { cryptState, LOCKED_HINT } from '../encryption.js';
import { DokuError } from '../errors.js';
import {
  deleteKitEntry,
  hashOf,
  type KitEntry,
  kitDir,
  KITS_DIR,
  loadKitEntries,
  readTree,
  sameKitEntry,
  storageKits,
  upsertKitEntry,
} from '../kits.js';
import { log, pc } from '../log.js';
import { isInside, samePath } from '../paths.js';
import { choose, confirm, type Prompter, stdinPrompter } from '../prompt.js';
import { loadLinks } from '../registry.js';
import { backupFiles, describeChange, destOf, parentsWritable } from './load.js';
import { openInCode } from './open.js';

export interface KitOptions {
  /** Project folder to use instead of the one found from `cwd`. */
  dir?: string;
  cwd?: string;
  prompter?: Prompter;
}

export interface KitUpdateOptions extends KitOptions {
  /** Apply the changes to files not changed in the project without asking. */
  yes?: boolean;
  /** Also replace files changed in both places with the kit's version (backed up first). */
  overwrite?: boolean;
  /** Also keep every file changed in both places as it is, and stop asking about those versions. */
  keepMine?: boolean;
}

export interface KitRemoveOptions extends KitOptions {
  /** Delete the kit's files that were never changed in the project, without asking. */
  deleteFiles?: boolean;
  /** Leave every file in place, without asking. */
  keepFiles?: boolean;
}

type ChangeKind = 'add' | 'update' | 'remove';
type LocalState = 'changed' | 'deleted' | 'existing';
type Resolution = 'overwrite' | 'keep' | 'beside' | 'later';

interface Plan {
  /** Safe changes: the project still has the kit's previous version (or nothing, for new files). */
  changes: { rel: string; kind: ChangeKind }[];
  /** The kit changed a file the project changed too, deleted, or already had a different version of. */
  conflicts: { rel: string; local: LocalState }[];
  /** The project already has the kit's version; only the baseline moves. */
  record: string[];
  /** The kit no longer has these; the project's copy is changed or gone, so it is only forgotten. */
  forget: string[];
  blocked: { rel: string; why: string }[];
}

export interface KitResult {
  kit: string;
  projectPath: string;
  added: string[];
  updated: string[];
  removed: string[];
  overwritten: string[];
  kept: string[];
  beside: string[];
  /** Changes left for the next `doku kit update`. */
  later: string[];
  backup?: string;
}

/** Suffix of the file `beside` writes next to a changed one, for merging by hand. */
export const BESIDE_SUFFIX = '.kit-new';

function storageForKits(): string {
  const { storagePath } = requireConfig();
  // A locked storage has only ciphertext, which must never be copied into projects.
  if (cryptState(storagePath) === 'locked') throw new DokuError(LOCKED_HINT);
  return storagePath;
}

/**
 * The project folder kits go into: `--dir`, else the innermost linked project or kit user
 * containing `cwd`, else `cwd` itself (the folder does not need doku docs of its own).
 */
export function kitProjectRoot(cwd: string, storagePath: string, dir?: string): string {
  let root: string;
  if (dir) {
    root = path.resolve(cwd, dir);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new DokuError(`Folder ${root} does not exist.`);
  } else {
    const known = [...loadKitEntries().map((e) => e.projectPath), ...loadLinks().map((l) => l.projectPath)]
      .filter((p) => isInside(cwd, p))
      .sort((a, b) => b.length - a.length);
    root = known[0] ?? cwd;
  }
  if (isInside(root, storagePath)) {
    throw new DokuError('Kits are copied into project folders; run this in a project, not in the storage.');
  }
  return root;
}

function existingKit(storagePath: string, name: string): string {
  const dir = kitDir(storagePath, name);
  if (!fs.existsSync(dir)) {
    const kits = storageKits(storagePath);
    throw new DokuError(
      `No kit "${name}" in the storage. ` + (kits.length ? `Kits: ${kits.join(', ')}.` : 'Create one with `doku kit new <name>`.'),
    );
  }
  return dir;
}

/** The project's file: its content, null when missing, or 'blocked' when something other than a file is there. */
function readLocal(root: string, rel: string): Buffer | null | 'blocked' {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(destOf(root, rel));
  } catch {
    return null;
  }
  return st.isFile() ? fs.readFileSync(destOf(root, rel)) : 'blocked';
}

/** Files other kits already put into this project, so two kits never fight over one file. */
function takenByOthers(entry: Pick<KitEntry, 'kit' | 'projectPath'>): Map<string, string> {
  const taken = new Map<string, string>();
  for (const other of loadKitEntries()) {
    if (!samePath(other.projectPath, entry.projectPath) || sameKitEntry(other, entry)) continue;
    for (const rel of Object.keys(other.files)) taken.set(rel, other.kit);
  }
  return taken;
}

/** Compare the kit, the project and the baseline without touching anything. */
function planKit(entry: KitEntry, files: Map<string, Buffer>): Plan {
  const plan: Plan = { changes: [], conflicts: [], record: [], forget: [], blocked: [] };
  const taken = takenByOthers(entry);
  const root = entry.projectPath;
  const rels = [...new Set([...files.keys(), ...Object.keys(entry.files)])].sort((a, b) => a.localeCompare(b));
  for (const rel of rels) {
    const kitData = files.get(rel);
    const base = entry.files[rel];
    if (kitData && taken.has(rel)) {
      plan.blocked.push({ rel, why: `kit "${taken.get(rel)}" has it too` });
      continue;
    }
    const local = kitData && !parentsWritable(root, rel) ? 'blocked' : readLocal(root, rel);
    if (local === 'blocked') {
      if (kitData) plan.blocked.push({ rel, why: 'a folder or link is in the way' });
      else plan.forget.push(rel);
      continue;
    }
    const localHash = local && hashOf(local);

    if (!kitData) {
      if (localHash === base) plan.changes.push({ rel, kind: 'remove' });
      else plan.forget.push(rel);
      continue;
    }
    const kitHash = hashOf(kitData);
    if (localHash === kitHash) {
      if (base !== kitHash) plan.record.push(rel);
    } else if (base === undefined) {
      if (local) plan.conflicts.push({ rel, local: 'existing' });
      else plan.changes.push({ rel, kind: 'add' });
    } else if (base !== kitHash) {
      if (localHash === base) plan.changes.push({ rel, kind: 'update' });
      else plan.conflicts.push({ rel, local: local ? 'changed' : 'deleted' });
    }
    // else: only the project changed the file (or deleted it). It is the project's now.
  }
  return plan;
}

function writeProjectFile(root: string, rel: string, data: Uint8Array): void {
  const dest = destOf(root, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, data);
}

/** Delete a file, then any folders it leaves empty, up to (not including) `root`. */
function removeProjectFile(root: string, rel: string): void {
  fs.rmSync(destOf(root, rel), { force: true });
  let dir = path.dirname(destOf(root, rel));
  while (!samePath(dir, root) && isInside(dir, root)) {
    try {
      fs.rmdirSync(dir);
    } catch {
      break; // not empty
    }
    dir = path.dirname(dir);
  }
}

const CHANGE_LABEL: Record<ChangeKind, string> = { add: 'new', update: 'updated', remove: 'removed' };

function conflictQuestion(rel: string, local: LocalState, root: string, kitData: Buffer): string {
  if (local === 'deleted') return `${pc.bold(rel)} was deleted here, and the kit has a new version of it.`;
  const change = pc.dim(`(here → kit: ${describeChange(fs.readFileSync(destOf(root, rel)), kitData)})`);
  return local === 'existing'
    ? `${pc.bold(rel)} already exists here and differs from the kit's ${change}.`
    : `${pc.bold(rel)} was changed here, and the kit changed it too ${change}.`;
}

async function resolveConflict(
  rel: string,
  local: LocalState,
  root: string,
  kitData: Buffer,
  opts: KitUpdateOptions,
  p: Prompter,
): Promise<Resolution> {
  if (opts.overwrite) return 'overwrite';
  if (opts.keepMine) return 'keep';
  const choices =
    local === 'deleted'
      ? [
          { key: 'o', value: 'overwrite' as const, label: "restore: bring back the kit's version" },
          { key: 'k', value: 'keep' as const, label: "keep it deleted, and don't ask again until the kit changes it again" },
          { key: 'l', value: 'later' as const, label: 'later: decide at the next `doku kit update`' },
        ]
      : [
          { key: 'o', value: 'overwrite' as const, label: "overwrite with the kit's version (yours is backed up first)" },
          { key: 'k', value: 'keep' as const, label: "keep mine, and don't ask again until the kit changes it again" },
          { key: 'b', value: 'beside' as const, label: `write the kit's version beside it as ${rel}${BESIDE_SUFFIX}, to merge by hand` },
          { key: 'l', value: 'later' as const, label: 'later: decide at the next `doku kit update`' },
        ];
  return choose(p, conflictQuestion(rel, local, root, kitData), choices, 'later');
}

/**
 * Bring one kit into one project: safe changes in one batch (without asking when adding
 * the kit), then a question per conflicting file. Saves the new baseline.
 */
async function applyKit(entry: KitEntry, storagePath: string, adding: boolean, opts: KitUpdateOptions, p: Prompter): Promise<KitResult> {
  const files = readTree(kitDir(storagePath, entry.kit));
  const root = entry.projectPath;
  const plan = planKit(entry, files);
  const base = { ...entry.files };
  const result: KitResult = {
    kit: entry.kit,
    projectPath: root,
    added: [],
    updated: [],
    removed: [],
    overwritten: [],
    kept: [],
    beside: [],
    later: [],
  };
  const kitHash = (rel: string) => hashOf(files.get(rel)!);

  for (const rel of plan.record) base[rel] = kitHash(rel);
  for (const rel of plan.forget) {
    if (fs.existsSync(destOf(root, rel))) log.info(pc.dim(`  ${rel}: no longer in the kit; your changed copy stays.`));
    delete base[rel];
  }
  for (const { rel, why } of plan.blocked) log.warn(`${rel}: skipped, ${why}.`);

  if (plan.changes.length) {
    log.info(
      `${adding ? 'Copying' : 'Changes from the kit'} (none of these files were changed here):\n` +
        plan.changes
          .map(({ rel, kind }) => {
            const stats = kind === 'update' ? `  ${pc.dim(describeChange(fs.readFileSync(destOf(root, rel)), files.get(rel)!))}` : '';
            return `    ${CHANGE_LABEL[kind].padEnd(8)} ${rel}${stats}`;
          })
          .join('\n'),
    );
    const answer =
      adding || opts.yes || opts.overwrite || opts.keepMine
        ? 'apply'
        : await choose(
            p,
            `Apply ${plan.changes.length} change(s)?`,
            [
              { key: 'u', value: 'apply' as const, label: 'update: apply them' },
              { key: 'i', value: 'ignore' as const, label: "ignore: leave the files as they are, and don't ask again until the kit changes them again" },
              { key: 'l', value: 'later' as const, label: 'later: change nothing now' },
            ],
            'apply',
            'later',
          );
    for (const { rel, kind } of plan.changes) {
      if (answer === 'later') {
        result.later.push(rel);
      } else if (kind === 'remove') {
        if (answer === 'apply') {
          removeProjectFile(root, rel);
          result.removed.push(rel);
        }
        delete base[rel];
      } else {
        if (answer === 'apply') {
          writeProjectFile(root, rel, files.get(rel)!);
          (kind === 'add' ? result.added : result.updated).push(rel);
        }
        base[rel] = kitHash(rel);
      }
    }
  }

  // Decide every conflict first, then back up and write in one go.
  const decisions: { rel: string; resolution: Resolution }[] = [];
  for (const { rel, local } of plan.conflicts) {
    decisions.push({ rel, resolution: await resolveConflict(rel, local, root, files.get(rel)!, opts, p) });
  }
  const toBackUp = decisions.filter((d) => d.resolution === 'overwrite' && fs.existsSync(destOf(root, d.rel))).map((d) => d.rel);
  if (toBackUp.length) result.backup = backupFiles(root, toBackUp, `kit-${entry.kit}`);
  for (const { rel, resolution } of decisions) {
    if (resolution === 'later') {
      result.later.push(rel);
      continue;
    }
    if (resolution === 'overwrite') {
      writeProjectFile(root, rel, files.get(rel)!);
      result.overwritten.push(rel);
    } else if (resolution === 'beside') {
      writeProjectFile(root, rel + BESIDE_SUFFIX, files.get(rel)!);
      result.beside.push(rel);
    } else {
      result.kept.push(rel);
    }
    base[rel] = kitHash(rel);
  }

  upsertKitEntry({ ...entry, files: base });
  report(result);
  return result;
}

function report(r: KitResult): void {
  const parts = [
    r.added.length && `${r.added.length} added`,
    r.updated.length && `${r.updated.length} updated`,
    r.removed.length && `${r.removed.length} removed`,
    r.overwritten.length && `${r.overwritten.length} overwritten`,
    r.kept.length && `${r.kept.length} kept as yours`,
    r.beside.length && `${r.beside.length} written beside`,
  ].filter(Boolean);
  log.ok(`Kit "${r.kit}" in ${r.projectPath}: ${parts.length ? parts.join(', ') : 'up to date'}`);
  if (r.backup) log.info(`  Your overwritten files are backed up in ${r.backup}`);
  for (const rel of r.beside) log.info(`  Merge ${rel}${BESIDE_SUFFIX} into ${rel}, then delete it.`);
  if (r.later.length) log.info(`  ${r.later.length} change(s) left for later; run \`doku kit update\` to decide.`);
}

async function withPrompter<T>(opts: KitOptions, fn: (p: Prompter) => Promise<T>): Promise<T> {
  const p = opts.prompter ?? stdinPrompter();
  try {
    return await fn(p);
  } finally {
    if (!opts.prompter) p.close();
  }
}

function entriesAt(root: string): KitEntry[] {
  return loadKitEntries().filter((e) => samePath(e.projectPath, root));
}

/** Copy a kit into the project. Files already there are asked about, never replaced silently. */
export async function kitAddCommand(name: string, opts: KitUpdateOptions = {}): Promise<KitResult> {
  if (opts.overwrite && opts.keepMine) throw new DokuError('Pass either --overwrite or --keep-mine, not both.');
  const storagePath = storageForKits();
  const dir = existingKit(storagePath, name);
  const root = kitProjectRoot(opts.cwd ?? process.cwd(), storagePath, opts.dir);
  const existing = entriesAt(root).find((e) => e.kit.toLowerCase() === name.toLowerCase());
  if (existing) log.info(`${root} already uses the kit "${existing.kit}"; checking it for changes.`);
  const entry: KitEntry = existing ?? { kit: path.basename(dir), projectPath: root, files: {} };

  const taken = takenByOthers(entry);
  const clashes = [...readTree(dir).keys()].filter((rel) => taken.has(rel));
  if (clashes.length) {
    throw new DokuError(
      `Other kits in this project already have: ${clashes.map((rel) => `${rel} (${taken.get(rel)})`).join(', ')}. ` +
        'A file can come from one kit only.',
    );
  }
  if (!existing) log.info(`Kit "${entry.kit}" → ${root}`);
  return withPrompter(opts, (p) => applyKit(entry, storagePath, !existing, opts, p));
}

/** Bring kit changes into the project: every kit it uses, or just `name`. */
export async function kitUpdateCommand(name: string | undefined, opts: KitUpdateOptions = {}): Promise<KitResult[]> {
  if (opts.overwrite && opts.keepMine) throw new DokuError('Pass either --overwrite or --keep-mine, not both.');
  const storagePath = storageForKits();
  const root = kitProjectRoot(opts.cwd ?? process.cwd(), storagePath, opts.dir);
  let entries = entriesAt(root);
  if (name) entries = entries.filter((e) => e.kit.toLowerCase() === name.toLowerCase());
  if (!entries.length) {
    throw new DokuError(
      name
        ? `${root} does not use the kit "${name}". Add it with \`doku kit add ${name}\`.`
        : `${root} uses no kits on this machine. \`doku kit list\` shows them, \`doku kit add <name>\` adds one.`,
    );
  }
  return withPrompter(opts, async (p) => {
    const results: KitResult[] = [];
    for (const entry of entries) {
      if (entries.length > 1) log.info(pc.bold(`\nKit "${entry.kit}"`));
      if (!fs.existsSync(kitDir(storagePath, entry.kit))) {
        log.warn(`The kit "${entry.kit}" is no longer in the storage. \`doku kit remove ${entry.kit}\` stops tracking it here.`);
        continue;
      }
      results.push(await applyKit(entry, storagePath, false, opts, p));
    }
    return results;
  });
}

/** Create a kit in the storage, optionally starting it with copies of this project's files. */
export function kitNewCommand(name: string, paths: string[], opts: KitOptions = {}): string {
  const storagePath = storageForKits();
  const dir = kitDir(storagePath, name);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
    throw new DokuError(`The kit "${name}" already exists. Edit it in ${dir} (\`doku kit open ${name}\`).`);
  }
  const cwd = opts.cwd ?? process.cwd();

  const files = new Map<string, Buffer>();
  let root: string | undefined;
  if (paths.length) {
    root = kitProjectRoot(cwd, storagePath, opts.dir);
    for (const arg of paths) {
      const abs = path.resolve(cwd, arg);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (!rel || !isInside(abs, root)) throw new DokuError(`${arg} is not inside the project folder ${root}.`);
      if (!parentsWritable(root, rel)) throw new DokuError(`${arg} is inside a link (such as .doku/); pick files of the project itself.`);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(abs);
      } catch {
        throw new DokuError(`${arg} does not exist.`);
      }
      if (st.isSymbolicLink()) throw new DokuError(`${arg} is a link; pick files of the project itself.`);
      if (st.isDirectory()) for (const [sub, data] of readTree(abs)) files.set(`${rel}/${sub}`, data);
      else files.set(rel, fs.readFileSync(abs));
    }
    const taken = takenByOthers({ kit: name, projectPath: root });
    const clashes = [...files.keys()].filter((rel) => taken.has(rel));
    if (clashes.length) {
      throw new DokuError(`These files already come from other kits: ${clashes.map((rel) => `${rel} (${taken.get(rel)})`).join(', ')}.`);
    }
  }

  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, data] of files) writeProjectFile(dir, rel, data);
  log.ok(`Created kit "${name}" in ${dir}${files.size ? ` with ${files.size} file(s)` : ''}`);
  if (root && files.size) {
    // The project has exactly the kit's files, so it counts as up to date.
    upsertKitEntry({ kit: name, projectPath: root, files: Object.fromEntries([...files].map(([rel, data]) => [rel, hashOf(data)])) });
    log.info(`  ${root} uses it from now on.`);
  } else {
    log.info(`  Put the files there as they should appear in a project folder (\`doku kit open ${name}\`).`);
  }
  log.info('  Other projects get it with `doku kit add ' + name + '`. Edit the kit only in the storage; `doku sync` shares it.');
  return dir;
}

/** Stop tracking a kit in the project, offering to delete its files that were never changed here. */
export async function kitRemoveCommand(name: string, opts: KitRemoveOptions = {}): Promise<{ deleted: string[]; kept: string[] }> {
  if (opts.deleteFiles && opts.keepFiles) throw new DokuError('Pass either --delete-files or --keep-files, not both.');
  const { storagePath } = requireConfig();
  const root = kitProjectRoot(opts.cwd ?? process.cwd(), storagePath, opts.dir);
  const entry = entriesAt(root).find((e) => e.kit.toLowerCase() === name.toLowerCase());
  if (!entry) throw new DokuError(`${root} does not use the kit "${name}".`);

  const unchanged: string[] = [];
  const kept: string[] = [];
  for (const [rel, hash] of Object.entries(entry.files).sort(([a], [b]) => a.localeCompare(b))) {
    const local = readLocal(root, rel);
    if (!local || local === 'blocked') continue;
    (hashOf(local) === hash ? unchanged : kept).push(rel);
  }

  let deleted: string[] = [];
  if (unchanged.length && !opts.keepFiles) {
    const list = unchanged.map((rel) => `    ${rel}`).join('\n');
    const ok = opts.deleteFiles || (await withPrompter(opts, (p) => confirm(p, `Delete the kit's files you never changed?\n${list}\n`)));
    if (ok) {
      for (const rel of unchanged) removeProjectFile(root, rel);
      deleted = unchanged;
    }
  }
  deleteKitEntry(entry);
  log.ok(`${root} no longer uses the kit "${entry.kit}"${deleted.length ? `; deleted ${deleted.length} file(s)` : ''}.`);
  const left = [...kept, ...unchanged.filter((rel) => !deleted.includes(rel))];
  if (left.length) log.info(`  Left in place: ${left.join(', ')}`);
  return { deleted, kept: left };
}

/** Changes waiting in the kit for this project (safe ones plus conflicts), or null when the kit is gone. */
export function kitPending(entry: KitEntry, storagePath: string): number | null {
  const dir = kitDir(storagePath, entry.kit);
  if (!fs.existsSync(dir)) return null;
  const plan = planKit(entry, readTree(dir));
  return plan.changes.length + plan.conflicts.length;
}

function describePending(entry: KitEntry, storagePath: string): string {
  if (!fs.existsSync(entry.projectPath)) return pc.yellow('folder missing (`doku doctor --prune` forgets it)');
  const n = kitPending(entry, storagePath);
  if (n === null) return pc.yellow('kit missing from storage');
  return n ? pc.yellow(`${n} change(s) waiting: \`doku kit update\``) : pc.green('up to date');
}

export function kitListCommand(opts: Pick<KitOptions, 'cwd'> = {}): void {
  const storagePath = storageForKits();
  const kits = storageKits(storagePath);
  const entries = loadKitEntries();
  log.info(pc.dim(`Kits: ${path.join(storagePath, KITS_DIR)}`));
  if (!kits.length) log.info('No kits yet. Create one with `doku kit new <name> [files...]`.');
  for (const kit of kits) {
    const count = readTree(kitDir(storagePath, kit)).size;
    log.info(`  ${pc.bold(kit)}  ${pc.dim(`${count} file(s)`)}`);
    const users = entries.filter((e) => e.kit.toLowerCase() === kit.toLowerCase());
    if (!users.length) log.info(pc.dim('    not used on this machine'));
    for (const e of users) log.info(`    ${e.projectPath}  ${describePending(e, storagePath)}`);
  }
  for (const e of entries.filter((e) => !kits.some((k) => k.toLowerCase() === e.kit.toLowerCase()))) {
    log.warn(`${e.projectPath} uses the kit "${e.kit}", which is not in the storage (\`doku kit remove ${e.kit}\` there).`);
  }
  const cwd = opts.cwd ?? process.cwd();
  if (!isInside(cwd, storagePath)) {
    const root = kitProjectRoot(cwd, storagePath);
    const here = entriesAt(root);
    if (here.length) log.info(pc.dim(`This folder (${root}) uses: ${here.map((e) => e.kit).join(', ')}`));
  }
}

/** One line per project on this machine with kit changes waiting. For `doku status` and after `doku sync`. */
export function kitHints(storagePath: string): string[] {
  if (cryptState(storagePath) === 'locked') return [];
  return loadKitEntries()
    .filter((e) => fs.existsSync(e.projectPath) && (kitPending(e, storagePath) ?? 0) > 0)
    .map((e) => `kit "${e.kit}" has ${kitPending(e, storagePath)} change(s) for ${e.projectPath}: run \`doku kit update\` there`);
}

/** Every kit use on this machine with its state, for `doku status`. */
export function kitStatusLines(storagePath: string): string[] {
  if (cryptState(storagePath) === 'locked') return [];
  return loadKitEntries().map((e) => `${e.kit.padEnd(24)} ${e.projectPath}  ${describePending(e, storagePath)}`);
}

export function kitPathFor(name?: string): string {
  const { storagePath } = requireConfig();
  return name ? existingKit(storagePath, name) : path.join(storagePath, KITS_DIR);
}

export function kitOpenCommand(name?: string): void {
  const dir = kitPathFor(name);
  fs.mkdirSync(dir, { recursive: true });
  openInCode(dir);
}
