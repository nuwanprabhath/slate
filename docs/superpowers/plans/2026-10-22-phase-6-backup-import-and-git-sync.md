# Slate Phase 6 — OneNote Backup Import and Git Sync

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Why this phase exists:** personal Microsoft accounts cannot register an Azure app without creating an Azure directory, so Graph-based import and OneDrive sync are blocked for the maintainer. This phase adds two paths that need no Microsoft account:

1. **Import from OneNote's own backup files** (`.one`): OneNote → File → Back Up Notebooks writes `<Section> (On d-m-yyyy).one` files. Slate converts each `.one` section to HTML with the open-source `one2html` converter (Rust; crates.io `one2html` 2.0.1 / `onenote_parser` 2.1.0, MPL-2.0). It then normalises that HTML into the Graph page format the existing importer already maps, and reuses the Phase 3 engine, sink, state, report and dialog.
2. **Git sync:** the user's notebooks are stored in a private git repository (e.g. GitHub) instead of OneDrive. `GitDrive` implements the existing `RemoteDrive` interface over a local clone driven by the system `git`, so the Phase 4 `SyncEngine` (chunks, snapshots, conflicts, convergence) is reused unchanged. OneDrive sync stays as a second provider.

## Global Constraints

- **Never put user notebook content in the repo or tests.** The test fixture is `New Section 1.one` from `msiemens/onenote.rs` (`crates/parser/tests/samples/`, MPL-2.0), committed under `packages/importer/test/fixtures/one/` with a `NOTICE.md` naming its source and licence.
- **The converter binary** is never committed. It is built by `node scripts/build-one2html.mjs`, which runs `cargo +nightly install one2html --version 2.0.1 --root <tmp>` (nightly because `onenote_parser`'s `backtrace` feature needs it) and copies the binary to `packages/desktop/resources/bin/one2html-<platform>-<arch>[.exe]` (gitignored). electron-builder ships `resources/bin`. At runtime the path is `SLATE_ONE2HTML` (env, used by tests), or else the shipped binary. When it is missing, the UI explains how to build it.
- **The converter runs as a child process** with arguments only (no shell), into a temporary directory that is deleted after the import. A conversion error for one section fails that section and is reported; the import continues.
- **Git** runs as the system `git` binary through one runner that:
  - always sets `GIT_TERMINAL_PROMPT=0` and `GIT_SSH_COMMAND="ssh -o BatchMode=yes"`, so git never blocks waiting on a prompt;
  - never runs through a shell;
  - never writes a token to disk: a token reaches git only through `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` (`http.https://github.com/.extraheader` = `AUTHORIZATION: basic base64("x-access-token:<token>")`) for that one child process, and is stored only with Electron `safeStorage`.
- **Git auth modes:**
  - `system` (default: the machine's SSH keys or credential helper);
  - `token` (personal access token, `safeStorage`);
  - `gh` (`gh auth token` read at sync time, never stored);
  - `device` (GitHub OAuth device flow: only when `SLATE_GITHUB_CLIENT_ID` is set, token stored via `safeStorage`).
- **Repo layout** is the same as the OneDrive app folder (`docs/<key>/<device>/<seq>.chunk|snapshot-<seq>.bin`, `blobs/`, `devices/`) plus a `README.md` written once ("This repository is managed by Slate…").
  - One commit per sync push: `slate: <deviceName> (<n> files)`.
  - Branch `main` by default.
  - Pushes retry after `git pull --rebase` (paths are disjoint per device, so a rebase never conflicts); give up after 5 attempts with an error status.
- **Sync provider setting:** `syncProvider: 'onedrive' | 'git' | null` (null = off). Git settings: `{ remoteUrl, branch, auth }`.
- **E2E and unit tests never touch the network or the user's GitHub:** git tests use local bare repos (`git init --bare` in a temp dir, `file://` URLs); backup-import tests use the fixture.
- Conventional Commits, no AI attribution, never push the Slate source repo.

---

## Part A — OneNote backup import (WP-U)

### Task A1: the converter build script and fixture

- `scripts/build-one2html.mjs`: requires `cargo` and `rustup` on PATH (or `CARGO_HOME`/`RUSTUP_HOME` set). It ensures the nightly toolchain (minimal profile), builds `one2html` 2.0.1, copies it to `packages/desktop/resources/bin/`, and prints the path. `npm run build:one2html` at the root runs it.
- `.github/workflows/ci.yml`: install Rust nightly and run `npm run build:one2html` before `dist` on each OS.
- `packages/importer/test/fixtures/one/New Section 1.one` + `NOTICE.md`. Also commit the converter's output for it, under `packages/importer/test/fixtures/one2html/` (`New Section 1.html` index plus `New Section 1/Test Page.html` and the image), generated once with the binary. This lets the pure TypeScript tests run without the binary.

### Task A2: normalise one2html output (pure, `@slate/importer`)

- `normalizeOne2HtmlPage(html: string): string` returns a Graph-style page.
  - The output is `<html><head><title>…</title></head><body data-absolute-enabled="true" style="font-family:Calibri;font-size:11pt">` with one `<div style="position:absolute;left:Xpx;top:Ypx;width:Wpx">` per one2html `container-outline`. Its `left`/`top` come from the outline's absolute style and its width from the `max-width`.
  - The outline's content keeps its blocks: `outline-element` divs become paragraphs, lists keep `ul`/`ol` and `li`, plus tables and images. one2html's class-based list styling is dropped. Inline font and colour styles are kept, so `mapOneNotePage` turns them into marks.
- `parseOne2HtmlSection(indexHtml: string): Array<{ title: string; file: string; level: number }>` reads the page order from the index's `<nav>` links. Use nesting depth for levels if one2html emits it, else 0.
- Unit tests are built on the committed fixture output:
  - the normalised HTML of `Test Page.html` passed through `mapOneNotePage` gives boxes with the fixture's positions and text;
  - the section index gives the page list in order.

### Task A3: `BackupSource` and the desktop wiring

- `packages/desktop/src/main/onenote/backup.ts`:
  - `scanBackup(paths: string[]): BackupSection[]`. It accepts `.one`/`.onepkg` files and folders; strips ` (On d-m-yyyy)`; keeps the newest dated copy per section name (by the date in the name, then mtime); ignores `OneNote_RecycleBin`; and names the notebook after the folder (`Notes Outlook - Personel` → `Outlook - Personel`, stripping a leading `Notes `).
  - `class BackupSource implements GraphSource` over a scan:
    - `listTree()` returns one notebook whose sections are the scanned files;
    - `listPages(sectionId)` converts the section (once, cached by path+mtime) and returns pages with `lastModified` = the file's mtime ISO;
    - `pageContent` returns `normalizeOne2HtmlPage(file html)`;
    - `resource(url)` reads the image file from the conversion dir, with mime sniffed from magic bytes.
  - Page ids are `<sectionId>/<page file name>`, so re-imports are stable. The temp dirs are removed on `close()`.
- `ImportService` gains `startBackup(paths: string[], sectionNames: string[])`, which reuses `runImport` with `BackupSource` and the same sink and state. Mapping keys are prefixed `backup:` so they never collide with Graph ids.
- **IPC and preload:** `onenote.pickBackup(): Promise<{ paths: string[]; sections: Array<{ id: string; name: string; date: string }> } | null>` (native open dialog for files or folders, user-initiated), plus `onenote.startBackup(paths, sectionIds)`.
- **UI:**
  - File → "Import from OneNote backup…" (id `import-onenote-backup`), and the same entry in the import dialog's first screen;
  - the picker lists the sections, with the backup date beside each name;
  - the running, report and retry views are reused.
- **Headless CLI:** `packages/desktop/src/mcp/importCli.ts` (built as `out/main/import-cli.js`, a third electron-vite main entry) runs with `ELECTRON_RUN_AS_NODE=1`:
  - `--backup <path>… --sections <name,…> [--user-data <dir>]` imports into that data folder's `slate.db`;
  - it prints progress lines to stderr and a JSON report to stdout;
  - it refuses to run when another Slate process holds the database, using a `slate.lock` file the app writes at start and removes at quit, plus a pid check.
- **Tests:**
  - `backup.test.ts` (test:main) covers the scan rules on a temp folder with dated names, and a conversion of the fixture `.one` through the real binary (skipped with a reason when `SLATE_ONE2HTML` is unset);
  - `e2e/onenote-backup.spec.ts` drives File → Import from OneNote backup with the fixture, using a `SLATE_E2E_BACKUP_PATH` env var to bypass the native dialog in e2e, and asserts that the page appears with its boxes and image.

---

## Part B — Git sync (WP-V)

### Task B1: `GitDrive` (`@slate/sync`)

- `packages/sync/src/gitRunner.ts`: `type GitRunner = (args: string[], opts?: { cwd?: string; env?: Record<string, string>; input?: Uint8Array }) => Promise<{ code: number; stdout: Uint8Array; stderr: string }>`, plus `nodeGitRunner(gitPath = 'git')` over `child_process.spawn`, which applies the prompt-free environment from Global Constraints.
- `packages/sync/src/gitDrive.ts`: `class GitDrive implements RemoteDrive` with `{ run: GitRunner; dir: string; remoteUrl: string; branch: string; authEnv: () => Promise<Record<string, string>>; author: { name: string; email: string } }`.
  - `ensureClone()`: if `dir` has no `.git`, clone. An empty remote is handled: `git init`, add the remote, then a first commit with `README.md` and a push.
  - `upload(path, bytes)`: write into the work tree, then `git add`.
  - `remove(path)`: `git rm`.
  - `flush()`, a new optional `RemoteDrive` method: if anything is staged, commit, then push with the rebase-retry loop.
  - `delta(cursor)`: `git fetch`, then rebase the local branch onto `origin/<branch>`. Then:
    - when `cursor` is null, list every file from `git ls-tree -r HEAD`;
    - otherwise use `git diff --name-status <cursor> HEAD`.

    Items have `id = path`, `eTag` = the blob sha (`git ls-tree`), `deleted` for `D`, and `isFile: true`. The new cursor is the HEAD sha.
  - `download(path)`: read the work-tree file. delta has already brought it up to date.
  - Network errors (exit code non-zero with "Could not resolve host", "Connection refused", "unable to access", or a timeout) throw `OfflineError`. Auth failures ("Authentication failed", "Permission denied (publickey)") throw an error with `status: 401`, so the engine reports `signed-out`.
- `RemoteDrive` gains `flush?(): Promise<void>`. `SyncEngine` calls it after the push phase and again at the end of `syncOnce` (pull-phase restores and compaction uploads). This is a small engine change with a test that a drive without `flush` behaves as before.
- **Tests (real git, local bare repos, no network):**
  - two `GitDrive`s on separate clones of one bare repo, each wrapped by a `SyncEngine` with `memoryLocal`, converge;
  - concurrent pushes rebase and both land;
  - a compaction removal is committed;
  - an empty bare repo gets the README commit;
  - an unreachable `file:///does/not/exist` URL gives `status: 'offline'` or an error, never a hang (keep the timeout under 10 s);
  - the token env never appears in `.git/config`.
  - Re-run the existing simulation with a `GitDrive`-backed variant over 1 seed (it is slower), and assert convergence.

### Task B2: desktop provider, auth, UI and e2e

- **Settings:** `syncProvider`, `git: { remoteUrl, branch, auth }`. The `syncEnabled` from Phase 4 migrates as `syncEnabled: true` → `syncProvider: 'onedrive'`.
- `SyncService` builds the drive per provider. For git:
  - a `GitDrive` with `dir` = `<userData>/git-sync/repo`;
  - `authEnv` per auth mode: `system` → `{}`; `token` → the decrypted `safeStorage` token as `GIT_CONFIG_*`; `gh` → `gh auth token` (spawned, no shell); `device` → the stored device-flow token;
  - author = `Slate (<deviceName>)` / `slate@<deviceId>.local`.
- **`git/auth.ts`:**
  - `githubDeviceFlow(clientId)` (POST `https://github.com/login/device/code`, show `user_code` + `verification_uri`, poll `https://github.com/login/oauth/access_token`);
  - `createPrivateRepo(token, name)` (POST `https://api.github.com/user/repos` `{ name, private: true, auto_init: false }`), offered when a token is available (`token`, `gh` or `device` modes);
  - `testConnection()`, which runs `git ls-remote <url>` with the auth env and returns ok or a readable error.
- **UI:** the sync popover gets "Sync settings…", opening an in-app `SyncSettings` overlay (`data-testid="sync-settings"`):
  - provider radio: Off / OneDrive / Git repository;
  - for Git:
    - repository URL (`git@github.com:user/repo.git` or `https://…`);
    - branch;
    - auth radio: "Use this computer's git setup (SSH key or credential helper)" (default), "GitHub CLI (gh)", "Personal access token" (masked field), "Sign in with GitHub" (only when `SLATE_GITHUB_CLIENT_ID` is set);
    - "Create a private repository for me…" (only with token, gh or device);
    - "Test connection", then "Save & sync".
  - The status icon's tooltip names the provider ("Synced to GitHub" / "Synced to OneDrive").
- **e2e** `e2e/git-sync.spec.ts`: a local bare repo in a temp dir and two app instances, A and B, with git provider `file://<bare>`, `system` auth and `SLATE_SYNC_INTERVAL_MS=500`.
  - A types "hello over git", and B shows it.
  - Settings saved through the overlay persist across a relaunch.
  - `git log` of the bare repo shows commits from both devices, and no token or `extraheader` in any config.

---

## Done criteria

- **Backup import:** a OneNote backup folder imports with page order, positioned boxes, text formatting, lists, tables and images, with no Microsoft account. Re-import skips unchanged pages. `import-cli` imports headlessly.
- **Git sync:** notebooks sync through a private git repo using the machine's SSH, a token or `gh`, and live delivery and conflicts work as with OneDrive.
- All unit, main-process and e2e tests pass. Nothing touches the network in tests.
