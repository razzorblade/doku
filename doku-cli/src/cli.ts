import { Command } from 'commander';
import { agentsSnippet } from './agentsNote.js';
import { doctorCommand } from './commands/doctor.js';
import { decryptCommand, encryptCommand, keyCommand, unlockCommand } from './commands/encrypt.js';
import { ignoreCommand, unignoreCommand } from './commands/ignore.js';
import { initCommand } from './commands/init.js';
import {
  kitAddCommand,
  kitHints,
  kitListCommand,
  kitNewCommand,
  kitOpenCommand,
  kitPathFor,
  kitRemoveCommand,
  kitUpdateCommand,
} from './commands/kit.js';
import { DEFAULT_LINK_NAME, linkFromCli } from './commands/link.js';
import { listCommand } from './commands/list.js';
import { loadCommand } from './commands/load.js';
import { openCommand, storagePathFor } from './commands/open.js';
import { removeRemoteCommand, setRemoteCommand, showRemoteCommand } from './commands/remote.js';
import { statusCommand } from './commands/status.js';
import { unlinkCommand } from './commands/unlink.js';
import { zipCommand } from './commands/zip.js';
import { requireConfig } from './config.js';
import { cryptState } from './encryption.js';
import { DokuError } from './errors.js';
import { runFilterProcess, runMergeDriver, runTextconv } from './filterProcess.js';
import { log } from './log.js';
import { assertSegment } from './paths.js';
import { syncStorage } from './sync.js';

function run<A extends unknown[]>(fn: (...args: A) => unknown) {
  return async (...args: A) => {
    try {
      const result = await fn(...args);
      if (typeof result === 'number') process.exitCode = result;
    } catch (err) {
      if (err instanceof DokuError) {
        log.error(err.message);
        process.exitCode = 1;
      } else {
        throw err;
      }
    }
  };
}

const program = new Command()
  .name('doku')
  .description('Private per-project docs, stored centrally and linked into projects')
  .version('0.1.0');

program
  .command('init')
  .description('set up the storage on this machine (new, existing, or cloned)')
  .option('-s, --storage <path>', 'storage folder (default: doku-storage next to doku-cli)')
  .option('-c, --clone <gitUrl>', 'clone an existing storage repository into the storage folder')
  .option('--key-file <file>', 'encrypted storage: file with the recovery key (instead of asking)')
  .action(
    run(async (opts: { storage?: string; clone?: string; keyFile?: string }) => {
      const storage = initCommand(opts);
      if (opts.clone && cryptState(storage) === 'locked') {
        log.info('This storage is encrypted. With its key, the files are decrypted on this machine now.');
        await unlockCommand({ keyFile: opts.keyFile });
      }
    }),
  );

program
  .command('link')
  .description(`link a project's docs into it as ${DEFAULT_LINK_NAME}/, or switch it to other docs`)
  .argument('[projectPath]', 'project folder (default: current folder); or, alone, the docs name to link the current folder to')
  .argument('[name]', 'docs name in storage (default: project folder name, or asks when those docs don\'t exist yet)')
  .option('--as <linkName>', 'folder name inside the project', DEFAULT_LINK_NAME)
  .option('--no-agents-note', `don't add a note for AI assistants to CLAUDE.local.md`)
  .addHelpText(
    'after',
    `
Examples:
  doku link                        link the current folder to docs of the same name
  doku link web-shop               link the current folder to the docs "web-shop",
                                   e.g. when the folder is named differently on this machine
  doku link C:/work/app my-app     link C:/work/app to the docs "my-app"

Each machine remembers its own links, so the folder name can differ per machine.
Linking a project that is already linked switches it to the new docs; the old docs stay in storage.`,
  )
  .action(
    run(async (projectPath: string | undefined, name: string | undefined, opts) => void (await linkFromCli(projectPath, name, opts))),
  );

program
  .command('unlink')
  .description('remove a link from a project (the docs stay in storage)')
  .argument('<projectPathOrName>', 'project folder or storage name')
  .option('--as <linkName>', 'only the link with this folder name')
  .option('--all', 'remove every link matching the name')
  .action(run((query: string, opts) => void unlinkCommand(query, opts)));

program.command('list').alias('ls').description('list projects in storage and where they are linked').action(run(listCommand));

