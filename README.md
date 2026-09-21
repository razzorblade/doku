# doku

Private per-project working docs (architecture notes, decisions, task plans, client notes) that:

- live **outside** each project's git, in one central storage synced between your machines,
- show up **inside** each project as a `.doku/` folder, so VS Code's Explorer and AI assistants
  (Claude Code, Copilot, Cursor…) read and write them like any other project files.

`.doku/` is a directory junction (a symlink on macOS/Linux) into the storage, not a copy. Edits made in the
project land in the storage right away, and a `git pull` in the storage shows up in every linked project.
Junctions need no admin rights or Developer Mode on Windows.

```
doku-mcp/
  doku-cli/        the `doku` command (Node + TypeScript)
  doku-storage/    default storage: its own private git repo, ignored by this repo
    my-cool-project/
      README.md
      decisions.md
```

## Install

Requires Node 20+ and git. Do this once on every machine.

```sh
cd doku-cli
npm install
npm run build
npm link          # installs the `doku` command globally
```

`npm link` puts a `doku` command in npm's global bin folder, which the Node installer already added
to your PATH. The command points at this folder rather than a copy, so it always runs your current build.

Open a **new** terminal (any folder, any shell) and check that it works:

```sh
doku --version
```

### If `doku` is not found

- Print npm's global bin folder with `npm prefix -g`. On Windows `doku.cmd` should be directly in it
  (usually `%APPDATA%\npm`); on macOS/Linux it is in the `bin` subfolder. Add that folder to your PATH:
  on Windows, Start → "Edit environment variables for your account" → `Path` → New.
  Then restart the terminal, and VS Code too if you use its integrated terminal.
