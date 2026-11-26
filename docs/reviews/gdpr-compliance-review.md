# GDPR compliance review: privacy by design and by default

| | |
| --- | --- |
| Scope | The whole monorepo at `main` e44ea5e (v0.7.14): `packages/{core,editor,desktop,sync,mcp,importer,native}`, `bin/`, `scripts/`, `tools/` |
| Regulation | Regulation (EU) 2016/679: Art. 5, 6, 7, 12–14, 15–20, 25, 30, 32, 44–49 |
| Date | 2026-11-26 |
| Method | Read-only audit. Every outbound network call, subprocess, storage sink, IPC channel and MCP tool was found by search (`fetch`, `net.fetch`, `node:{http,https,net,tls,child_process}`, `spawn`/`execFile`, `getPath`, `tmpdir`, `writeFile`, `CREATE TABLE`, `localStorage`, `safeStorage`, `CH.*`), then read at the call site. No source file was changed. |
| Reads first | `CLAUDE.md`, `SECURITY.md`, `docs/compliance/{security-policy,poam}.md`, `eslint.config.mjs`, `.dependency-cruiser.cjs`, `tools/guards/security-paths.txt` |

## 0. Summary and how GDPR applies here

Slate is a local-first desktop app. Notes live on the user's own disk, and the maintainer runs no
server that receives them. For data that stays on the device, the user is in control and no controller
is involved. GDPR obligations arise in three places:

1. **Flows the maintainer designed into the software, where a third party receives personal data
   without a separate user choice.** The update check is one: a packaged app contacts `github.com`
   10 seconds after launch, by default, and sends the IP address, User-Agent, platform and version.
   For that processing the maintainer is the controller who chose the means, and GitHub, Inc. (USA)
   is the recipient.
2. **Integrations the user turns on**: git sync, OneDrive sync, OneNote online import, the GitHub
   device sign-in, and Claude theme generation. The user is the one who decides. The software still
   owes Art. 13-style transparency and Art. 25 safe defaults, because organisations that deploy Slate
   (an employer rolling it out, for example) are controllers, and Art. 25 binds them through the tools
   they choose.
3. **Art. 25 and Art. 32 engineering duties for local data.** These cover data minimisation in logs,
   retention, erasure, portability, and encryption at rest. A deploying organisation can meet Art.
   15–20 requests only if the tool supports them.

Slate's security work is already strong, and much of it supports GDPR directly:

- the renderer has no network access (CSP `default-src 'none'`);
- notes and images can be encrypted end to end, and key handling is exemplary;
- spellcheck never downloads dictionaries (`main/spellcheck.ts`);
- Chromium's disk cache is off (`main/index.ts:97`);
- the diagnostic log is off by default and redacted on the way in;
- AI agents see nothing until the user grants access per item (`core/src/tree.ts:24-25`), private boxes stay hidden, and MCP stops while the vault is locked;
- tokens are kept only in a real OS keyring (`main/secretStorage.ts`).

The gaps are concentrated in four themes:

| Theme | Worst finding | Severity |
| --- | --- | --- |
| Network calls without prior consent | GDPR-01: an automatic update check on first launch. GDPR-02: the user's opt-out is ignored while the vault is locked. | High |
| Unencrypted sync to third parties without a warning | GDPR-03: notes, the hostname and the device name sent in clear to GitHub or OneDrive | High |
| Erasure and storage limitation | GDPR-04: deleted text survives in CRDT history, in freed SQLite pages, in images never collected, and in remote history | High |
| Data-subject tooling and logs | GDPR-05 to GDPR-13: no full export or erase; tokens and clones kept after sync is disabled; raw search queries kept in the audit table; gaps in the security log and in redaction | Medium |

There are **no Critical findings**. There are 4 High, 9 Medium and 7 Low (20 in total). Section 2
covers each one. Section 3 groups 100% of the fixes into six workstreams that touch disjoint files.
Workstream A lands first; B–F then run in parallel.

---

## 1. Complete codebase surface inventory

Legend for **Default**: `auto` = happens without any user action; `opt-in` = happens only after the user enables or starts it; `user action` = a one-off click.

### 1.1 Outbound network and subprocess table

#### Network (shipped app)

| # | File:Line | Mechanism | Destination / host | Data transmitted | Trigger / default |
| --- | --- | --- | --- | --- | --- |
| N-1 | `desktop/src/main/update/electronBackend.ts:64-65` (via `electron-updater`) | `autoUpdater.checkForUpdates()` (Chromium net stack) | `github.com/nuwanprabhath/slate/releases/…/latest-{mac,linux}.yml` (redirects to `objects.githubusercontent.com`) | IP address, User-Agent (Electron/Chromium/OS version), app version (implied by URL request pattern), TLS fingerprint | **auto**: `FIRST_CHECK_MS = 10_000` after launch (`update/updateService.ts:89,122-128`), then every 6 h (`shared/settings/schema.ts:48-49`); packaged builds only (`update/index.ts:35,69`) |
| N-2 | `update/electronBackend.ts:113-121` | `net.fetch` | `github.com/…/releases/download/v<ver>/<name>.sig` etc. (`update/versions.ts:21-25`) | IP, UA, the version being offered | **auto**, as part of each N-1 check (signature verification) |
| N-3 | `update/electronBackend.ts:84-112`, `:70-79` | `net.fetch` / `autoUpdater.downloadUpdate()` | GitHub release assets | IP, UA | user action (Download / Install) |
| N-4 | `update/electronBackend.ts:127`, `update/updateService.ts:229` | `openExternalSafe` → system browser | `github.com/…/releases/tag/v<ver>` | Browser request (outside Slate) | user action |
| N-5 | `sync/src/gitRunner.ts:121` (spawned by `main/sync/syncService.ts`) | `git fetch/push/ls-remote` over SSH or HTTPS | User-configured remote (typically `github.com`) | **All note sync files** (plaintext unless a vault exists), commit author `Slate (<hostname>)` / `slate@<deviceId>.local`, commit message with hostname (`syncService.ts:321-324`, `gitDrive.ts:94-95,211`), device record `{name: hostname, platform, appVersion}` (`sync/src/engine.ts:272-277`), credentials | opt-in; then **every 30 s** (`syncService.ts:49,473`) |
| N-6 | `sync/src/oneDrive.ts:53` | `fetch` | `graph.microsoft.com/v1.0` (`main/index.ts:346`) | Note sync files (plaintext unless vault), device record as N-5, OAuth bearer token | opt-in; every 30 s |
| N-7 | `main/onenote/auth.ts:22,82-84` (MSAL) | MSAL interactive + silent token | `login.microsoftonline.com/common` | Account identifier, refresh token, scopes `Notes.Read Files.ReadWrite.AppFolder User.Read offline_access` (`auth.ts:21`) | user action (Sign in), silent refresh thereafter |
| N-8 | `importer/src/graph.ts:3,109,239` | `fetch` | `graph.microsoft.com/v1.0/me/onenote/…` | Bearer token; receives the user's OneNote pages and images | user action (Import) |
| N-9 | `main/sync/git/auth.ts:44-71` | `fetch` | `github.com/login/device/code`, `github.com/login/oauth/access_token` | OAuth client id, device code; scope **`repo`** (`auth.ts:46`) | user action; only when `SLATE_GITHUB_CLIENT_ID` is set (`index.ts:362`) |
| N-10 | `main/sync/git/auth.ts:74-89` | `fetch` | `api.github.com/user/repos` | Bearer token, repository name | user action (Create repo) |
| N-11 | `main/sync/transportProbe.ts:22-39,66-74` | `tls.connect` (handshake only) | `graph.microsoft.com`, `login.microsoftonline.com` | IP, TLS ClientHello (no HTTP bytes) | auto **once OneDrive sync is on**: on remote change and daily after a successful sync (`syncService.ts:602-607`) |
| N-12 | `transportProbe.ts:75-88` → `git ls-remote` | git over SSH/HTTPS | configured git remote | Credentials, IP | as N-11, for git |
| N-13 | `main/openExternal.ts:40`, `main/hardening.ts:22-24` | `shell.openExternal` (https / mailto only) | Any link in a note | Browser request (outside Slate) | user action (Cmd-click link) |
| N-14 | `main/spellcheck.ts:9,24-27` | Chromium Hunspell download, **neutralised** | `127.0.0.1:9` (discard) | none | n/a: dictionary URL points at loopback; macOS uses the system checker |

#### Subprocesses (shipped app)