program.command('status').description('check links and show uncommitted storage changes').action(run(statusCommand));

program
  .command('sync')
  .description('commit storage changes, pull --rebase and push')
  .option('-m, --message <msg>', 'commit message')
  .action(
    run((opts: { message?: string }) => {
      const { storagePath } = requireConfig();
      syncStorage(storagePath, opts.message);
      // Kits are never updated by a sync; only point out what is waiting.
      for (const hint of kitHints(storagePath)) log.warn(hint);
    }),
  );

const remote = program.command('remote').description(`show or change the storage's git remote (origin), used by \`doku sync\``);
remote.command('show', { isDefault: true }).description('print the remote URL').action(run(showRemoteCommand));
remote
  .command('set')
  .alias('add')
  .description('add the remote, or point it at another repository')
  .argument('<url>', 'git URL of a private repository, ideally empty')
  .action(run((url: string) => setRemoteCommand(url)));
remote.command('remove').alias('rm').description('remove the remote; `doku sync` then only commits locally').action(run(removeRemoteCommand));

program
  .command('encrypt')
  .description('encrypt the storage in git and zips (files stay plain on this machine); replaces the history')
  .option('--passphrase', 'also allow unlocking with a passphrase (asked for)')
  .option('--no-passphrase', 'recovery key only, without asking')
  .option('--key-file <file>', 'also write the recovery key to this file')
  .option('--backup-history', 'keep the old unencrypted history as a git bundle in ~/.doku/backups')
  .option('-y, --yes', "don't ask for the go-ahead (with --key-file, also not to confirm the key)")
  .action(run(async (opts) => void (await encryptCommand(opts))));

program
  .command('unlock')
  .description('enter the key of an encrypted storage on this machine, so its files are decrypted here')
  .option('--key-file <file>', 'file with the recovery key (instead of asking)')
  .action(run(async (opts) => void (await unlockCommand(opts))));

program
  .command('key')
  .description('show the recovery key of the encrypted storage; --passphrase sets or changes the passphrase')
  .option('--passphrase', 'set or change the passphrase')
  .option('--no-passphrase', 'remove the passphrase (only the recovery key unlocks then)')
  .action(run(async (opts) => void (await keyCommand(opts))));

program
  .command('decrypt')
  .description('turn encryption off; the next sync pushes every file unencrypted')
  .action(run(async () => void (await decryptCommand())));

program
  .command('ignore')
  .description('keep docs on this machine only (not synced, not zipped); no paths lists the rules')
  .argument('[paths...]', 'files, folders or globs, relative to the docs folder when run in a project')
  .action(run((paths: string[]) => void ignoreCommand(paths)));

program
  .command('unignore')
  .description('remove paths from .dokuignore')
  .argument('<paths...>', 'paths as given to `doku ignore`')
  .action(run((paths: string[]) => void unignoreCommand(paths)));

program
  .command('zip')
  .description('zip the current project (into its folder as <project>.doku.zip), another one, or --all for the whole storage')
  .argument('[target]', 'linked project path or storage project name (default: the project you are in)')
  .option('-a, --all', 'zip the whole storage without asking')
  .option('-o, --output <file>', 'where to write the zip')
  .option('-s, --silent', `don't open the folder; print only the zip path`)
  .option('--plain', 'encrypted storage: write the zip unencrypted')
  .action(run(async (target: string | undefined, opts) => void (await zipCommand(target, opts))));

program
  .command('load')
  .description('load a zip (from `doku zip`, or any zipped docs folder) into the storage; asks before changing anything')
  .argument('<zipFile>', 'zip file to load')
  .option('-p, --project <name>', 'storage project to load into (default: the one named in the zip); for a whole-storage zip, the one project to load')
  .option('-a, --all', 'whole-storage zip: load every project without asking which')
  .option('--merge', 'existing project: add new files, keep existing ones that differ')
  .option('--overwrite', 'existing project: add new files, replace differing ones (backed up to ~/.doku/backups first)')
  .option('--link <projectPath>', 'link the project into this folder if it is not linked yet')
  .option('--no-link', `don't offer to link the project`)
  .option('-y, --yes', 'create missing projects without asking')
  .option('--key-file <file>', 'encrypted zip: file with its recovery key (instead of asking)')
  .action(run(async (zipFile: string, opts) => void (await loadCommand(zipFile, opts))));

