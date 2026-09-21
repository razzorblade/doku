import { Command } from 'commander';
import { agentsSnippet } from './agentsNote.js';
import { doctorCommand } from './commands/doctor.js';
import { ignoreCommand, unignoreCommand } from './commands/ignore.js';
import { initCommand } from './commands/init.js';
import { DEFAULT_LINK_NAME, linkCommand } from './commands/link.js';
import { listCommand } from './commands/list.js';
import { loadCommand } from './commands/load.js';
import { openCommand, storagePathFor } from './commands/open.js';
import { statusCommand } from './commands/status.js';
import { unlinkCommand } from './commands/unlink.js';
import { zipCommand } from './commands/zip.js';
import { requireConfig } from './config.js';
import { DokuError } from './errors.js';
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
  .action(run((opts) => void initCommand(opts)));

program
  .command('link')
  .description(`link a project's docs into it as ${DEFAULT_LINK_NAME}/`)
  .argument('[projectPath]', 'project folder (default: current folder)')
  .argument('[name]', 'folder name in storage (default: project folder name)')
  .option('--as <linkName>', 'folder name inside the project', DEFAULT_LINK_NAME)
  .option('--no-agents-note', `don't add a note for AI assistants to CLAUDE.local.md`)
  .action(
    run((projectPath: string | undefined, name: string | undefined, opts) => void linkCommand(projectPath, name, opts)),
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
  .action(run((opts: { message?: string }) => void syncStorage(requireConfig().storagePath, opts.message)));

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
  .description('zip the whole storage, or one project (`doku zip .` in a project writes .doku.zip there)')
  .argument('[target]', 'linked project path or storage project name (default: whole storage)')
  .option('-o, --output <file>', 'where to write the zip')
  .option('-s, --silent', `don't open the folder; print only the zip path`)
  .action(run((target: string | undefined, opts) => void zipCommand(target, opts)));

program
  .command('load')
  .description('load a zip (from `doku zip`, or any zipped docs folder) into the storage; asks before changing anything')
  .argument('<zipFile>', 'zip file to load')
  .option('-p, --project <name>', 'storage project to load into (default: the one named in the zip)')
  .option('--merge', 'existing project: add new files, keep existing ones that differ')
  .option('--overwrite', 'existing project: add new files, replace differing ones (backed up to ~/.doku/backups first)')
  .option('--link <projectPath>', 'link the project into this folder if it is not linked yet')
  .option('--no-link', `don't offer to link the project`)
  .option('-y, --yes', 'create missing projects without asking')
  .action(run(async (zipFile: string, opts) => void (await loadCommand(zipFile, opts))));

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

await program.parseAsync();