| # | File:Line | Command | Data passed | Network? | Trigger / default |
| --- | --- | --- | --- | --- | --- |
| P-1 | `main/theme/claudeOneShot.ts:32` | `$SHELL -l -c 'command -v claude'` | none (runs the user's login dotfiles) | no | auto **when Settings → Appearance opens** (`renderer/src/settings/sections/AppearanceSection.tsx:25` → `CH.themesClaude`) |
| P-2 | `main/theme/claudeOneShot.ts:57-65` | `claude -p --tools "" --safe-mode … <prompt>` via login shell | The user's free-text theme description + current theme spec (`shared/theme/prompt.ts`) | **yes: Anthropic API under the user's Claude account (USA)** | user action ("Describe a theme") |
| P-3 | `main/sync/git/auth.ts:15` | `gh auth token` | none; reads the user's GitHub CLI token | no (token later used by N-5) | opt-in (`auth: 'gh'`), every sync |
| P-4 | `main/onenote/backup.ts:101` | `one2html --input <.one> --output <tmpdir>` | OneNote backup file → plaintext HTML in `$TMPDIR/slate-one2html-*` | no | user action (Import backup) |
| P-5 | `main/vault/screenLock.ts:34,41` | `gdbus monitor` (Linux) | none | no | auto when lock-on-screen-lock is on |
| P-6 | `main/update/electronBackend.ts:26-29` | `xattr -w com.apple.quarantine` | download path | no | after an update download |
| P-7 | `main/update/platformInstaller.ts` (via `proc.ts`) | `sudo`/`pkexec` + `resources/update/*.sh` | password on stdin, package path | no | user action (Install and restart) |
| P-8 | `sync/src/gitRunner.ts:121` | `git` (local operations) | sync files | see N-5 | opt-in |
| P-9 | `desktop/src/mcp/cli.ts`, `bin/slate-mcp` | Launched **by the AI client**, not by Slate | MCP stdio | depends on the agent | user registers it with an agent |

#### Build-time / developer only (not shipped; out of GDPR scope for end users, listed for completeness)

| File:Line | Mechanism | Destination |
| --- | --- | --- |
| `packages/native/scripts/fetch.mjs:11` | `fetch` | OpenSSL / SQLCipher source tarballs (pinned in `deps.lock.json`) |
| `scripts/validate-oscal.mjs:37` | `fetch` | `github.com/usnistgov/OSCAL` schema |
| `scripts/build-one2html.mjs` | `cargo` | crates.io |
| `scripts/agents/*.mjs`, `scripts/traceability.mjs`, `scripts/ui-review.mjs` | `git`, `security` (Keychain) | local only |

### 1.2 Local storage and persistence table

`<data>` = `~/Library/Application Support/Slate` (macOS), `$XDG_CONFIG_HOME/Slate` (Linux), `%APPDATA%\Slate` (Windows) (`main/paths.ts:8-14`); the folder is chmod 0700 when MCP starts (`mcp/socketPath.ts:43`).

| # | File:Line | Path / type | Encrypted at rest? | PII / user content? | Retention / cleanup |
| --- | --- | --- | --- | --- | --- |
| S-1 | `main/store.ts:25-27,395` | `<data>/slate.db` `snapshots`, `updates` (Loro CRDT, **full history**) + `-wal`, `-shm` | SQLCipher when a vault exists; **plaintext otherwise** (default) | All note content, **including text the user deleted** (Loro `mode: 'snapshot'` keeps history) | Forever. No `secure_delete`, no `VACUUM` (`db/openDatabase.ts:133-134` sets WAL only) |
| S-2 | `store.ts:38` | `search` FTS5 (trigram) | as S-1 | Plain text of every box | Rewritten on edit; freed pages are not zeroed |
| S-3 | `store.ts:29,11,144` | `audit` (MCP tool calls) | as S-1 | tool, target: page ids, notebook/section ids, **raw search query up to 200 chars** (`mcp/src/tools.ts:8,101`) | Last 10,000 rows, no age limit |
| S-4 | `store.ts:35` | `conflicts` | as S-1 | `mine`/`theirs`/`merged` note text + other device's name | Until the user resolves each one |
| S-5 | `store.ts:36,12` | `notices` | as S-1 | Generic sync messages | Last 1,000 rows |
| S-6 | `store.ts:28`, `main/settings.ts` | `settings` (JSON) | as S-1 | git remote URL (owner/repo), MS client id, deviceId, theme prompts (`theme/themeStore.ts`, 2000 chars) | Forever |
| S-7 | `store.ts:30-34,37` | `import_items`, `import_map`, `sync_meta`, `sync_seen`, `blob_synced`, `transport_observations` | as S-1 | OneNote ids, sync cursors, host names | Forever; **not removed when sync is turned off** |
| S-8 | `main/blobs.ts:67-105`, `services.ts:82-87` | `<data>/blobs/<sha256>.<ext>` (plaintext install) or `blob_data` table (vault) | Files: **no**; table: SQLCipher | Images pasted into notes | **Never garbage-collected**; an image removed from every page stays |
| S-9 | `main/log/configure.ts:18-24`, `log/logger.ts` | `<data>/logs/slate*.log` | No (0600) | Redacted events; git stderr (`syncService.ts:156`) | Off by default; 7 days / 20 MB **only while on**; switching off leaves the files (`logger.ts:65`) |
| S-10 | `log/configure.ts:30-32`, `log/securityEvents.ts` | `<data>/security-log/slate*.log` | No (0600) | Unlock/lock times and methods, IPC sender origins, self-test results | **Always on**, 90 days / 2 MB; no UI to view, export or clear |
| S-11 | `index.ts:324`, `onenote/auth.ts:30-44` | `<data>/msal-cache.bin` | Yes: OS keyring (`safeStorage`), never plaintext | Microsoft account id/username, refresh token | Sign-out removes accounts (`auth.ts:99`); file remains |
| S-12 | `sync/syncService.ts:239-240` | `<data>/git-sync/token.bin`, `github-device-token.bin` | Yes: OS keyring | GitHub tokens | **Kept after sync is disabled** (`syncService.ts:521-530`) |
| S-13 | `syncService.ts:310,317` | `<data>/git-sync/<hash>/`, `<hash>.vault/` (git clones) | Plaintext files for an unencrypted remote; ciphertext for a vault | Note sync files, history, author identity | **Kept after sync is disabled or the remote changes**; deleted only by vault migration (`vault/migration.ts:241-254`) |
| S-14 | `vault/*`: `vault.json`, `local-keys.json`, `preunlock.json`, `quick-unlock.bin`, throttle, `vault.seen.json`, migration files | `<data>/` | Wrapped keys / MAC'd; quick unlock sealed by keyring (`vault/quickUnlock.ts:16,165`) | Theme id, lock settings (no content) | Lifecycle of the vault |
| S-15 | `main/onenote/backup.ts:184` | `$TMPDIR/slate-one2html-*/` | **No** | Whole OneNote sections as HTML | Removed on `close()` (`backup.ts:60-61`, `importService.ts:187-191`); **survives a crash**; no startup sweep |
| S-16 | `main/theme/claudeOneShot.ts:59` | `$TMPDIR/slate-theme-*` | n/a (empty cwd) | none | Removed in `finally` |
| S-17 | `update/index.ts:39-40`, `electronBackend.ts:87-106` | `~/Downloads/<installer>`, `<data>/update-result.json` | n/a | none | .deb deleted after install (`platformInstaller.ts:273`); dmg and AppImage downloads stay |
| S-18 | `renderer/src/layout.ts:88-140`, `ColorPalette.tsx:11-20`, `lock/MigrationBanner.tsx:29-37` | Chromium `Local Storage` (leveldb) under `<data>` | No | Panel layout, custom colours, a banner flag | Forever; not covered by the vault |
| S-19 | Chromium profile (`Preferences`, `Session Storage`, `GPUCache`, `Code Cache`, `Crashpad/` dir) | `<data>` | No | No note content expected (disk cache 1 B, `index.ts:97`; no `crashReporter.start` anywhere) | Electron-managed |
| S-20 | `main/lock.ts:9`, `native/fipsConfig.ts:48`, `mcp/socketPath.ts:21-25` | `slate.lock` (pid), `fips/openssl-fips.cnf`, `mcp.sock` | n/a | none | Process lifetime / static |
| S-21 | System clipboard (`main/copyHtml.ts`, `index.ts:281-298`, `ipc.ts:75`) | OS clipboard | No | Copied note content (rich HTML with images as data URLs) | Cleared at lock if Slate copied within the window (`vault/lockSequence.ts:95-97`) |
| S-22 | OS keyring | `safeStorage` master key entries (Electron "Slate Safe Storage") | Yes | Wraps S-11, S-12, quick unlock | Never removed by Slate |

### 1.3 IPC, MCP and plugin boundary table

All IPC goes through one registrar (`main/ipcGuard.ts:72-…`); every handler validates its arguments (`shared/ipcValidators.ts`), and only `pre-unlock` channels are served while locked.

| Boundary | Channels / tools | User data crossing | Locked? | Notes |
| --- | --- | --- | --- | --- |
| Renderer ↔ main: notes | `docsList/Load/Append/Remove`, `blobsPut/CopyImage/CopyRich`, `searchQuery`, `pagePrint`, `clipboardText` | All note content, images, search queries | refused | `ipc.ts:30-76`, `print.ts`, `copyHtml.ts` |
| Renderer ↔ main: settings | `settingsGet/Set/Changed`, `themes*` | Settings incl. git remote, theme prompts | refused (theme preunlock read only) | `theme/ipc.ts:64-84` |
| Renderer ↔ main: AI audit | `auditList` | MCP audit rows incl. raw search queries | refused | `ipc.ts:71-74` |
| Renderer ↔ main: diagnostics | `diagnostics{Status,Read,Copy,Clear,OpenFolder,RendererError,CopyReport}` | Redacted log text to clipboard | refused | `log/configure.ts:47-76` |
| Renderer ↔ main: OneNote | `onenote*` | MS account name, page tree, backup paths | refused | `ipc.ts` `registerOneNoteIpc` |
| Renderer ↔ main: sync | `sync*`, `syncCheckTransport` | Remote URL, token (write-only into keyring), conflict text | refused | `syncService.ts` |
| Renderer ↔ main: updates | `update*` (`updateState` pre-unlock) | none | partly | `update/ipc.ts` |
| Renderer ↔ main: vault | `vault*` (secret channels via `secretHandler`) | Passwords / recovery keys as zeroed bytes | pinned subset | `vaultIpc.ts` |
| Main ↔ AI agent (plaintext install) | `slate-mcp` stdio opens `slate.db` directly (`mcp/cli.ts:47-49`) | Pages the user granted (`access` map), never private boxes (`core/src/agentView.ts`) | n/a (no vault) | Tools: `list_tree`, `read_page`, `search`, `append_to_page`, `create_page` (`packages/mcp/src/tools.ts`) |
| Main ↔ AI agent (vault) | `slate-mcp` → `<data>/mcp.sock` byte proxy (`mcp/cli.ts:19-41`, `main/mcp/socketServer.ts`) | as above | **socket closed at lock** (`index.ts:594,1089` `closeMcp`) | Max 8 clients; socket dir 0700, owner-checked |
| Renderer plugins | `renderer/src/plugins/*` (activity bar: search, AI activity, …) | In-process, built-in only; README states third-party code cannot run | n/a | No plugin can reach the network (CSP + lint `slate/renderer-no-network`) |

---

## 2. Exhaustive GDPR findings

### High

#### GDPR-01: Update checks contact GitHub automatically on first launch, without notice or a choice

- **Severity:** High. **Articles:** 5(1)(a), 6(1), 13(1)(c)–(f), 25(2), 44.
- **Where:** `shared/settings/schema.ts:48-49` (`updateAutomaticChecks: true`, every 6 h); `main/update/updateService.ts:89` (`FIRST_CHECK_MS = 10_000`), `:122-128`; `main/update/index.ts:35,69`; `update/electronBackend.ts:64-65,113-121`; `update/versions.ts:21-25`.
- **Evidence and risk:** a packaged install sends a request to `github.com` 10 s after first launch and then every 6 h. GitHub, Inc. (USA) receives the user's IP address and User-Agent; its edge network logs them and links them over time. Nothing in-app says this happens before it does. The only disclosure is a help line in Settings → Updates (`renderer/src/settings/sections/UpdatesSection.tsx:87`), which a user sees only after the first check has already run. Legitimate interest (Art. 6(1)(f), keeping security fixes flowing) is a plausible lawful basis. But Art. 13 requires the information "at the time when personal data are obtained", and Art. 25(2) requires the protective setting by default. The US transfer relies on GitHub's EU-US Data Privacy Framework certification, which the user is never told about.
- **Fix:**
  1. Under `gdprStrictMode`, automatic checks run only after an explicit `consents.updates` grant from the first-run privacy card (workstream F). The card names `github.com` / `objects.githubusercontent.com`, says what is sent (IP address, app version, OS), and links the privacy notice.
  2. "Check now" stays available as a one-off user action.
  3. `UpdateService.settings()` returns `automaticChecks: allowed('updates') && s.updateAutomaticChecks` (workstream B).

#### GDPR-02: The user's update opt-out is ignored while an encrypted vault is locked

- **Severity:** High. **Articles:** 7(3), 21, 25(2).
- **Where:** `main/update/index.ts:21,60-63` (`const s = open ? readSettings(open) : DEFAULT_SETTINGS`); `main/vault/preunlock.ts:9-18` (no update field); `main/index.ts:386` (updates created before unlock).
- **Evidence and risk:** a user with a vault turns off "Check for updates automatically". After the next launch, until they unlock, `store()` is `null`, so the service falls back to `DEFAULT_SETTINGS` and schedules a check 10 s later. If the app sits at the lock screen, it keeps checking every 6 h. Withdrawing an objection or consent must be as effective as giving it (Art. 7(3)); here it silently fails exactly for the users who care most about privacy.
- **Fix (fail closed):** when the store is closed, `settings()` returns `{ automaticChecks: false, intervalHours: DEFAULT }`, and `settingsChanged()` re-arms the schedule after unlock. This needs no change to the preunlock format (a MAC'd, security-path file). Add a unit test: while locked with the defaults, `start()` arms no timer (workstream B).

#### GDPR-03: Unencrypted sync can be switched on with no warning, and it publishes the hostname and device name

- **Severity:** High. **Articles:** 5(1)(c), 5(1)(f), 13, 25(1)–(2), 32(1)(a), 44.
- **Where:** `renderer/src/sync/SyncSettings.tsx` (no encryption warning or acknowledgement anywhere in the enable flow); `main/sync/syncService.ts:237` (`deviceName = hostname()`), `:321-324` (author `Slate (<hostname>)`, `slate@<deviceId>.local`, commit message naming the host), `:344-351` (device record); `sync/src/engine.ts:272-277` (`devices/<id>.json` = `{name, platform, appVersion}`); `sync/src/gitDrive.ts:211`.
- **Evidence and risk:**
  - Without a vault (the default state), turning on git or OneDrive sync uploads every note in clear to GitHub or Microsoft (both US companies). It does so every 30 s, into a history that is never rewritten.
  - The hostname often contains the person's name ("Annas-MacBook-Pro"). It is written into every commit's author and message and into the device record.
  - The warning comes only afterwards, in Settings → Security → Quantum readiness (`quantumReadinessText.ts:135`).
  - Encryption exists and does strip these identifiers (`syncService.ts:322-323`), but nothing steers the user to it at the point of decision.
- **Fix:**
  1. Under strict mode, `syncService.configure()` refuses a provider while there is no vault unless `consents.plaintextSync` has been granted, with `PlaintextSyncRefused` shown in the UI (workstream C).
  2. The enable flow shows the A-provided `ConsentDialog`: it lists the endpoints and data types, and offers "Encrypt my notes first" as the primary button.
  3. Whatever the encryption state, strict mode makes the identity pseudonymous: author `Slate` / `slate@invalid`, commit message `slate: sync`, and a device record name of `Device <first 8 of deviceId>`, with the real name kept only in local settings as an optional label.

#### GDPR-04: Erasure is not effective. Deleted text and images persist locally and remotely

- **Severity:** High. **Articles:** 5(1)(e), 17, 25(2), 32.
- **Where:**
  - Loro full-history snapshots: `main/store.ts:395`, `main/mcp/docSource.ts:152`, `sync/src/engine.ts:231`.
  - No `secure_delete`/`VACUUM`: `main/db/openDatabase.ts:107-141`.
  - Page removal deletes rows only: `store.ts:405-418`.
  - Images are never collected: `main/blobs.ts:67-105`.
  - Remote history: `sync/src/gitDrive.ts:190-211` (every sync is a commit).
  - Remote self-heal re-pushes "lost" files: `sync/src/engine.ts:441-450`.
- **Evidence and risk:**
  - Loro's `snapshot` export keeps the whole operation log, so text a user deleted from a box can be recovered from `slate.db`, from any sync file, and from every synced device.
  - Deleting a page frees its SQLite pages without zeroing them. On a plaintext install the text stays readable in the file and the WAL until it happens to be overwritten.
  - Images stay in `blobs/` forever.
  - In git, every past version sits in history. The only history replacement (`vaultReplaceHistory`) exists for encrypted remotes.
  - A user (or an organisation answering an Art. 17 request) has no way to make deletion real.
- **Fix:**
  1. Workstream D: `PRAGMA secure_delete = ON` for every connection, and a "Purge" action that runs `wal_checkpoint(TRUNCATE)` + `VACUUM`.
  2. Workstream D: blob garbage collection (mark and sweep over every page's image references, keeping anything referenced by an unsynced or pending doc), exposed through Purge.
  3. Workstream E: "Erase edit history" for a page or notebook. It replaces the doc with a **shallow snapshot** (`doc.export({ mode: 'shallow-snapshot', frontiers: doc.oplogFrontiers() })`) and writes it as a new snapshot. While sync is on, the action is offered only after all known devices have reached the frontier. The UI explains that peers keep their own copies until they sync.
  4. Workstream E: for git remotes, "Erase remote history" reuses the existing history-replacement path (one commit of current files, force-with-lease) for plaintext remotes too, behind a ConsentDialog that names the remote.
  5. Workstream E: a full "Erase all Slate data" (GDPR-06).

### Medium

#### GDPR-05: No full export in a machine-readable format (portability)

- **Severity:** Medium. **Articles:** 15(3), 20.
- **Where:** no export channel exists (the `CH` list in `shared/ipc.ts`). The existing per-page outputs are PDF (`main/print.ts:93`), copy as Markdown (`core/src/markdown.ts`), and copy as HTML.
- **Evidence and risk:** a user, or an organisation answering an access or portability request, cannot get all notebooks out in one step, so data is locked in. The database is a SQLCipher/Loro binary that no other tool reads.
- **Fix (workstream E):** "Export everything…" writes a folder chosen in a native dialog: `manifest.json` (schema version, export time, notebooks → sections → pages with ids, titles, AI-access grants, timestamps), `notebooks/<nb>/<section>/<page>.md` (through the one serializer `toMarkdown`), `images/<sha>.<ext>`, `settings.json` (secrets excluded), `ai-audit.json`, and optionally `security-log.txt`. Private boxes are included, because this is the user's own export. Folder output avoids a new zip dependency, which the dependency guard would require approving.

#### GDPR-06: Turning sync off keeps credentials, clones and sync metadata, and there is no "erase all"

- **Severity:** Medium. **Articles:** 5(1)(e), 17.
- **Where:** `main/sync/syncService.ts:517-530` (`setEnabled(false)` → `configure({provider:null})` only writes settings); `:239-240` (`token.bin`, `github-device-token.bin`); `:310,317` (clones); `store.ts:32-34,37` (`sync_meta`, `sync_seen`, `blob_synced`, `transport_observations`); `onenote/auth.ts:96-100` (sign-out keeps `msal-cache.bin`).
- **Evidence and risk:** once sync is off, GitHub tokens (scope `repo`) stay sealed on disk, and full plaintext clones of the notes stay in `git-sync/`, indefinitely. There is no single action that removes everything Slate has stored, keyring entries included.
- **Fix:**
  1. Workstream C: `SyncService.forget()`, reached through "Turn off and forget this connection". It clears both tokens, removes the clone folders for that key, and deletes the provider's `sync_meta`/`sync_seen`/`blob_synced`/`transport_observations` rows.
  2. Workstream B: MSAL sign-out also clears `msal-cache.bin`.
  3. Workstream E: "Erase all Slate data" (Settings → Privacy, typed confirmation). It closes services, signs out of Microsoft, clears every `SecretFile`, deletes every path in §1.2 S-1…S-20 under `<data>`, clears Chromium storage with `session.defaultSession.clearStorageData()`, removes the stray temp folders, and then quits.

#### GDPR-07: The MCP audit table keeps raw search queries, 10,000 rows, with no age limit

- **Severity:** Medium. **Articles:** 5(1)(c), 5(1)(e).
- **Where:** `packages/mcp/src/tools.ts:8,32-40,101`; `main/store.ts:11,140-147`; `main/ipc.ts:71-74`.
- **Evidence and risk:** every agent `search` call stores its query, up to 200 characters, as `target`. A query is personal content (names, health terms). The 10,000-row cap is a count, not a period, so a lightly used install keeps queries for years. The diagnostics UI promises "no search queries" (`DiagnosticsSection.tsx:51-54`) about a different store, which misleads.
- **Fix (workstream D):**
  1. Under strict mode, `audited()` stores `search:[N chars]` instead of the query.
  2. `DocStore.prune()` also deletes audit rows older than 90 days, or 30 days in strict mode.
  3. `auditClear` sits behind a "Clear" button in AI activity (workstream F).

#### GDPR-08: The security log is always on, undisclosed, unencrypted, and the user cannot manage it

- **Severity:** Medium. **Articles:** 5(1)(e), 13(2)(a), 15, 17, 32.
- **Where:** `main/log/configure.ts:26-32`; `log/securityEvents.ts`; `log/logger.ts:182-195`.
- **Evidence and risk:** the AU-2 audit log records every unlock, failed unlock, lock trigger and time, which together form a behavioural profile. It is kept for 90 days in plaintext, even when the notes are encrypted. The UI says "off means nothing is written at all" about the *diagnostic* log, and nowhere mentions this second log. The user cannot view, export or clear it. The AU-2 purpose is legitimate for the `fips-140-3` profile; for `standard` users it is not necessary at this length.
- **Fix:**
  1. Workstream D: security-log retention becomes 30 days for `standard` + strict mode, and stays at 90 for `fips-140-3`, read from the open key ring's profile.
  2. Workstream D: `securityLog.read()` and `securityLog.clear()` are exposed through the privacy backend; clearing is refused under `fips-140-3`, with the reason shown.
  3. Workstream F: Diagnostics and Privacy each get a sentence that discloses the log.

#### GDPR-09: Log redaction misses emails, Windows home folders and git repository owners

- **Severity:** Medium. **Articles:** 5(1)(c), 25, 32.
- **Where:** `shared/redact.ts:36-52` (no email rule), `:74` (`HOME_LIKE` covers only `/Users/` and `/home/`); `main/sync/syncService.ts:156` (git stderr logged in full, up to 512 chars).
- **Evidence and risk:**
  - A failed git command echoes `git@github.com:anna-k/private-notes.git`, which names the account and repository.
  - A Microsoft or GitHub error can carry the account email.
  - On Windows, `C:\Users\anna\…` is redacted only when it equals the running user's home.
  - The diagnostic log is designed to be pasted into public bug reports, so these leak.
- **Fix (workstream D):** add three rules to `SECRETS`:
  - email `\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b` → `[redacted-email]`;
  - scp-style and https git paths `(github\.com|gitlab\.com|bitbucket\.org|[\w.-]+)[:/]([\w.-]+)/([\w.-]+?)(\.git)?\b` → `$1:[owner]/[repo]`, applied after the URL-userinfo rule;
  - Windows homes `[A-Za-z]:\\Users\\[^\\\s"']+` → `~`.

  The thresholds and expectations of `test/spec/redact.test.ts` are a guarded spec (maintainer). Add the new cases in a new non-spec test file and ask the maintainer to fold them into the spec.

#### GDPR-10: Claude theme generation sends text to Anthropic without saying so

- **Severity:** Medium. **Articles:** 13(1)(e)–(f), 44.
- **Where:** `main/theme/claudeOneShot.ts:57-65`; `renderer/src/theme/ThemeDescribe.tsx:60-63` ("Claude designs it and you see it at once").
- **Evidence and risk:** the user's free-text description and the current theme are sent to Anthropic (USA) under the user's own Claude account. The UI never says that this leaves the computer or who receives it. The risk is low, but this is a transfer the user does not know about.
- **Fix:** under strict mode, the first "Describe a theme" opens the ConsentDialog: "Your description and current theme colours are sent to Anthropic through your `claude` command-line sign-in." Main refuses `themesGenerate` without `consents.claudeTheme` (workstream B; text in workstream F).

#### GDPR-11: The GitHub device sign-in requests the `repo` scope, which covers every repository

- **Severity:** Medium. **Articles:** 5(1)(c), 25(1), 32.
- **Where:** `main/sync/git/auth.ts:46`.
- **Evidence and risk:** the token can read and write every private repository the user can reach, including employer repositories, far beyond one notes repository. The token is sealed in the keyring (S-12), so the exposure is limited to compromise of Slate's process. It still breaks minimisation, and GDPR-06 makes it worse because the token outlives sync.
- **Fix (workstream C):**
  1. Show the requested scope and its meaning in the device-code step.
  2. Document a fine-grained-PAT path (one repository, Contents: read/write) as the strict-mode recommendation in the token field.
  3. Track a GitHub App (installation scoped to one repository) as a maintainer follow-up, since it needs an app registration.

#### GDPR-12: Microsoft sign-in requests sync permission even when the user only imports

- **Severity:** Medium. **Articles:** 5(1)(c), 25(1).
- **Where:** `main/onenote/auth.ts:20-21` (`Files.ReadWrite.AppFolder` requested to "spare a second consent prompt").
- **Fix (workstream B):** under strict mode, `signIn()` requests `['Notes.Read', 'User.Read', 'offline_access']`, and `SyncService` asks `token(['Files.ReadWrite.AppFolder', …])` only when OneDrive sync is enabled. MSAL's incremental consent already falls through to `interactive` (`auth.ts:101-109`).

#### GDPR-13: Turning off the diagnostic log leaves its files, and pruning stops

- **Severity:** Medium. **Articles:** 5(1)(e).
- **Where:** `main/log/logger.ts:61-72` (`configure({enabled:false})` returns before `prune()`), `log/configure.ts:17-24`.
- **Evidence:** a user who enabled the log for a bug report and then switched it off keeps up to 20 MB of logs forever, despite the UI's "off means nothing is written".
- **Fix (workstream D):** when `debugLog` goes from on to off and strict mode is on, `log.clear()` runs, and the UI says "The log was deleted". Otherwise `prune()` still runs on configure.

### Low

#### GDPR-14: OneNote backup conversion leaves plaintext HTML in the temp folder after a crash

- **Articles:** 5(1)(e), 32. **Where:** `main/onenote/backup.ts:184`, `:60-61`.
- **Fix (workstream D):** at startup, sweep `$TMPDIR/slate-one2html-*` and `slate-theme-*` folders that the current user owns. Removal goes through `fs.rm` after an `lstat` ownership check, never following symlinks.

#### GDPR-15: Sync conflicts keep both versions, and the other device's name, indefinitely

- **Articles:** 5(1)(e). **Where:** `main/store.ts:35,193-207`.
- **Fix (workstream D):** strict mode drops conflict rows older than 90 days at `prune()`. The UI already resolves them one by one.

#### GDPR-16: Opening Appearance runs the user's login shell to look for `claude`

- **Articles:** 5(1)(c), 25. **Where:** `main/theme/claudeOneShot.ts:28-44`; `AppearanceSection.tsx:25`.
- **Evidence:** no data leaves the device. But each first opening per run executes the user's dotfiles, which can do anything, for a feature the user may never use.
- **Fix (workstream B):** under strict mode, `themesClaude` returns `'unknown'` without spawning anything until `consents.claudeTheme` is granted. The section shows the "Describe a theme" entry with the consent step.

#### GDPR-17: There is no privacy notice or record of processing

- **Articles:** 12–14, 30 (for deploying organisations).
- **Fix (workstream F):** `PRIVACY.md` at the repository root, linked from README and from the ConsentDialog. It lists each flow in §1.1 with its endpoint, data, legal basis guidance, retention and how to turn it off.

#### GDPR-18: Chromium `localStorage` and profile files sit outside the vault and are not covered by erasure

- **Articles:** 17, 32. **Where:** `renderer/src/layout.ts:88-140`, `ColorPalette.tsx:11-20`, `lock/MigrationBanner.tsx:29-37`.
- **Evidence:** they hold no note content (panel widths, colours), so the risk is small. "Erase all" must still clear them (`session.clearStorageData`), as specified in GDPR-06.

#### GDPR-19: Installer downloads are left in ~/Downloads

- **Articles:** 5(1)(e). **Where:** `update/electronBackend.ts:84-106` (dmg, AppImage); the .deb is removed (`platformInstaller.ts:273`).
- **Fix (workstream B):** after a successful install is confirmed through `update-result.json` at the next start, remove the verified download it names, if it is still there and its sha512 still matches.

#### GDPR-20: The diagnostics UI says "no search queries", but agents' queries are stored elsewhere

- **Articles:** 12(1), 13. **Where:** `DiagnosticsSection.tsx:51-54` vs GDPR-07.
- **Fix:** resolved by the GDPR-07 fix, plus a wording change in workstream F that names the AI-activity record.

### Coverage check: what is compliant today (no change needed)

| Area | Evidence |
| --- | --- |
| Renderer cannot reach the network | `shared/csp.ts`; lint `slate/renderer-no-network`; `tools/guards/packaging.test.ts` |
| Spellcheck downloads nothing | `main/spellcheck.ts:9-27`, `shared/settings/spellcheck.ts` |
| No HTTP disk cache of decrypted content | `main/index.ts:97`; `Cache-Control: no-store` on blobs (`index.ts:258-261`) |
| No crash reporting / telemetry | no `crashReporter.start`, no analytics SDK in `allowlists/dependencies.json` |
| Credentials never in plaintext | `main/secretStorage.ts` (real keyrings only; `basic_text` refused) |
| AI access opt-in per item, private boxes excluded, MCP off while locked | `core/src/tree.ts:24-25`, `core/src/agentView.ts`, `index.ts:594,1089` |
| Diagnostic log off by default, redacted, 0600 | `log/logger.ts`, `shared/redact.ts`, `main/log/CLAUDE.md` |
| Encrypted remotes carry no host, device or ids | `syncService.ts:322-323`, `encryptingDrive.test.ts:289-320` |
| Transport probe only once sync is configured, OneDrive handshake sends no HTTP bytes | `transportProbe.ts:63-90` |
| Clipboard cleared at lock after a Slate copy; main never reads the clipboard into a string | `vault/lockSequence.ts:95-97`, `index.ts:277-298` |

---

## 3. Parallel subagent implementation plan

### 3.0 Ground rules for every workstream

- **Order.** Workstream **A lands first** (merged by the maintainer through `merge-wp.sh`). B–F then branch from that `main` and run in parallel. A creates a few stub files; each stub then belongs to exactly one downstream workstream (marked "→ owned by X" below). No two of B–F touch the same file.
- **Worktrees** go under `.claude/worktrees/<ws>` (guard-edits refuses others), cloned with the CoW recipe in `CLAUDE.md`. Run at most 6 agents at once; this plan has 5 in parallel.
- **Guard rails that apply:**
  - SQL stays literal (`slate/sql-text-is-literal`): every new statement is a string literal at its `prepare` call, with values as `?`.
  - New IPC channels come only from `npm run new:channel -- <name> --policy unlocked`, and nothing new is `pre-unlock` (that would need `allowlists/ipc-ungated.json`, which is the maintainer's).
  - Every handler opens with `if (!isX(arg)) refuse(CH.x)`, using `shared/ipcValidators` exports only.
  - No `process.env` outside `testHooks.ts`.
  - Main logs through `log`, never `console`.
  - No new dependency (the dependency guard requires approval).
  - Renderer changes need a UI scenario (`e2e/ui/*.ui.spec.ts`) whose screenshots are looked at.
- **Security review** (`docs/review/REVIEW.md`) is required before merge for every branch that touches `tools/guards/security-paths.txt` paths. That is every workstream except F:
  - A: `shared/{ipc,api}.ts`, `main/{ipcGuard,index}.ts`, `preload/**`
  - B: `main/update/**`
  - C: `main/sync/**`
  - D: `shared/redact.ts`, `main/log/**`, `main/db/**`, `main/services.ts`
  - E: erases vault files and keyring entries; route it to security review by hand

  F touches renderer and docs only, so it gets the UI review. Check each branch with `node scripts/agents/review-gate.mjs`.
- **Maintainer-only items** (agents stop and list them under "Guardrail conflicts"):
  1. Add `expect(DEFAULT_SETTINGS.gdprStrictMode).toBe(true)` to the guarded spec `packages/desktop/test/spec/settingsDefaults.test.ts`.
  2. Fold the new redaction cases into `test/spec/redact.test.ts`.
  3. Make the product decision that existing installs get strict mode with legacy consents (§3.1 step 4).
  4. Bump the version and add a CHANGELOG section per release.
- **Verification**, which every workstream runs before its report:

  ```sh
  npm run typecheck
  npm run lint:changed
  npm run lint:arch
  npm run guards
  npm test
  npm run test:main            # whenever src/main changed
  npm run e2e -- <the specs named in the workstream>
  node scripts/traceability.mjs --check
  ```

### 3.1 Workstream A: Foundation: strict-mode setting, consent model, privacy IPC, gate, ConsentDialog (runs first)

**Scope.** The shared types, the setting, the consent records, the pure gate, the IPC channels with their policy rows, validators and preload bindings, one composition point in `index.ts`, and the reusable renderer `ConsentDialog`. A also ships stub files for the privacy backend, each owned by one downstream workstream.

**Files.**

| Action | File |
| --- | --- |
| modify | `packages/desktop/src/shared/api.ts` (`Settings` + `PrivacyApi` on `SlateApi`) |
| modify | `packages/desktop/src/shared/settings/schema.ts` |
| create | `packages/desktop/src/shared/privacy/consent.ts` |
| create | `packages/desktop/src/shared/privacy/consent.test.ts` |
| modify | `packages/desktop/src/shared/ipc.ts` (via `npm run new:channel`) |
| modify | `packages/desktop/src/shared/ipcValidators.ts` |
| modify | `packages/desktop/src/main/ipcGuard.ts` (policy rows via `new:channel`) |
| modify | `packages/desktop/src/preload/index.ts` |
| modify | `packages/desktop/src/main/settings.ts` (existing-install migration) |
| create | `packages/desktop/src/main/settings.privacy.test.ts` |
| create | `packages/desktop/src/main/privacy/gate.ts`, `gate.test.ts` |
| create | `packages/desktop/src/main/privacy/ipc.ts`, `ipc.test.ts` |
| create (stub → **E**) | `packages/desktop/src/main/privacy/dataRights.ts` |
| create (stub → **D**) | `packages/desktop/src/main/privacy/retention.ts` |
| modify | `packages/desktop/src/main/index.ts` (wire gate source + `registerPrivacyIpc`) |
| create | `packages/desktop/src/renderer/src/privacy/ConsentDialog.tsx`, `privacy.css` |
| create | `packages/desktop/e2e/ui/consentDialog.ui.spec.ts` |

**Spec.**

1. `shared/privacy/consent.ts` (pure, runs everywhere):

   ```ts
   export const CONSENT_FEATURES = ['updates', 'gitSync', 'oneDriveSync', 'plaintextSync', 'microsoftSignIn', 'githubSignIn', 'claudeTheme'] as const
   export type ConsentFeature = (typeof CONSENT_FEATURES)[number]

   export interface ConsentRecord {
     /** ms since epoch */
     grantedAt: number
     /** Bumped whenever DISCLOSURES[feature] changes; an older grant no longer counts. */
     textVersion: number
     /** 'user' from the dialog; 'legacy' synthesised for an existing install's already-configured feature. */
     source: 'user' | 'legacy'
   }
   export type Consents = Partial<Record<ConsentFeature, ConsentRecord>>

   export interface Disclosure {
     title: string
     endpoints: readonly string[]          // host names only
     data: readonly string[]               // plain-language data types
     recipient: string                     // "GitHub, Inc. (USA)"
     textVersion: number
   }
   export const DISCLOSURES: Readonly<Record<ConsentFeature, Disclosure>>   // filled from §1.1 N-1…N-12, P-2

   /** Strict mode off: everything the user configured is allowed. On: only a current grant. */
   export function egressAllowed(s: Pick<Settings, 'gdprStrictMode' | 'consents'>, f: ConsentFeature): boolean
   export function isConsentFeature(v: unknown): v is ConsentFeature
   ```

2. `Settings` gains `gdprStrictMode: boolean` and `consents: Consents`. The schema entries:
   - `gdprStrictMode: { default: true, sanitize: bool }`
   - `consents: { default: {}, sanitize: sanitizeConsents }`, where `sanitizeConsents` keeps only known features whose records have a finite `grantedAt`, an integer `textVersion` and a valid `source`, and drops everything else.
3. `consents` is **not** writable through `settingsSet`. `sanitizePatch` drops the key when the call comes over IPC (add an `options.fromRenderer` flag, set by the `settingsSet` handler). Grants go only through `privacyGrant`, so a renderer bug cannot forge a consent.
4. **Existing installs** (`main/settings.ts` `readSettings`): when the stored settings row exists but has no `gdprStrictMode` key, the result is `gdprStrictMode: true`, plus `source: 'legacy'` records for features already in use: `gitSync`/`oneDriveSync` if `syncProvider` is set, `plaintextSync` if sync is set and there is no vault (decided in `index.ts` and passed as a flag), `updates` if `updateAutomaticChecks` is true, and `microsoftSignIn` if `msClientId` is set. All of it is written back once. The renderer shows a one-time "Review privacy settings" card (F) while any `legacy` record exists. A fresh install (no settings row) gets strict mode and no consents. *Maintainer decision noted in §3.0.*
5. `main/privacy/gate.ts`:

   ```ts
   let source: () => Settings | null = () => null
   export function setPrivacySource(fn: () => Settings | null): void   // index.ts: () => openStore() ? readSettings(openStore()!) : null
   /** Fails closed: no open store means no consent. */
   export function allowed(feature: ConsentFeature): boolean
   export class ConsentRequired extends Error { constructor(readonly feature: ConsentFeature) }
   export function requireConsent(feature: ConsentFeature): void        // throws ConsentRequired
   ```

6. New channels, all `--policy unlocked`:
   - `privacyStatus` (no args → `PrivacyStatus`)
   - `privacyGrant(feature)`, `privacyRevoke(feature)`
   - `privacyExport()` (main opens the folder dialog)
   - `privacyPurge(scope)` with `scope ∈ 'caches' | 'logs' | 'audit' | 'all'`
   - `privacyEraseHistory(docId)`
   - `privacyEraseAll(confirm)`, where `confirm` must be the literal string `'ERASE'`
   - `privacySecurityLogRead()`, `privacySecurityLogClear()`
   - `auditClear()`
   - `syncForget()`

   Validators:
   - `isConsentFeature`
   - `isPurgeScope`
   - `isEraseConfirmation` (`=== 'ERASE'`)
   - `isDocId` (reuse the existing one if it is in `ipcValidators`)

7. `main/privacy/ipc.ts` exports `registerPrivacyIpc(ipc, deps: PrivacyDeps)`. `PrivacyDeps` is an interface whose members come from the stubs: `dataRights: DataRights` (E) and `retention: Retention` (D), plus `grant`/`revoke`/`status`, which A implements against `writeSettings`. `privacyGrant` stamps `{ grantedAt: Date.now(), textVersion: DISCLOSURES[f].textVersion, source: 'user' }`. Revoking `updates` also re-arms the update schedule through `onSettingsWritten`, which already exists.
8. Stub signatures. Downstream workstreams fill these in and may not change the signatures without telling A's owner:

   ```ts
   // retention.ts (→ D)
   export interface Retention { purge(scope: PurgeScope): Promise<PurgeReport>; clearAudit(): void; readSecurityLog(): string; clearSecurityLog(): void; sweepTemp(): Promise<number> }
   export function createRetention(deps: RetentionDeps): Retention        // stub: every method throws new Error('not implemented')
   // dataRights.ts (→ E)
   export interface DataRights { exportAll(): Promise<ExportReport | null>; eraseHistory(docId: string): Promise<void>; eraseAll(): Promise<void> }
   export function createDataRights(deps: DataRightsDeps): DataRights
   ```

   `syncForget` is registered by A and calls `services().sync.forget()`. A adds `forget(): Promise<void>` to `SyncService` as a one-line stub that throws, and C replaces it. This is the **only** line of `syncService.ts` that A touches, and A merges before C starts.
9. `ConsentDialog.tsx`: props `{ feature: ConsentFeature; onDone(granted: boolean): void; primaryAlternative?: { label: string; onClick(): void } }`. It renders `DISCLOSURES[feature]` (title, a bulleted list of endpoints, the data types, the recipient), a link to `PRIVACY.md` through `ExternalLink`, and buttons **Allow** / **Not now**. It calls `window.slate.privacy.grant(feature)` on Allow. It is focus-trapped and closes on Escape (= Not now).
10. Edge cases:
    - `privacyGrant` while locked is refused (policy `unlocked`).
    - Old `textVersion` grants count as not granted.
    - A strict-mode toggle to `false` goes through `settingsSet` and is accepted only when the renderer has shown the strict-mode-off dialog (F). Main does not need to know, because strict mode off means `egressAllowed` returns true for every configured feature.

**Verification.** The commands in §3.0, plus:

```sh
npx vitest run packages/desktop/src/shared/privacy
npm run test:main -- privacy settings.privacy
npm run e2e -- consentDialog.ui.spec.ts
npm run guards -- ipcChannels ipcValidation ratchet
```

### 3.2 Workstream B: Egress gating for updates, Microsoft sign-in and Claude themes

**Scope.** GDPR-01, 02, 10 (main side), 12, 16, 19, and the MSAL cache part of GDPR-06.

**Files (exclusive).**

| Action | File |
| --- | --- |
| modify | `packages/desktop/src/main/update/index.ts` |
| modify | `packages/desktop/src/main/update/updateService.ts` |
| modify | `packages/desktop/src/main/update/platformInstaller.ts` |
| create | `packages/desktop/src/main/update/privacy.test.ts` |
| modify | `packages/desktop/src/main/onenote/auth.ts` |
| create | `packages/desktop/src/main/onenote/auth.privacy.test.ts` |
| modify | `packages/desktop/src/main/theme/ipc.ts` |
| modify | `packages/desktop/src/main/theme/claudeOneShot.ts` |
| create | `packages/desktop/src/main/theme/consent.test.ts` |

**Spec.**

1. `update/index.ts` `settings`:

   ```ts
   const open = store()
   if (!open) return { automaticChecks: false, intervalHours: DEFAULT_SETTINGS.updateCheckIntervalHours } // GDPR-02: fail closed while locked
   const s = readSettings(open)
   return { automaticChecks: s.updateAutomaticChecks && egressAllowed(s, 'updates'), intervalHours: s.updateCheckIntervalHours }
   ```

   `updateService.settingsChanged()` already re-arms when the pair changes. Add an explicit call after unlock: `onSettingsWritten` fires on the first `readSettings` write. If no write happens, A's `index.ts` wiring calls `updates?.settingsChanged()` in `startServices`. That line is in `index.ts`, so **A adds it in step 7's wiring** (listed here so B does not touch `index.ts`).
2. A manual check (`check({ manual: true })`) is always allowed. The one network action that is not a user action is the scheduled check.
3. `UpdateService.restorePreviousInstall()`: after a confirmed successful install, `rm` the download named in `update-result.json` if `stillVerified(path, sha512)` (GDPR-19). If verification fails, keep the file and log `kept unverified download`.
4. `onenote/auth.ts`:
   - Add `IMPORT_SCOPES = ['Notes.Read', 'User.Read', 'offline_access']` and `SYNC_SCOPES = ['Files.ReadWrite.AppFolder']`.
   - `signIn()` takes an optional `scopes`, defaulting to `allowed`-dependent: strict → `IMPORT_SCOPES`, else `SIGN_IN_SCOPES`.
   - `signIn()` and `interactive()` call `requireConsent('microsoftSignIn')` first.
   - `signOut()` also `await store.clear()` (GDPR-06).
   - The sync path's `token(SYNC_SCOPES)` already falls through to interactive consent.
5. `theme/ipc.ts`:
   - `themesClaude` returns `false` without calling `findClaude()` when `!allowed('claudeTheme')` and strict mode is on (GDPR-16).
   - `themesGenerate` calls `requireConsent('claudeTheme')` before `generator.generate`.
   - The renderer maps `ConsentRequired` (error name) to showing the dialog (F).
6. `claudeOneShot.ts`: unchanged behaviour. Its `slate-theme-*` cleanup is already in `finally`. Export `THEME_TMP_PREFIX = 'slate-theme-'` for D's sweep. D imports the constant; it does not edit this file.
7. Tests:
   - locked + defaults → no timer;
   - strict without consent → no timer, and manual check still runs;
   - revoke → timer cleared;
   - legacy record → timer armed;
   - MSAL strict scopes;
   - sign-out clears the file (fake `SecretStorage`);
   - `themesGenerate` refused without consent, and `findClaude` not spawned (inject the runner and finder).

**Verification.** §3.0, plus:

```sh
npm run test:main -- update onenote theme
npm run e2e -- updates.spec.ts themes.spec.ts import.spec.ts
```

Security review: `main/update/**` is a security path.

### 3.3 Workstream C: Sync privacy: plaintext guard, pseudonymous identity, forget, GitHub scope

**Scope.** GDPR-03, 06 (sync part), 11.

**Files (exclusive).**

| Action | File |
| --- | --- |
| modify | `packages/desktop/src/main/sync/syncService.ts` (replaces A's `forget()` stub) |
| create | `packages/desktop/src/main/sync/syncPrivacy.test.ts` |
| modify | `packages/desktop/src/main/sync/git/auth.ts` |
| modify | `packages/sync/src/engine.ts` (device-record name pass-through only) |
| create | `packages/sync/test/deviceRecord.test.ts` |
| modify | `packages/desktop/src/renderer/src/sync/SyncSettings.tsx` |
| modify | `packages/desktop/src/renderer/src/sync/SyncTokenField.tsx` |
| modify | `packages/desktop/src/renderer/src/sync/sync.css` |
| create | `packages/desktop/e2e/ui/syncConsent.ui.spec.ts`, `packages/desktop/e2e/syncPrivacy.spec.ts` |

**Spec.**

1. `syncService.configure(config)`. When `config.provider` is set:
   - require `gitSync` or `oneDriveSync` consent (`requireConsent`);
   - if `!this.deps.keyRing && settings.gdprStrictMode && !allowed('plaintextSync')`, throw `PlaintextSyncRefused` (`name = 'PlaintextSyncRefused'`, message "Encrypt your notes first, or allow unencrypted sync");
   - the refusal happens **before** `writeSettings`, so nothing is saved.
   - The timer path (`now()`) re-checks the same gate, so a revoked consent stops the next tick and the report status becomes `'disabled'` with notice "Sync paused: consent withdrawn".
2. Pseudonymous identity. Compute `const strict = this.settings().gdprStrictMode`. When `strict || keyRing` is true, use `{ author: { name: 'Slate', email: 'slate@invalid' }, commitMessage: 'slate: sync' }`; otherwise keep today's value. The device record name becomes `strict ? \`Device ${this.deviceId.slice(0, 8)}\` : this.deviceName`. `engine.ts` needs no logic change, because `deviceName` is already an option; the only engine edit is the doc comment and a test that the record carries exactly `{…capabilities, name, platform, appVersion}`.

   Existing remotes keep their old history; that is noted in the UI.
3. `forget()`:
   1. `await this.stop()`.
   2. `await this.tokenSecret.clear()` and `await this.deviceSecret.clear()`.
   3. For the current key: `rmSync(join(gitDir, hash), {recursive, force})` and the `.vault` sibling.
   4. Through `DocStore`, add literal statements: `DELETE FROM sync_meta WHERE key LIKE ? ESCAPE '\\'` with the scoped prefix `git:<url>#<branch>:%`, or every unprefixed OneDrive key; `DELETE FROM sync_seen`; `DELETE FROM blob_synced`; `DELETE FROM transport_observations WHERE remote = ?`.
   5. `writeSettings({ syncProvider: null, git: null })`.

   **DocStore methods** are needed for these statements. Because `store.ts` belongs to D, C does not touch it. C calls `this.store.forgetSync(prefix: string | null, remote: string | null)`, and **D adds that method to `store.ts`** (listed in D's spec with this exact signature). C's tests use a fake store until D merges, and the final integration test runs after both have merged.
4. `git/auth.ts`:
   - Export `DEVICE_FLOW_SCOPE = 'repo'` and `DEVICE_FLOW_SCOPE_HELP`, a plain sentence on what `repo` grants.
   - `githubDeviceFlow` calls `requireConsent('githubSignIn')`.
   - `createPrivateRepo` stays.
5. UI (`SyncSettings.tsx`):
   - Turning sync on opens `ConsentDialog` for the provider.
   - With no vault and strict mode, a second ConsentDialog (`plaintextSync`) follows, with `primaryAlternative = { label: 'Encrypt my notes first', onClick: openEncryptWizard }`.
   - "Turn off" becomes a split action: **Turn off** and **Turn off and forget this connection** (`window.slate.privacy.syncForget()`).
   - The device-code step shows `DEVICE_FLOW_SCOPE_HELP`.
   - `SyncTokenField` recommends a fine-grained token for one repository.
6. Edge cases:
   - A vault created later lifts the plaintext requirement automatically.
   - Consent revoked mid-sync aborts only at the next tick, never mid-push.
   - `forget()` on OneDrive also calls `auth.signOut()` only if the user ticks "also sign out of Microsoft".

**Verification.** §3.0, plus:

```sh
npm run test:main -- sync
npx vitest run packages/sync
npm run e2e -- git-sync.spec.ts syncPrivacy.spec.ts syncConsent.ui.spec.ts
```

Run the git-sync spec alone. It shares a clipboard and CPU with others, per the earlier lessons.

### 3.4 Workstream D: Logs, retention, minimisation and purge

**Scope.** GDPR-04 (`secure_delete`, VACUUM, blob GC), 07, 08, 09, 13, 14, 15. Owns `retention.ts`.

**Files (exclusive).**

| Action | File |
| --- | --- |
| modify | `packages/desktop/src/shared/redact.ts` |
| create | `packages/desktop/test/redactPrivacy.test.ts` (non-spec; the maintainer folds it into the spec) |
| modify | `packages/desktop/src/main/log/logger.ts` |
| modify | `packages/desktop/src/main/log/configure.ts` |
| create | `packages/desktop/src/main/log/privacy.test.ts` |
| modify | `packages/desktop/src/main/db/openDatabase.ts` (`secure_delete`) |
| modify | `packages/desktop/src/main/store.ts` (prune by age, `forgetSync`, `clearAudit`, `vacuum`, `replaceWithSnapshot`) |
| create | `packages/desktop/src/main/store.privacy.test.ts` |
| modify | `packages/desktop/src/main/blobs.ts` (`remove(name)`, `sweep(keep)`) |
| create | `packages/desktop/src/main/blobs.gc.test.ts` |
| modify | `packages/mcp/src/tools.ts` (audit target minimisation) |
| create | `packages/mcp/test/auditPrivacy.test.ts` |
| modify | `packages/desktop/src/main/onenote/backup.ts` (export `ONE2HTML_TMP_PREFIX`) |
| modify (stub from A) | `packages/desktop/src/main/privacy/retention.ts` |
| create | `packages/desktop/src/main/privacy/retention.test.ts` |

**Spec.**

1. `redact.ts`: the three rules from GDPR-09, inserted after the userinfo rule and before the hex rule. The email rule must not eat `slate@invalid` (keep that one exemption: `(?!slate@invalid\b)`). Run the existing spec unchanged; it must still pass.
2. `logger.ts`:
   - `configure()` runs `prune()` even when `enabled` is false, if the folder exists (no folder is created).
   - Add `purgeAll()`, an alias of `clear()` that also removes the empty folder.
3. `configure.ts`:
   - `configureLogging(settings, wasOn)`: when the log goes from on to off with `gdprStrictMode`, call `log.purgeAll()`.
   - `configureSecurityLog(retentionDays)`: the default stays 90. A new export, `applySecurityLogRetention(profile: 'standard' | 'fips-140-3' | null, strict: boolean)`, gives `fips-140-3 → 90` and `strict → 30`, with the 90-day fallback otherwise.
   - The call site is in `index.ts`. **A** wires `applySecurityLogRetention(services().keyRing?.schedule.profile ?? null, readSettings(...).gdprStrictMode)` in `startServices`, next to `configureLogging`, as part of A's wiring list. Give A this exact call before A starts.
4. `openDatabase.ts`: after the key is proven and before WAL, `db.pragma('secure_delete = ON')` for every non-readonly connection. Add a test that a removed page's marker bytes are not found in the file or the `-wal` after `wal_checkpoint(TRUNCATE)`, mirroring the existing marker scan in `openDatabase.test.ts:49`.
5. `store.ts`. Every SQL string stays literal:

   ```ts
   private prune(): void   // + 'DELETE FROM audit WHERE ts < ?' (now - AUDIT_MAX_AGE_MS), + strict: 'DELETE FROM conflicts WHERE at < ?'
   clearAudit(): void                         // 'DELETE FROM audit'
   forgetSync(prefix: string | null, remote: string | null): void  // statements listed in C §3; one transaction
   vacuum(): void                             // 'PRAGMA wal_checkpoint(TRUNCATE)' then 'VACUUM' (refuses inside a transaction)
   ```

   `DocStore` must not import settings, so the age limits arrive as an option: `new DocStore(file, { …, retention: { auditDays: 30 | 90, conflictDays: 90 | null } })`. `services.ts` is D's, and D changes it only to pass that option (read once from `readSettings` when services open).

   D also adds `replaceWithSnapshot(docId: string, snapshot: Uint8Array): void` for E. It runs one transaction on the same path as `compact`: upsert `snapshots`, `DELETE FROM updates WHERE doc_id = ?`, keep `doc_heads`, bump the doc's sequence so sync sees a change. It must **not** be `remove` + `append`: FX-6 (fuzz ledger) showed that a `local_seq` reused after `remove` hides the next edit from sync.
6. `blobs.ts`:
   - `remove(name)` for both stores (`DbBlobStore`: `DELETE FROM blob_data WHERE name = ?`).
   - `sweep(referenced: ReadonlySet<string>, pending: ReadonlySet<string>): number` removes names in neither set.
   - `retention.purge('caches')` builds `referenced` by walking every page doc's image nodes (through `core` handles, the way `searchIndex.ts` walks pages) and `pending` from docs with unsynced rows.
   - The encrypted remote sweep already exists (`encryptingDrive.ts:289`); call it when sync is on.
7. `tools.ts`: `audited(src, 'search', strictTarget(query))`. The source has no settings, so the minimisation is unconditional: an agent's query is never stored, and `target = \`[${query.length} chars]\``. This is simpler and needs no option. It is a behaviour change, so the test pins it.
8. `retention.ts`:
   - `purge('logs')` → `log.purgeAll()`, and `securityLog.clear()` unless `fips-140-3`.
   - `purge('audit')` → `clearAudit`.
   - `purge('caches')` → `store.clearSearch()` + `search.ensureBuilt()`, blob sweep, `vacuum()`, `sweepTemp()`.
   - `purge('all')` → all three.
   - `sweepTemp()` lists `os.tmpdir()` for `ONE2HTML_TMP_PREFIX` / `THEME_TMP_PREFIX` entries. For each it runs `lstat`, requires `isDirectory() && !isSymbolicLink() && uid === process.getuid()`, then `rm -r`. It skips any directory currently held by a live `BackupSource` (the `dirs` set is exported read-only).
   - `readSecurityLog()` returns `securityLog.read()`.
   - `clearSecurityLog()` throws `ProfileForbids` under `fips-140-3`.
   - Startup: A's wiring calls `retention.sweepTemp()` once after `startServices`.
9. Edge cases:
   - `VACUUM` needs free disk equal to the database's size. Check `statfs` first and refuse with a message.
   - `VACUUM` is refused while an import or sync transaction is running (call `sync.stop()` and then `start()` around it).
   - `secure_delete` costs a little write performance. Re-run `npm run e2e -- perf.spec.ts` and keep the 16 ms budget.

**Verification.** §3.0, plus:

```sh
npm run test:main -- store blobs log privacy db/openDatabase
npx vitest run packages/mcp packages/desktop/test/redactPrivacy.test.ts
npm run e2e -- perf.spec.ts settings.spec.ts
```

Security review: `shared/redact.ts`, `main/log/**` and `main/db/**` are security paths.

### 3.5 Workstream E: Data-subject rights: export, erase history, erase all, the Privacy section

**Scope.** GDPR-04 (erase history, remote history), 05, 06 (erase all), 18. Owns `dataRights.ts`.

**Files (exclusive).**

| Action | File |
| --- | --- |
| modify (stub from A) | `packages/desktop/src/main/privacy/dataRights.ts` |
| create | `packages/desktop/src/main/privacy/export.ts`, `export.test.ts` |
| create | `packages/desktop/src/main/privacy/erase.ts`, `erase.test.ts` |
| create | `packages/desktop/src/renderer/src/settings/sections/PrivacySection.tsx` |
| modify | `packages/desktop/src/renderer/src/settings/registry.tsx` (register the section) |
| create | `packages/desktop/src/renderer/src/settings/sections/privacySection.css` |
| create | `packages/desktop/e2e/ui/privacySection.ui.spec.ts`, `packages/desktop/e2e/privacyRights.spec.ts` |

**Spec.**

1. `exportAll()`:
   - Ask main's `dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })`, with the default `app.getPath('documents')`.
   - Create `Slate export <ISO date>/` inside the chosen folder. Refuse if it exists; never overwrite.
   - Walk notebooks through `DocStore` → `NotebookDoc` → pages and write:
     - `notebooks/<safe nb>/<safe section>/<safe title>-<pageId8>.md` via `toMarkdown` (`core/src/markdown.ts`);
     - `images/<name>` via `blobs.read`;
     - `manifest.json`;
     - `settings.json` (the whole `Settings` object; no secret lives there, since tokens and keys are keyring-sealed files);
     - `ai-audit.json` (`listAudit(10_000)`);
     - `security-log.txt`.
   - Image links in Markdown are rewritten from `slate-blob://blob/<name>` to `../../../images/<name>`.
   - `safe()` maps to `[A-Za-z0-9 ._-]`, max 80 characters, de-duplicated with a suffix.
   - Writes happen with `0o600` files and `0o700` folders.
   - The function returns `{ folder, pages, images, bytes }`.
2. `manifest.json` type:

   ```ts
   interface ExportManifest { format: 'slate-export'; version: 1; exportedAt: string; appVersion: string
     notebooks: Array<{ id: string; name: string; sections: Array<{ id: string; title: string; access: Access | null
       pages: Array<{ id: string; title: string; file: string; access: Access | null; images: string[] }> }> }> }
   ```

3. `eraseHistory(docId)`:
   - Accept only a page or notebook doc id (`isDocId`).
   - Load the doc and compute `frontiers = doc.oplogFrontiers()`.
   - In this release, refuse while sync is on: "Turn sync off first; other devices keep their own history until they are erased too". A peer still holding the old history would merge it back. Checking that every device has reached the frontier needs a reader in `syncService.ts` (C's file), which is a follow-up.
   - `const shallow = doc.export({ mode: 'shallow-snapshot', frontiers })`, then `store.replaceWithSnapshot(docId, shallow)` (D's contract, §3.4 step 5), then `store.vacuum()` (D) and `search.docChanged(docId)`.
   - Test: a marker typed and then deleted is absent from `slate.db`, its `-wal`, and `load(docId)` after the erase, and the page still opens with its current text.
4. `eraseAll()`:
   1. `closeServices()`, then `auth.signOut()`, then clear each `SecretFile` (msal, both git tokens, quick unlock via the existing disable path).
   2. Delete under `<data>`: `slate.db{,-wal,-shm}`, `blobs/`, `git-sync/`, `logs/`, `security-log/`, `msal-cache.bin`, every vault file constant (`VAULT_FILE`, `LOCAL_KEYS_FILE`, `PREUNLOCK_FILE`, `PENDING_FILE`, `PREV_FILE`, `MIGRATION_FILE`, `QUICK_UNLOCK_FILE`, `THROTTLE_FILE`, `vault.seen.json`), `update-result.json`, and `fips/` only if not `fips-140-3`. Do not delete the folder itself; `slate.lock` is still held.
   3. `await session.defaultSession.clearStorageData()` and `clearCache()`.
   4. `retention.sweepTemp()`, then `app.relaunch()` + `app.exit(0)`.
   - Each step is best-effort and logged by name only. The final report lists anything not removed.
   - The function is refused unless `confirm === 'ERASE'` (validated in A's handler).
5. Remote history: a "Replace remote history" button in the Privacy section calls the existing `vault.replaceHistory()` for encrypted remotes. For plaintext git remotes, it is shown only with a ConsentDialog-style warning and is implemented as a **follow-up in C's file** (`syncService.ts`). E only shows the UI, disabled, with "coming in the next release" if C has not shipped `replacePlaintextHistory()`.
6. `PrivacySection.tsx` (Settings → Privacy):
   - a strict-mode toggle; turning it off opens a dialog listing every `DISCLOSURES` entry and what changes;
   - the consent list (feature, granted date, **Withdraw**);
   - "Export everything…";
   - "Purge caches and logs" (→ `privacyPurge('all')`);
   - "View security log" (read-only `<pre>`, max 200 KB) and "Clear security log" (disabled under `fips-140-3`, with the reason);
   - "Erase edit history…" for the current page;
   - "Erase all Slate data…" with a typed `ERASE` field.
   - Keywords for settings search: `privacy, gdpr, export, erase, delete, consent, data`.
7. Edge cases:
   - Export of a locked vault is refused (policy `unlocked`).
   - Export continues past one unreadable page, listing it in `manifest.errors`.
   - Erase-all with sync on reminds the user that remote copies remain, and offers the remote action first.

**Verification.** §3.0, plus:

```sh
npm run test:main -- privacy
npm run e2e -- privacyRights.spec.ts privacySection.ui.spec.ts
npm run ui:review
```

The erase-all e2e uses `SLATE_USER_DATA` in a per-run temporary folder, and never the real profile.

### 3.6 Workstream F: Transparency and consent UX in the existing surfaces, plus the privacy notice

**Scope.** GDPR-01 (first-run card), 08 (disclosure), 10 (text), 17, 20, the AI-activity Clear (07), and the legacy-consent review card.

**Files (exclusive).**

| Action | File |
| --- | --- |
| create | `PRIVACY.md` |
| modify | `README.md` (Privacy section linking `PRIVACY.md`) |
| create | `packages/desktop/src/renderer/src/privacy/FirstRunPrivacy.tsx`, `firstRun.css` |
| modify | `packages/desktop/src/renderer/src/App.tsx` (mount the card) |
| modify | `packages/desktop/src/renderer/src/settings/sections/UpdatesSection.tsx` |
| modify | `packages/desktop/src/renderer/src/settings/sections/DiagnosticsSection.tsx` |
| modify | `packages/desktop/src/renderer/src/settings/sections/AppearanceSection.tsx` |
| modify | `packages/desktop/src/renderer/src/theme/ThemeDescribe.tsx` |
| modify | `packages/desktop/src/renderer/src/import/ImportDialog.tsx` |
| modify | `packages/desktop/src/renderer/src/AiActivity.tsx` |
| modify | `packages/desktop/src/renderer/src/ConnectAgents.tsx` |
| create | `packages/desktop/e2e/ui/firstRunPrivacy.ui.spec.ts`, `packages/desktop/e2e/ui/transparency.ui.spec.ts` |

**Spec.**

1. `FirstRunPrivacy`:
   - Shown once, when `settings.gdprStrictMode && !settings.consents.updates && settings.plugins.firstRunPrivacy !== 'seen'`. Either answer writes `plugins.firstRunPrivacy = 'seen'` (the existing free-form `plugins` setting), so no new setting is needed and declining is remembered.
   - Content: "Slate keeps your notes on this computer. Nothing is sent anywhere unless you turn it on."
   - One toggle: "Check for updates automatically (asks github.com; sends your IP address and Slate's version)". It opens `ConsentDialog('updates')`.
   - A link to Settings → Privacy.
   - The legacy variant, used when any `source: 'legacy'` record exists, lists those features with **Keep** / **Withdraw**.
2. `UpdatesSection`: the help line names the endpoints and the recipient. Ticking "automatically" without consent opens `ConsentDialog('updates')`; withdrawing consent unticks it.
3. `DiagnosticsSection`:
   - Add "Slate also keeps a short security record (unlocks and locks, no notes) for 30 days, or 90 days under FIPS; see Settings → Privacy."
   - Replace "no search queries" with "no search queries (AI agents' searches are recorded only as their length)".
4. `ThemeDescribe` / `AppearanceSection`:
   - Under strict mode without consent, show "Describe a theme with Claude…". It opens `ConsentDialog('claudeTheme')` and only then calls `themes.claudeAvailable()`.
   - The help text names Anthropic.
   - Map an error named `ConsentRequired` to the dialog.
5. `ImportDialog`: "Sign in to Microsoft" opens `ConsentDialog('microsoftSignIn')` first. Importing from a backup file needs no consent, because it is local.
6. `AiActivity`: a **Clear** button calls `window.slate.privacy.auditClear()`, with an inline confirm (never `window.confirm`; see the e2e lessons). `ConnectAgents` adds: "Agents you connect may send what they read to their provider (for Claude Code: Anthropic)."
7. `PRIVACY.md` sections:
   - what stays local;
   - each optional flow from §1.1 (endpoint, data, recipient and country, how to turn it off);
   - retention table (§1.2);
   - your rights and how to exercise them in-app (export, erase, withdraw);
   - guidance for organisations (controller role, records of processing).
8. Edge cases:
   - All new text passes the UI audit: contrast, no clipping, controls centred.
   - Every dialog closes with Escape.
   - Text never claims more than the code does. Each claim cites the gate (`egressAllowed`) by feature name in a code comment.

**Verification.** §3.0, plus:

```sh
npm run e2e -- firstRunPrivacy.ui.spec.ts transparency.ui.spec.ts settings.spec.ts updates.spec.ts themes.spec.ts ai.spec.ts
npm run ui:review
```

### 3.7 File-ownership matrix (zero overlap among B–F)

| File | A | B | C | D | E | F |
| --- | --- | --- | --- | --- | --- | --- |
| `shared/api.ts`, `shared/settings/schema.ts`, `shared/privacy/consent.ts` | ✔ | | | | | |
| `shared/ipc.ts`, `shared/ipcValidators.ts`, `main/ipcGuard.ts`, `preload/index.ts` | ✔ | | | | | |
| `main/settings.ts`, `main/index.ts`, `main/privacy/{gate,ipc}.ts` | ✔ | | | | | |
| `renderer/src/privacy/ConsentDialog.tsx` | ✔ | | | | | |
| `main/privacy/retention.ts`, `main/log/configure.ts` | stub | | | ✔ | | |
| `main/privacy/dataRights.ts`, `export.ts`, `erase.ts` | stub | | | | ✔ | |
| `main/sync/syncService.ts` | 1-line stub | | ✔ | | | |
| `main/update/**`, `main/onenote/auth.ts`, `main/theme/{ipc,claudeOneShot}.ts` | | ✔ | | | | |
| `main/sync/git/auth.ts`, `packages/sync/src/engine.ts`, `renderer/src/sync/*` | | | ✔ | | | |
| `shared/redact.ts`, `main/log/{logger,configure}.ts`, `main/db/openDatabase.ts`, `main/store.ts`, `main/blobs.ts`, `main/services.ts`, `main/onenote/backup.ts`, `packages/mcp/src/tools.ts` | | | | ✔ | | |
| `renderer/src/settings/sections/PrivacySection.tsx`, `settings/registry.tsx` | | | | | ✔ | |
| `PRIVACY.md`, `README.md`, `renderer/src/App.tsx`, `UpdatesSection`, `DiagnosticsSection`, `AppearanceSection`, `ThemeDescribe`, `ImportDialog`, `AiActivity`, `ConnectAgents`, `renderer/src/privacy/FirstRunPrivacy.tsx` | | | | | | ✔ |

**Cross-workstream contracts (fixed by A, consumed later):**

- `index.ts` wiring is A's. Before A starts, add these lines to its brief:
  - `setPrivacySource`;
  - `registerPrivacyIpc`;
  - `updates?.settingsChanged()` after `startServices` (B);
  - `applySecurityLogRetention(...)` next to `configureLogging` (D);
  - `retention.sweepTemp()` once after the first `startServices` (D).

  Each of these calls a function A ships as a stub. `applySecurityLogRetention` is a no-op stub that **A adds to `log/configure.ts`**, which then belongs to D. `RetentionDeps` and `DataRightsDeps` are accessor objects A defines in the stubs, for example `{ store: () => DocStore; blobs: () => BlobStore; search: () => SearchIndex; sync: () => SyncService; dataDir: string; profile: () => ProfileId | null }`. A constructs both in `index.ts`, so neither D nor E needs `index.ts`.
- `DocStore.forgetSync(prefix, remote)`, `DocStore.vacuum()` and `DocStore.replaceWithSnapshot(docId, snapshot)` are D's, used by C and E. C and E test against fakes, and an integration pass runs after D merges.
- `ConsentRequired` (error `name`) is how B and C refuse; F, C and E map it to `ConsentDialog`.

**Suggested merge order after A:** D (store/log APIs others call), then B and C, then E, then F. They can still be *developed* in parallel; the order only reduces rebase work for the integration tests.

### 3.8 Traceability (finding → workstream)

| Finding | A | B | C | D | E | F |
| --- | --- | --- | --- | --- | --- | --- |
| GDPR-01 update auto-check | gate | gate | | | | card |
| GDPR-02 opt-out while locked | | ✔ | | | | |
| GDPR-03 plaintext sync / hostname | consent | | ✔ | | | |
| GDPR-04 erasure | | | | secure_delete, VACUUM, blob GC | shallow history, remote | |
| GDPR-05 export | channel | | | | ✔ | |
| GDPR-06 forget / erase all | channel | MSAL | forget | `forgetSync` | erase all | |
| GDPR-07 audit queries | channel | | | ✔ | | Clear |
| GDPR-08 security log | channel | | | ✔ | view/clear UI | text |
| GDPR-09 redaction | | | | ✔ | | |
| GDPR-10 Claude disclosure | | ✔ | | | | ✔ |
| GDPR-11 GitHub scope | | | ✔ | | | |
| GDPR-12 MS scopes | | ✔ | | | | ✔ |
| GDPR-13 log purge on off | | | | ✔ | | |
| GDPR-14 temp sweep | wiring | const | | ✔ | | |
| GDPR-15 conflicts age | | | | ✔ | | |
| GDPR-16 shell probe | | ✔ | | | | ✔ |
| GDPR-17 privacy notice | | | | | | ✔ |
| GDPR-18 localStorage | | | | | ✔ | |
| GDPR-19 downloads | | ✔ | | | | |
| GDPR-20 diagnostics wording | | | | ✔ | | ✔ |