const kit = program
  .command('kit')
  .description('shared files (CLAUDE.md, .mcp.json, …) copied from the storage into project folders, and updated from it');
kit.command('list', { isDefault: true }).alias('ls').description('kits in the storage and where they are used').action(run(() => kitListCommand()));
kit
  .command('new')
  .description('create a kit in the storage, optionally starting it with copies of files from this project')
  .argument('<name>', 'kit name, e.g. unity-generic')
  .argument('[paths...]', "files or folders of this project to start the kit with (they keep their place relative to the project folder)")
  .option('--dir <folder>', 'project folder (default: the linked project you are in, or the current folder)')
  .action(run((name: string, paths: string[], opts) => void kitNewCommand(name, paths, opts)));
kit
  .command('add')
  .description('copy a kit into the project folder; files already there are asked about')
  .argument('<name>', 'kit name')
  .option('--dir <folder>', 'project folder (default: the linked project you are in, or the current folder)')
  .option('--overwrite', "files that differ: replace them with the kit's version (backed up first)")
  .option('--keep-mine', 'files that differ: keep them as they are')
  .action(run(async (name: string, opts) => void (await kitAddCommand(name, opts))));
kit
  .command('update')
  .description("bring changes of the project's kits into it (one-way; asks about files you changed)")
  .argument('[name]', 'only this kit (default: every kit the project uses)')
  .option('--dir <folder>', 'project folder (default: the linked project you are in, or the current folder)')
  .option('-y, --yes', "apply changes to files you didn't change without asking")
  .option('--overwrite', "also replace files changed here and in the kit (yours are backed up first)")
  .option('--keep-mine', 'also keep every file changed here and in the kit as it is')
  .action(run(async (name: string | undefined, opts) => void (await kitUpdateCommand(name, opts))));
kit
  .command('remove')
  .alias('rm')
  .description("stop using a kit in the project; offers to delete its files you never changed")
  .argument('<name>', 'kit name')
  .option('--dir <folder>', 'project folder (default: the linked project you are in, or the current folder)')
  .option('--delete-files', 'delete the unchanged files without asking')
  .option('--keep-files', 'leave every file in place')
  .action(run(async (name: string, opts) => void (await kitRemoveCommand(name, opts))));
kit
  .command('open')
  .description('open the kits (or one kit) in VS Code; the only place kits are edited')
  .argument('[name]', 'kit name')
  .action(run((name?: string) => kitOpenCommand(name)));
kit
  .command('path')
  .description('print the path of the kits folder, or of one kit')
  .argument('[name]', 'kit name')
  .action(run((name?: string) => console.log(kitPathFor(name))));

program
  .command('doctor')
  .description('check registered links; --fix recreates missing or stale ones')
  .option('--fix', 'repair links, git excludes and notes')
  .option('--prune', 'forget links whose project folder no longer exists')
  .action(run(doctorCommand));

program
  .command('open')
  .description('open the storage (or one project in it) in VS Code')
  .argument('[name]', 'project name in storage')
  .action(run((name?: string) => openCommand(name)));

program
  .command('prompt')
  .alias('ai')
  .description('print instructions for AI assistants about .doku/, to paste into CLAUDE.md or AGENTS.md')
  .option('--as <linkName>', 'folder name used in the project', DEFAULT_LINK_NAME)
  .action(
    run((opts: { as: string }) => {
      assertSegment(opts.as, 'link name');
      console.log(agentsSnippet(opts.as));
    }),
  );

program
  .command('path')
  .description('print the storage path (or one project in it)')
  .argument('[name]', 'project name in storage')
  .action(run((name?: string) => console.log(storagePathFor(name))));

// Run by git in an encrypted storage (see encryption.ts); not for direct use.
program.command('filter-process', { hidden: true }).action(() => runFilterProcess());
program
  .command('textconv', { hidden: true })
  .argument('<file>')
  .action((file: string) => runTextconv(file));
program
  .command('merge-driver', { hidden: true })
  .arguments('<base> <ours> <theirs> [markerSize]')
  .action((base: string, ours: string, theirs: string, markerSize?: string) => {
    process.exitCode = runMergeDriver(base, ours, theirs, markerSize);
  });

await program.parseAsync();