- **PowerShell says "running scripts is disabled on this system"**: PowerShell is blocking npm's
  `doku.ps1` shim. Allow local scripts once with
  `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or run `doku.cmd` instead.
- **You use nvm / nvm-windows / fnm**: each Node version has its own global packages. Run `npm link`
  again after switching Node versions.

### Updating

```sh
cd doku-cli
git pull          # if you pulled a newer version of doku itself
npm install
npm run build     # no need to re-link
```

### Uninstalling

```sh
npm uninstall -g doku-cli
```

This removes only the command. Your storage and the links in your projects are left as they are.
Run `doku unlink` on each project first if you want to remove the links too.

## First machine

```sh
doku init                                   # creates doku-storage/ and runs git init there
cd doku-storage && git remote add origin <your-private-repo-url> && cd ..
doku link C:/projects/my-cool-project       # storage name defaults to the folder name
doku sync                                   # commit + pull --rebase + push
```

Or from inside a project, without paths:

```sh
cd C:/projects/my-cool-project
doku link                                   # links the current folder
```

## Another machine

```sh
doku init --clone <your-private-repo-url>
doku link D:/work/my-cool-project my-cool-project
```

Project paths can differ between machines. Links are recorded per machine in `~/.doku/links.json`,
never in the storage.

## Setting up the storage with git

The storage is an ordinary folder that is also its own git repository, separate from this tool's repo
and from your projects. You don't need to run `git init` yourself: `doku init` does it.

| Your situation | Run | What happens |
|---|---|---|
| Starting fresh | `doku init` or `doku init --storage C:/doku-storage` | Creates the folder, runs `git init` in it, adds a README. |
| Existing folder, no git yet | `doku init --storage <folder>` | Runs `git init` there. Existing files are left as they are. |
| Existing folder that is already a git repo | `doku init --storage <folder>` | Leaves git alone and just uses the folder. |
| Storage already on a remote (second machine) | `doku init --clone <url>` | Clones it. The target folder must be empty or missing. |

The storage always uses the branch `main`, whatever git's default branch is on the machine.

The default storage location is `doku-storage/` inside this tool's folder. That is fine: the tool's repo
ignores that folder, and the storage gets its own `.git`, so the two repositories never mix. `doku sync`
refuses to run unless the storage is the root of its own repository.

### Connecting a remote (needed for syncing between machines)

1. Create an empty **private** repository on GitHub, GitLab or similar (no README, no .gitignore).
   These are your private notes, so keep the repository private.
2. Add it as `origin` in the storage and push once:

   ```sh
   cd "$(doku path)"
   git remote add origin <your-private-repo-url>
   doku sync          # commits everything and pushes, setting up tracking the first time
   ```

   With the GitHub CLI, step 1 and 2 can be one command run inside the storage:
   `gh repo create doku-storage --private --source . --push`.

3. On every other machine: `doku init --clone <your-private-repo-url>`.

From then on `doku sync` does `git add -A`, commits, `pull --rebase` and pushes. The remote must be
named `origin` for the first push. Commits use your normal git identity (`git config --global user.name`
and `user.email`).

### Without a remote, or without git

- **Git but no remote:** `doku sync` still commits locally (handy as history and undo) and skips
  pull/push with a hint. Add a remote whenever you want.
- **No git at all:** everything except `doku sync` works. Move docs between machines with `doku zip`
  and `doku load`, or keep the storage folder in a synced folder like OneDrive. Don't combine
  a cloud-synced folder with git, as the cloud client can corrupt the `.git` folder.

### Moving the storage later

Move or copy the folder, run `doku init --storage <new path>`, then `doku doctor --fix` to repoint every
link on this machine.

## Commands

| Command | What it does |
|---|---|
| `doku init [--storage <path>] [--clone <url>]` | Set the storage for this machine: create it (with `git init`), or clone an existing one. Running it again keeps the current storage. |
| `doku link [projectPath] [name] [--as <folder>] [--no-agents-note]` | Create `storage/<name>/` if needed and link it into the project as `.doku/` (or `--as`). Without a path, links the current folder; inside the storage the path is required. |
| `doku unlink <projectPath\|name> [--as <folder>] [--all]` | Remove the link and everything `link` added to the project. The docs stay in storage. |
| `doku list` | Projects in storage and where each one is linked on this machine. |
| `doku status` | Health of every link, plus uncommitted changes in the storage. |
| `doku sync [-m <msg>]` | `git add -A`, commit, `pull --rebase`, `push` in the storage. |
| `doku ignore [paths...]` | Keep files or folders on this machine only (not synced, not zipped). Without paths, lists the rules. |
| `doku unignore <paths...>` | Undo `doku ignore`. |
| `doku zip [target] [-o <file>] [-s]` | Zip the whole storage, or one project (`doku zip .`), then open the folder containing the zip. `-s`/`--silent` only prints the zip path. |
| `doku load <zip> [--project <name>] [--merge\|--overwrite] [--link <path>\|--no-link] [-y]` | Load a zip into the storage. Asks before creating a project or changing existing files, and never deletes anything. |
| `doku doctor [--fix] [--prune]` | Check links. `--fix` recreates missing or stale ones (e.g. after moving the storage); `--prune` forgets projects that no longer exist. |
| `doku open [name]` | Open the storage, or one project's docs, in VS Code. |
| `doku path [name]` | Print the storage path, or one project's docs path. |
| `doku prompt [--as <folder>]` (alias `doku ai`) | Print short instructions for AI assistants about `.doku/`, ready to paste into `CLAUDE.md`, `AGENTS.md`, etc. |

## What `doku link` changes in a project

1. `.doku/`, a junction into `storage/<name>/`.
2. A `# doku:start … # doku:end` block in `.git/info/exclude` that hides `.doku` (and `CLAUDE.local.md`
   when doku created it). This is git's local-only ignore file, so nothing shows in the project's
   `.gitignore` or in commits.
3. A marked block in `CLAUDE.local.md` telling AI assistants the docs are in `.doku/`
   (skip it with `--no-agents-note`).

For other assistants, or to put the same instructions in a shared file, print them with `doku prompt`:

```sh
doku prompt                 # print to the terminal and copy
doku prompt >> AGENTS.md    # or append to a file
```

`doku unlink` removes all three and deletes `CLAUDE.local.md` if nothing else is left in it.
It only ever removes the link itself, never a real folder and never the docs.

## Keeping docs on one machine: `.dokuignore`

Some docs should not leave the machine they were written on (client data, large exports, scratch files).
List them in `.dokuignore` and they are **not synced** by `doku sync` and **not included** by `doku zip`.

```sh
cd C:/projects/my-project      # any linked project, or any folder inside it
doku ignore file1.md           # → .doku/file1.md
doku ignore folder/            # → .doku/folder/ and everything in it
doku ignore "*.pdf"            # every PDF at any depth
doku ignore                    # list the rules
doku unignore file1.md
```

