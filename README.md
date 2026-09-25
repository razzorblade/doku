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
doku remote set <your-private-repo-url>      # the storage's git remote, for syncing
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

Project paths, and even project folder names, can differ between machines. Links are recorded per
machine in `~/.doku/links.json`, never in the storage. If the folder is named differently here, link
it to its docs by name from inside it:

```sh
cd D:/work/project-def
doku link project-abc                      # .doku/ → the docs "project-abc"
```

A plain `doku link` in a folder whose name has no docs yet lists the docs not linked on this machine
and asks which to use, or whether to start new ones. Running `doku link <name>` in a project that is
already linked switches it to those docs. If the old docs were only the empty starter folder from
`doku link`, it is removed; otherwise it stays in the storage.

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
   These are your private notes, so keep the repository private. If even a private repository is
   not enough for what's in them (client data, for example), run `doku encrypt` before the first
   push. See [Encrypting the storage](#encrypting-the-storage).
2. Set it as the storage's remote and push once. This works from any folder:

   ```sh
   doku remote set <your-private-repo-url>
   doku sync          # commits everything and pushes, setting up tracking the first time
   ```

   With the GitHub CLI, step 1 and 2 can be one command run inside the storage:
   `gh repo create doku-storage --private --source "$(doku path)" --push`.

3. On every other machine: `doku init --clone <your-private-repo-url>`. For an encrypted storage it asks for
   the recovery key or passphrase.

From then on `doku sync` does `git add -A`, commits, `pull --rebase` and pushes. `doku remote` shows
the remote, `doku remote set <url>` points the storage at another repository (e.g. after moving it), and
`doku remote remove` takes it away. The remote is the storage's git remote `origin`, so one added with
plain git works too. Commits use your normal git identity (`git config --global user.name`
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

## Encrypting the storage

Your docs may hold things that shouldn't sit readable on GitHub, even in a private repository. In that
case, encrypt the storage:

```sh
doku encrypt                 # asks whether you also want a passphrase, then shows the recovery key
doku sync                    # pushes the encrypted storage
```

On the machine you work on, **nothing changes**: the files in the storage, and in every project's
`.doku/`, stay plain files that you and your AI assistants read and edit as before. Only what leaves the
machine is encrypted: every commit that `doku sync` pushes, and every `doku zip`. Nothing is stored twice.
Git encrypts each file as it goes into the repository and decrypts it on checkout (clean/smudge filters,
the same approach git-crypt uses).

### The recovery key, and an optional passphrase

`doku encrypt` creates a random 256-bit key and shows it once, as a **recovery key**:

```
DOKU1-43ZF7RTV-XB9VETND-21YP6AAG-2Y4PNY19-2X9A4X0C-9QE5MHCJ-R7MDV5ZN
```

Save it in at least two safe places, for example a password manager and a printed copy. doku asks you to
type its last group to confirm you did. `--key-file <file>` also writes it to a file, which you then
move off the machine. Other machines need this key to read the synced docs. doku never puts it in the
repository or sends it anywhere. It lives only in each unlocked storage's `.git` folder.

You can also set a **passphrase** (`doku encrypt --passphrase`, or later with `doku key --passphrase`).
Then either the recovery key or the passphrase unlocks the storage. The passphrase-protected copy of the
key is stored in the repository, so anyone with access to the repository can try to guess the
passphrase offline. Use a long one (a few random words), or skip it and use only the recovery key.

If you lose the recovery key (and the passphrase), your files are still readable and editable on every
machine where the storage is unlocked, and `doku key` shows the key again there. If you also lose all
those machines, nobody can read the encrypted copies, not even you.

### On another machine

```sh
doku init --clone <your-private-repo-url>   # notices the storage is encrypted, asks for the key
```

If you press Enter instead of entering the key, the storage stays **locked**: the files are checked out
still encrypted, `doku status` shows it, and `doku sync` and `doku zip` refuse to run until you unlock
it with `doku unlock`. Nothing unencrypted can be pushed from a locked machine. `--key-file <file>` reads
the key from a file instead of asking.

### What happens to the history

The commits made before `doku encrypt` hold your files unencrypted. So `doku encrypt` replaces the
whole history with a single encrypted commit and deletes the old history from the storage's `.git`. Your
current files are all kept. `--backup-history` saves the old history as a git bundle in
`~/.doku/backups/` first (outside the storage, unencrypted).

If the remote already has the old history, the next `doku sync` replaces it with a force push. Hosts
like GitHub can keep deleted commits cached for a while, and forks or other clones keep their copies.
The safest option is to push to a **new, empty repository** instead
(`doku remote set <new-url>` before `doku sync`), and delete the old one.

Other machines that have the old history get a message on their next `doku sync` telling them to run
`doku unlock`. That command asks for the key and switches the machine to the encrypted history. Files
that only that machine had are kept, and the next sync adds them encrypted. Files that differed from
the remote are copied to `~/.doku/backups/` first.

### What is protected, and what isn't

- **Protected:** the contents of every file on the remote and in encrypted zips. doku uses AES-256-GCM,
  with keys derived by HKDF-SHA256. A passphrase is stretched with scrypt. Tampered data is rejected.
- **Not hidden:** file and folder names, file sizes and commit times are visible on the remote. The same
  content always encrypts the same way (git needs that to see unchanged files as unchanged), so the
  remote can also tell that two files are identical. Zips hide the file names too.
- **Not protected against:** anyone who can use a machine where the storage is unlocked. They can read
  the files and the key there. Encryption protects the remote and the zips, not an unlocked machine.
- **Post-quantum:** doku uses only symmetric crypto, with no public-key exchange that a quantum computer
  could break. Grover's algorithm at best halves the strength of a 256-bit key, which leaves 128 bits,
  still out of reach. So there is no separate `--post-quantum` mode: the default already is one.

### Managing it

| Command | What it does |
|---|---|
| `doku status` | Shows `encryption: on, unlocked`, `LOCKED` or `off`. |
| `doku key` | Shows the recovery key again (only on an unlocked machine). |
| `doku key --passphrase` / `--no-passphrase` | Sets, changes or removes the passphrase; `doku sync` shares the change. Older zips and commits keep accepting the old one. |
| `doku unlock` | Enters the key on this machine (a locked clone, or an old clone of a storage encrypted elsewhere). |
| `doku decrypt` | Turns encryption off. It doesn't ask for the key (an unlocked machine has it anyway), only for you to type `decrypt`. The next `doku sync` pushes every file unencrypted, and other machines switch off on their next sync. Earlier commits stay encrypted; the key is kept in `~/.doku/backups/` so they can still be read. |
| `doku zip --plain` | Writes an unencrypted zip from an encrypted storage. |

`doku load` opens encrypted zips with the storage's own key when it matches. Otherwise it asks for the
zip's recovery key or passphrase, so a zip also opens on a machine without that storage.

Diffs stay readable on unlocked machines: `git diff` and `git log -p` in the storage show plain text.
When two machines edit the same file, `doku sync` merges the decrypted text, and conflict markers show up
in plain text like in any other conflict. If you move the `doku-cli` folder, run `doku doctor --fix` so
git finds doku again. Until you do, git refuses to commit in the storage rather than committing
unencrypted.

## Commands

| Command | What it does |
|---|---|
| `doku init [--storage <path>] [--clone <url>] [--key-file <file>]` | Set the storage for this machine: create it (with `git init`), or clone an existing one (asking for the key when it is encrypted). Running it again keeps the current storage. |
| `doku link [projectPath] [name] [--as <folder>] [--no-agents-note]` | Create `storage/<name>/` if needed and link it into the project as `.doku/` (or `--as`). Without a path, links the current folder; inside the storage the path is required. `doku link <name>` alone links the current folder to the docs `<name>`, and re-linking a project switches it to other docs. |
| `doku unlink <projectPath\|name> [--as <folder>] [--all]` | Remove the link and everything `link` added to the project. The docs stay in storage. |
| `doku list` | Projects in storage and where each one is linked on this machine. |
| `doku status` | Health of every link, plus uncommitted changes in the storage. |
| `doku sync [-m <msg>]` | `git add -A`, commit, `pull --rebase`, `push` in the storage. |
| `doku remote [set <url>\|remove]` | Show the storage's git remote, add it or point it at another repository (`set`, alias `add`), or remove it. |
| `doku encrypt [--passphrase\|--no-passphrase] [--key-file <file>] [--backup-history] [-y]` | Encrypt the storage in git and in zips; files stay plain on this machine. Replaces the history with one encrypted commit. See [Encrypting the storage](#encrypting-the-storage). |
| `doku unlock [--key-file <file>]` | Enter the recovery key or passphrase of an encrypted storage on this machine. |
| `doku key [--passphrase\|--no-passphrase]` | Show the recovery key, or set, change or remove the passphrase. |
| `doku decrypt` | Turn encryption off; the next sync pushes every file unencrypted. |
| `doku ignore [paths...]` | Keep files or folders on this machine only (not synced, not zipped). Without paths, lists the rules. |
| `doku unignore <paths...>` | Undo `doku ignore`. |
| `doku zip [target] [--all] [-o <file>] [-s] [--plain]` | Zip the project you are in (or `target`), then open the folder containing the zip. Outside a project it asks before zipping the whole storage; `--all` zips it without asking. `-s`/`--silent` only prints the zip path. An encrypted storage writes encrypted zips unless you pass `--plain`. |
| `doku load <zip> [--project <name>\|--all] [--merge\|--overwrite] [--link <path>\|--no-link] [-y] [--key-file <file>]` | Load a zip into the storage. Asks before creating a project or changing existing files, and never deletes anything. Encrypted zips ask for their key unless it's this storage's. |
| `doku kit [list]` | Kits in the storage, and where each one is used on this machine. See [Kits](#kits-shared-files-for-project-folders). |
| `doku kit new <name> [paths...]` | Create a kit in the storage, optionally starting it with copies of files from this project. |
| `doku kit add <name> [--overwrite\|--keep-mine] [--dir <folder>]` | Copy a kit into the project folder. Files already there are asked about. |
| `doku kit update [name] [-y] [--overwrite\|--keep-mine] [--dir <folder>]` | Bring kit changes into the project. Asks about files you changed. |
| `doku kit remove <name> [--delete-files\|--keep-files]` | Stop using a kit in the project; offers to delete its files you never changed. |
| `doku kit open [name]` / `doku kit path [name]` | Open a kit in VS Code, or print its path. Kits are only ever edited there. |
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
cd C:/projects/my-project
doku zip                       # this project's docs → my-project/my-project.doku.zip (same as `doku zip .`)
doku zip other-project -o D:/backup/other.zip
doku zip --all                 # the whole storage → ./doku-storage.zip (without .git)
```

Without a target, `doku zip` zips the project you are in: a linked project, any folder inside it or its
`.doku/`, or a project folder in the storage. Anywhere else it asks before zipping the whole storage.

Ignored files are left out. A project zip written into the project is hidden from the project's git.
A zip is never written into the storage itself; if you run `doku zip` there, it goes next to the storage.
Unless you pass `--silent`, the folder containing the zip opens afterwards.

## Loading a zip: `doku load`

```sh
doku load my-project.zip                    # project named in the zip
doku load old.doku.zip --project my-project # load into this project instead
doku load doku-storage.zip --all            # whole-storage zip: every project in turn
doku load doku-storage.zip --project notes  # whole-storage zip: only the project "notes"
```

`doku zip` puts a small `.doku-meta.json` into every zip that says which project (or the whole storage)
it holds. `doku load` reads it to pick the storage project; the file itself is never extracted. For zips
without it (made by hand or by the OS), doku suggests a name from the zip's single top folder or the zip's
file name, and you can type another.

- **Whole-storage zip** (from `doku zip --all`): `--project <name>` loads just that project from it, and
  `--all` loads every project. Without either, inside a project doku offers to load only that project or
  all of them; elsewhere it asks before loading all. Files at the storage root are only loaded with all
  projects, and only added, never replaced.
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

## Kits: shared files for project folders

Some files belong in the project folder itself rather than in `.doku/`, and you reuse them across projects: a
`CLAUDE.md` for a folder that holds several projects, `.mcp.json`, `.vscode/settings.json`,
`.claude/commands/`. A **kit** is a named folder of such files in the storage, laid out the way they should
appear in a project folder. Unlike `.doku/`, a kit is **copied** into the project, not linked. Each project
can then change its copies, and doku still brings in later changes to the kit.

```
my-project/            ← doku kit add multi-root puts CLAUDE.md and .mcp.json here
  .doku/
  unity-project/
  node-server/
  CLAUDE.md
  .mcp.json
```

```sh
cd C:/projects/my-project
doku kit new multi-root CLAUDE.md .mcp.json   # start a kit from files you already have here
doku kit new unity-generic                    # or an empty one, filled in the storage (doku kit open unity-generic)

cd D:/work/other-project
doku kit add multi-root                       # copy it in
doku kit update                               # later: bring in changes to every kit this project uses
```

- Kits live in `storage/.kits/<name>/`. `doku sync` shares them between machines like everything else
  (encrypted too, if the storage is), and `doku list` doesn't show them as projects.
- **Changes only ever flow from the kit to projects.** To change a kit, edit it in the storage
  (`doku kit open <name>`). Nothing you change in a project goes back into the kit, and `doku sync` never
  changes the files in projects. When a sync brings kit changes, it tells you to run `doku kit update`.
- A project folder doesn't need its own docs to use kits. Inside a linked project, kits go to the folder
  that holds `.doku/`, even when you run the command in a subfolder. Elsewhere they go to the current
  folder, or to `--dir <folder>`.
- Several kits can be used in one project, as long as no two of them have the same file.

### What `doku kit update` does with each file

doku remembers which version of each file it last copied, so it can tell your changes apart from the kit's:

| Changed in the project | Changed in the kit | What happens |
|---|---|---|
| no | yes (or new, or removed) | Listed together, with one question: **update** / **ignore** / **later** |
| yes | no | Nothing: the file is yours now |
| yes (or deleted) | yes | Asked per file: **overwrite** (yours is backed up to `~/.doku/backups/`) / **keep mine** / write the kit's version **beside** it as `<file>.kit-new` / **later** |

**Ignore** and **keep mine** are remembered: you're asked again only when the kit changes that file again.
**Later** changes nothing and asks again next time. Without any input (e.g. in a script), nothing changes.
Answer up front with `-y` (apply the changes to files you didn't change), `--keep-mine` (that, plus keep
every file changed in both places) or `--overwrite` (that, plus replace them).

A file you deleted from the project stays deleted until the kit changes it. A file the kit no longer has is
deleted only if you never changed it. `doku kit add` asks the same way about files that are already in the
project folder.

Which projects use which kits, and the versions last copied, are recorded per machine in
`~/.doku/kits.json`, like the links. Files at the root of a folder with several projects usually aren't in any
git repository, so each machine has its own copies. On another machine, run `doku kit add <name>` there once.
Files that already match the kit are simply recorded as up to date. `doku status` shows which projects have
kit changes waiting, and `doku kit remove <name>` stops using a kit in a project.

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