Paths are taken relative to the project's `.doku/` folder, so `file1.md` and `.doku/file1.md` mean the
same thing. Inside `.doku/` (or its folder in the storage) paths are relative to where you are. Outside
a linked project, `doku ignore` fails with "Not in a doku project".

- The rules live in `storage/<project>/.dokuignore`, which **is** synced, so every machine applies the
  same rules. It uses `.gitignore` syntax, and you can edit it by hand. An optional
  `storage/.dokuignore` applies to all projects.
- doku copies the rules into the storage's local git exclude (`.git/info/exclude`) whenever you run
  `ignore`, `sync`, `status` or `zip`.
- A `.gitignore` anywhere in the docs (for example one that came with a folder you copied into
  `.doku/`) works too: git applies it when syncing, and `doku zip` leaves out the same files, with the same
  rules (deeper `.gitignore` files and `!` patterns win). Use `.dokuignore` for your own rules, since
  `doku ignore` and `doku unignore` only edit that file.
- Ignoring a file that was **already synced** does not stop git from syncing it. doku warns you and prints
  the `git rm --cached` command. Other machines then delete their copy on their next sync.

## Zipping: `doku zip`

```sh
doku zip                       # the whole storage → ./doku-storage.zip (without .git)
cd C:/projects/my-project
doku zip .                     # this project's docs → my-project/.doku.zip
doku zip my-project -o D:/backup/my-project.zip
```

Ignored files are left out. A project zip written into the project is hidden from the project's git.
A zip is never written into the storage itself; if you run `doku zip` there, it goes next to the storage.
Unless you pass `--silent`, the folder containing the zip opens afterwards.

## Loading a zip: `doku load`

```sh
doku load my-project.zip                    # project named in the zip
doku load .doku.zip --project my-project    # load into this project instead
doku load doku-storage.zip                  # whole-storage zip: every project in turn
```

`doku zip` puts a small `.doku-meta.json` into every zip that says which project (or the whole storage)
it holds. `doku load` reads it to pick the storage project; the file itself is never extracted. For zips
without it (made by hand or by the OS), doku suggests a name from the zip's single top folder or the zip's
file name, and you can type another.

- **New project:** doku says the project doesn't exist yet and asks before creating it. Afterwards it
  offers to link it: type a project folder (`.` for the current one), or press Enter to skip and run
  `doku link <projectPath> <name>` later.
- **Existing project:** doku lists new files and files that differ, with line, character and size
  changes (storage → zip), then asks what to do:
  - **append** adds new files and keeps the differing ones as they are,
  - **overwrite** adds new files and replaces the differing ones. Each replaced file is copied to
    `~/.doku/backups/<name>-<time>/` first, outside the storage.
  - **cancel** (the default) changes nothing.

  Files that are only in the storage are always kept. Pass `--merge` or `--overwrite` to answer up front.
- Without an answer (Enter on a yes/no question, or no terminal input), doku does the safe thing: it
  creates nothing and changes nothing. `-y` creates missing projects without asking. It does not choose
  between append and overwrite for you.
- Entries with absolute paths, `..`, invalid names or `.git` are skipped, and doku never writes through
  a link inside the storage.

## Things to know

- **Search skips `.doku/`.** Because it is git-ignored, VS Code's search and ripgrep-based AI search
  tools skip it by default. Reading, writing and listing files works normally. This is why `link`
  adds the note to `CLAUDE.local.md`. To include it in VS Code search, toggle "Use Exclude Settings
  and Ignore Files" in the search panel.
- **Refresh after a pull.** VS Code does not watch through junctions, so changes arriving through
  `doku sync` or a manual copy into the storage appear after an Explorer refresh.
- **Sync conflicts.** If two machines edited the same file, `doku sync` stops mid-rebase and tells you
  what to do; resolve it like any git conflict in the storage folder.
- **Local drives only.** Windows junctions cannot point to network shares.
- **Before deleting a project folder**, run `doku unlink` on it. Most tools remove only the junction,
  but some recursive delete tools follow links and would delete the docs in the storage too.

## Development

```sh
cd doku-cli
npm test           # vitest; uses temp folders and DOKU_HOME, never your real config
npm run typecheck
```
