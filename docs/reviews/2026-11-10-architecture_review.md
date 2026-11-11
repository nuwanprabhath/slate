# Global Architecture, Performance, & Security Review: Slate

Reviewed: `main` at `28dcd01` (v0.6.7), 2026-11-10. Method: direct reading of `packages/*/src`, the guard layer (`tools/`, `.dependency-cruiser.cjs`, `scripts/agents/`), CI workflows and `docs/compliance/`; three claims were checked by running code (marked **verified** or **measured**). Nothing in the app was run end to end for this review, so every finding without one of those marks is from reading the code.

## 1. Executive Summary & Critical Flaws

**Health.** The security boundary is the strongest part of the codebase and needs no rework: keys live only as handles in the native module, IPC has one typed registrar with a per-channel policy, windows are sandboxed with context isolation, the renderer has no network, and every rule is backed by a lint rule or guard test. Package layering is clean: an ad-hoc `no-circular` run of dependency-cruiser over 417 modules found no runtime cycle (**verified**). The renderer's box model is also sound: one Loro document per page is the single source of truth, `Box` is memoised by value, drags use local gesture state and commit once on drop, and off-screen boxes render as static HTML.

The weaknesses are elsewhere, in three places:

1. **Durability.** A save that fails is never noticed, and two code paths then turn that into permanent loss.
2. **Main-thread load.** The database, sync engine, search index, importer and in-app MCP server all run on Electron's main thread, and several of them do work proportional to the whole vault.
3. **Release assurance.** The release workflow publishes without the end-to-end suite, the guards or the compliance check, and the compliance matrix proves only that a test exists, not that it ran.

**Prioritised findings**

| # | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| F1 | Critical (data loss) | The renderer fires each edit at main and ignores the result (`void persistence.append(...)`, `packages/editor/src/PageSession.ts:57`; same in `packages/desktop/src/renderer/src/library.ts:119`). Loro updates are incremental, so if one append is rejected (disk full, `SQLITE_BUSY` after the 3 s timeout, services closed during a rekey), every later edit of that session is stored but cannot be applied on reload. There is no retry, no acknowledgement and no "not saved" state. | **Verified**: four updates captured from `subscribeLocalUpdates`, the second withheld, the rest imported into a fresh `LoroDoc`: the text was `"one "` only. |
| F2 | Critical (data loss) | `DocStore.compact` (`packages/desktop/src/main/store.ts:252-265`) imports the stored rows, exports a snapshot and deletes every update row, without checking whether the import left updates pending. Rows that could not yet be applied are destroyed. This makes F1 permanent, and it also hits sync: a remote chunk whose dependencies have not arrived is stored and marked seen (`packages/sync/src/engine.ts:354-362`), so compaction before the dependency arrives drops it until the sending device next uploads a snapshot. | **Verified**: after snapshotting the gapped doc and then importing the missing update, the text was `"one two "`; `"three four "` was gone for good. |
| F3 | High (performance) | Every sync run loads and decodes every document in the vault to compare version vectors (`packages/sync/src/engine.ts:125`, through `docIds: store.list('')` in `packages/desktop/src/main/sync/localStore.ts`). Sync runs every 30 s and 2 s after each edit burst (`syncService.ts:47-48`). The local-store adapter wraps synchronous calls in `async`, so the scan yields only to microtasks: it is one uninterrupted task on the thread that routes key presses. | **Measured** (Loro decode only, synthetic 20-box pages, Node on the maintainer's Mac; SQLite and SQLCipher cost excluded): 500 pages 0.21 s, 2,000 pages 1.7 s, 5,000 pages 5.2 s per run. |
| F4 | High (release assurance) | `release.yml`'s `verify` job runs typecheck, `npm test` and `npm run test:main` only (`.github/workflows/release.yml:15-47`). It does not run lint, guards, `traceability.mjs --check`, the e2e suite or the memory evidence, and it does not require CI to be green on the tagged commit. | v0.6.7 was published (immutable, 27 assets) from `98862c1` while CI run 42426840806 failed its "Typecheck, tests and e2e (Ubuntu)" job on that same commit. |
| F5 | High (architecture) | There is no worker thread or utility process anywhere, and `@slate/native` refuses to load off the main thread (`packages/native/index.ts:230`), so the database cannot simply be moved. Vault-proportional main-thread work besides F3: the full search-index build (`searchIndex.ts:69`, started from `index.ts:369`) is not time-sliced; a user regex is run over every indexed row in main (`searchIndex.ts:102-104`), so a backtracking pattern freezes the whole app, idle lock included; the in-app MCP `search` decodes every shared page per query (`packages/mcp/src/tools.ts:89`); a notebook edit issues one `UPDATE` per page (`searchIndex.ts:184`). | Code reading. The perf budget test uses one 200-box page in an empty vault with sync off (`e2e/spec/perf.spec.ts`), so none of this is measured by CI. |
| F6 | Medium (AI boundary) | The private-box rule is one function used by convention (`agentBoxes`, `packages/core/src/agentView.ts`). `DocSource.loadPage` hands the tool layer the full `PageDoc`, private content included (`packages/desktop/src/main/mcp/docSource.ts:16`); nothing in types or lint stops a future tool reading it. Two example tests cover it. Tool inputs are unbounded strings (`packages/mcp/src/server.ts:26-43`), and the socket's line buffer has no size cap (`lineTransport.ts:15`). | Code reading. No leak was found in the five current tools. |
| F7 | Medium (IPC) | The registrar checks sender and vault state, but most handlers trust the TypeScript type of their arguments (`packages/desktop/src/main/ipc.ts:23, 47, 71, 72, 103`). `onenoteStartBackup` takes filesystem paths from the renderer, so a compromised page chooses which files main scans and converts. `git.remoteUrl` and `branch` are stored as any string (`shared/settings/schema.ts:25`). | Code reading. `ext::` remotes are **not** a live exploit: git 2.54 refuses them by default (**verified**: `transport 'ext' not allowed`). The fix is defence in depth. |
| F8 | Medium (sync resilience) | Network calls have no deadline of their own and are not cancelled on abort: `transfer()` stops waiting but the `fetch` or `git` child runs on (`engine.ts:139`); `Retry-After` is honoured without a cap (`packages/importer/src/graph.ts:80-82`). The simulation test switches devices offline only between whole sync runs (`packages/sync/test/simulation.ts:93`), so mid-run failure, lost acknowledgements, crash between upload and bookkeeping, and stalls are untested. | Code reading. |
| F9 | Medium (compliance) | `scripts/traceability.mjs --check` is static: it matches finding ids to test titles. It does not show the test ran or passed on the release commit. `*.keychain.ts` specs run in no CI job, and macOS CI runs no e2e. | Code reading. |
| F10 | Medium (extensibility) | The plugin API has `activate` only: no dispose, no deactivate, no id namespacing (a duplicate command id silently replaces the first, `registry.ts:53`), and a lost-update race in `settings.set` (`registry.ts:42`). Views are `render: () => ReactNode` (`types.ts:25`), which cannot cross an isolation boundary, so the README's claim that a sandboxed plugin could be handed the same interface does not hold. | Code reading. |

**Lower-severity debt** (each has a task in section 2): no schema versioning in `DocStore` (`CREATE TABLE IF NOT EXISTS` plus one `table_info` probe, `store.ts:55-71`); every statement is re-prepared per call and wrapped in a `Proxy` (`openDatabase.ts:81`); `append` runs a `COUNT(*)` per edit (`store.ts:235`); compaction can delete remote rows before the 500 ms external watcher delivers them to an open page; quit does not flush the renderer (`index.ts:1059`); `index.ts` is one 960-line closure; `LoroMap.prototype.delete` is patched globally in the renderer only (`loroBinding.ts:11`); the CSP is a meta tag and allows `worker-src blob:` though no worker exists (`shared/csp.ts:20`); dependency-cruiser has no rule for `sync`, `mcp`, `importer` or `native` and no cycle rule; the `audit` and `notices` tables grow without bound.

**Already tracked, not re-reported.** `docs/compliance/poam.md` covers the unsandboxed AppImage renderer (POAM-16), secret copies in Chromium's IPC buffers (POAM-10), the `runAsNode` fuse (POAM-04), the native addon outside asar integrity (POAM-07), update freshness (POAM-06) and code signing (POAM-01 to -03). Task C5 proposes one enforcement change on top of POAM-16; the rest stand as written.

## 2. Parallel Implementation Tracks (Sub-Agent Blueprints)

**Rules that apply to every track**

- Each track owns the files it lists and edits no others. Section 3 names the owner of every shared interface.
- Guard files (`.github/workflows/**`, `.dependency-cruiser.cjs`, `tools/**`, `eslint.config.mjs`, `vitest*.config.*`, `tsconfig*.json`, root `package.json`, `packages/*/{test,e2e}/spec/**`, `e2e/ui/{audit,review}.ts`) are edited only in Track D's guard batch, under the lead's signed unlock. Tracks A to C hand D a written request instead.
- Tracks do not bump the version or tag. Each adds one line under "Unreleased" in `CHANGELOG.md`; the lead assigns versions at merge.
- Each behaviour change starts with a test that fails on `main`. Most target files are on `tools/guards/security-paths.txt`, so branches need the security review before `merge-wp`.
- Commits are Conventional and carry no AI attribution.

### Track A: Architectural Refactoring & Extensibility

Three independent work packages; A1, A2 and A3 touch disjoint files and can run as separate branches.

#### A1. Plugin lifecycle, namespacing and isolation

- **Target Subsystem/Files:** `packages/desktop/src/renderer/src/plugins/{types.ts,registry.ts,usePlugins.ts,builtins.ts,README.md,registry.test.ts}`, `plugins/library/**`, `plugins/search/**`.
- **Current Antipattern/Issue:** `SlatePlugin` is `activate(ctx): void` and registrations return nothing, so a plugin can never be unloaded or disabled. `commands.set(c.id, c)` lets a second plugin replace a command silently, and the first matching keybinding wins. `settings.set` reads the whole `plugins` record and writes it back, so two concurrent sets lose one. A throwing `render` or `run` is not contained. The view contract is a React node, which ties every plugin to the app's realm and to `window.slate`.
- **Proposed Engineering Solution:**
  1. `activate` may return a `Disposable` or a promise of one; `views.register` and `commands.register` return a `Disposable`. Add `PluginRegistry.deactivate(pluginId)`, which disposes in reverse order and notifies subscribers.
  2. The registry rejects, with an error naming both plugins, any view or command id not prefixed `<plugin.id>.` (built-in ids are renamed once) and any duplicate id or keybinding.
  3. Serialise `settings.set` per registry through one promise chain so each write reads the result of the previous one.
  4. Wrap each view in an error boundary and each `run` in a try/catch that reports through `window.slate.diagnostics`; a failing plugin shows a fallback panel and the others keep working.
  5. Add lifecycle events to `PluginContext` (`onPageOpened`, `onWillLock`), each returning a `Disposable`.
  6. Correct the README: in-realm plugins are trusted code. Do not add dynamic loading. Record the serialisable contribution model (declarative manifest plus a sandboxed frame talking over a `MessagePort`) as a section of the ADR in A3, since third-party code beside decrypted notes changes the threat model.
- **Parallelization Constraints:** Renderer plugin folder only. No change to `shared/api.ts`, `shared/settings/schema.ts`, `main/settings.ts` or any IPC channel. The settings race is fixed in the renderer, not in main. A renderer change needs a UI scenario: add one for the fallback panel in a new `e2e/ui/plugins.ui.spec.ts`.
- **Definition of Done (DoD):** New unit tests fail on `main` and pass on the branch for: duplicate id rejected; un-prefixed id rejected; `deactivate` removes views, commands and key handling; twenty concurrent `settings.set` calls all persist; a throwing view renders the fallback. Existing `registry.test.ts` and the search and library e2e specs pass unchanged apart from the id rename.

#### A2. Make the private-box rule structural in the MCP layer

- **Target Subsystem/Files:** `packages/core/src/agentView.ts`, `packages/mcp/src/{source.ts,tools.ts,server.ts,index.ts}`, `packages/mcp/test/**`, `packages/desktop/src/main/mcp/{docSource.ts,lineTransport.ts,socketServer.ts}` and their tests.
- **Current Antipattern/Issue:** F6. The tool layer holds a `PageDoc` with private content and is trusted to call `agentBoxes`. `search` and `notebooks()` rebuild every document per call on the main thread. Inputs and the line buffer are unbounded.
- **Proposed Engineering Solution:**
  1. Change `DocSource` so tools never receive a `PageDoc`: `readPage(pageId): Promise<AgentPage>` returns the redacted projection (`AgentBox[]`, with `markdown: null` for private boxes), and `appendBox(pageId, blocks): Promise<{ boxId }>` performs the write on the source side. `agentBoxes` and `placeBelow` are called only inside the two `DocSource` implementations and the test fake.
  2. Hand Track D a lint request: `packages/mcp/src/tools.ts` and `server.ts` may not import `PageDoc`, `contentToJSON` or `contentMap`.
  3. In `storeDocSource`, cache decoded notebooks and agent projections keyed by doc id and invalidated by `DocStore.loadSince`'s cursor (the pattern `SearchIndex` already uses), bounded to a fixed number of pages. Add no table.
  4. Bound every input in `server.ts`: `markdown` at 1 MiB, `query` and `title` at 1,000 characters, ids at 128. Truncate the audit `target` to 200 characters.
  5. `LineTransport` closes the connection when a line exceeds 8 MiB before its newline; `startMcpSocketServer` caps concurrent clients at 8.
- **Parallelization Constraints:** Owns the `DocSource` interface (section 3). Does not touch `store.ts` (Track B) or `index.ts` (Track C); the `storeDocSource` call site in `index.ts` keeps its signature. Track D's canary test (D5) is black-box at the server level and is this refactor's acceptance test, so it must be green before and after.
- **Definition of Done (DoD):** `grep -rn "PageDoc\|contentMap" packages/mcp/src/tools.ts packages/mcp/src/server.ts` returns nothing. A test asserts an oversized `markdown`, an oversized line and a ninth client are each refused. A test with a spy on `DocStore.load` shows a second identical `search` with no intervening write decodes zero pages. `mcp.spec.ts`, `mcp-encrypted.spec.ts` and D5 pass.

#### A3. Decision record: vault host process and composition root

- **Target Subsystem/Files:** New `docs/architecture/adr/0001-vault-host-process.md` and `0002-plugin-isolation.md`. No code.
- **Current Antipattern/Issue:** F5. Track B removes the vault-proportional work, but the ceiling remains: every SQLCipher page read and every Loro merge still shares a thread with input routing, and the native module's main-thread rule forbids a worker. Separately, `packages/desktop/src/main/index.ts:127-1087` is one closure holding about twenty mutable variables (lock, quit, migration, quick unlock, self-test), which is why lifecycle fixes keep landing in the same function.
- **Proposed Engineering Solution:** Write the ADR that evaluates moving the crypto module, database, sync and search into one `utilityProcess` ("vault host") that owns every key, with main reduced to windows, menus and message routing. It must answer: how a typed secret reaches the host without passing through main (a `MessagePort` transferred to the lock window); how the self-test gate, `failClosed` and `hardenProcess` apply in the host; what FIPS boundary statement changes in `docs/compliance/security-policy.md`; the measured cost of the hop per keystroke append; and a staged plan in which `index.ts` is first split into `lifecycle/{lock,quit,migration,quickUnlock,selfTest}.ts` modules behind the existing `VaultStateMachine`. Include a recommendation to proceed or not, with the numbers from Track D's vault-scale probe (D4) after Track B lands.
- **Parallelization Constraints:** Documents only. Must not edit `index.ts` (Track C owns it) or `packages/native/**`.
- **Definition of Done (DoD):** Both ADRs merged, each with context, options considered, decision, consequences and a measured baseline; the maintainer has recorded accept, reject or defer on each.

### Track B: Low-Level Performance & State Optimization

Three lanes with disjoint files: **save** (B1, B7), **store and sync** (B2, B4, B3, B6, in that order, because they share `store.ts` and `engine.ts`), **search** (B5).

#### B1. Durable, acknowledged saves

- **Target Subsystem/Files:** `packages/editor/src/PageSession.ts`, new `packages/editor/src/saveQueue.ts`, `packages/editor/test/**`, `packages/desktop/src/renderer/src/library.ts`, a small status element in `packages/desktop/src/renderer/src/Toolbar.tsx` (or the title bar), new `e2e/ui/saveState.ui.spec.ts`.
- **Current Antipattern/Issue:** F1.
- **Proposed Engineering Solution:** Introduce `SaveQueue(docId, doc, persistence)`. It keeps `ackedVersion` (a Loro version vector). On each local commit it schedules a flush; a flush exports `doc.export({ mode: 'update', from: ackedVersion })`, awaits `persistence.append`, and advances `ackedVersion` only on success. Flushes are serialised, so a later one always covers an earlier failure and no stored update can depend on a missing one. On rejection it retries with backoff (250 ms doubling to 5 s) and exposes `state: 'saved' | 'saving' | 'unsaved'` with the last error. `PageSession` and `Library` use it in place of the bare subscription; `editStoredPage` uses it for the other page. The vault flush handshake (`lock/relay.ts`) awaits `saveQueue.idle()` before replying. The status element shows "Not saved, retrying" only in the `unsaved` state.
- **Parallelization Constraints:** No new IPC channel and no change to `shared/api.ts`: the existing promise from `docs.append` carries the result. Does not touch `store.ts`. Coordinates with nobody; Track C's quit flush (C4) calls the same handshake and needs no change here.
- **Definition of Done (DoD):** A unit test with a persistence fake that rejects the second append fails on `main` (reloaded text differs from the live text) and passes on the branch (reloaded document equals the live one after recovery). A test shows `state` is `unsaved` while the fake rejects and `saved` after. The e2e perf budgets in `e2e/spec/perf.spec.ts` still pass. The UI scenario shows the status element at 800 and 1280 px in all four themes.

#### B2. Compaction never deletes what it could not apply

- **Target Subsystem/Files:** `packages/desktop/src/main/store.ts`, `store.test.ts`, `packages/desktop/src/main/externalWatch.ts` and its test.
- **Current Antipattern/Issue:** F2, plus the watcher race: compaction (3 s after the last local append) can delete rows another connection wrote before the 500 ms poll delivers them, leaving an open page stale until reopened. `Services.checkExternal` exists for this and has no caller.
- **Proposed Engineering Solution:** In `compact`, read the import status returned by `importBatch`. If any update is pending, do not compact: leave the rows, and record the doc so the next attempt waits for a new append. Give `DocStore` an optional `beforeCompact(docId)` hook and have `services.ts`'s wiring call the watcher's `check()` from it. Because `services.ts` belongs to Track C's file set, expose the hook as a constructor option defaulted in `store.ts` and hand C a one-line wiring request.
- **Parallelization Constraints:** First in the store lane. Track C applies the one-line `services.ts` wiring. No schema change.
- **Definition of Done (DoD):** A test stores four updates with the second missing, runs `compact`, then appends the missing one and loads: it fails on `main` (later text lost) and passes on the branch (full text). A test shows rows written by a second connection are delivered to the watcher callback before compaction removes them.

#### B4. Store hot path and schema versioning

- **Target Subsystem/Files:** `packages/desktop/src/main/store.ts`, `store.test.ts`.
- **Current Antipattern/Issue:** Each method calls `this.db.prepare(...)` on every invocation, and each prepared statement is a fresh `Proxy` from `watched`. `append` runs `SELECT COUNT(*)` on every edit. The schema has no version: tables are created if absent and one column is added by probing `table_info`, so the next change has no ordered place to go. `audit` and `notices` are never pruned.
- **Proposed Engineering Solution:** Prepare each statement once per connection in a private lazily-filled map keyed by its literal SQL (the SQL stays a literal at the call site, so `slate/sql-text-is-literal` is unaffected). Replace the per-append count with an in-memory per-doc counter seeded on first use by one count and reset by compaction. Introduce `PRAGMA user_version` migrations: version 1 is today's schema including `origin`; the constructor runs pending migrations in one transaction. Prune `audit` beyond 10,000 rows and `notices` beyond 1,000 on open. Measure before changing checkpoint behaviour: add a micro-benchmark for 1,000 appends on an encrypted database and only then decide on `wal_autocheckpoint`.
- **Parallelization Constraints:** After B2, before B3. This package defines the migration mechanism every later schema change uses (section 3). It does not edit `db/openDatabase.ts`.
- **Definition of Done (DoD):** A test opens a database created by v0.6.7's schema and one created fresh and finds identical `user_version` and tables. A spy shows 1,000 appends prepare each statement once and issue no `COUNT(*)` after the first. The benchmark's before and after numbers are in the PR description.

#### B3. Sync touches only documents that changed

- **Target Subsystem/Files:** `packages/desktop/src/main/store.ts` (migration 2), `packages/desktop/src/main/sync/localStore.ts`, `packages/sync/src/{types.ts,engine.ts}`, `packages/sync/test/{memoryLocal.ts,engine.test.ts}`.
- **Current Antipattern/Issue:** F3. `pushBlobs` has the same shape: one query per blob per run.
- **Proposed Engineering Solution:** Migration 2 adds `doc_heads(doc_id PRIMARY KEY, local_seq INTEGER NOT NULL)`; `append` with origin `local` increments it in the same transaction as the insert. `LocalStore` gains `changedDocIds(sinceSeq): Promise<{ ids: string[]; seq: number }>` and the engine stores the last pushed sequence per remote scope in `sync_meta`. `syncOnce` pushes only `changedDocIds`; a full scan remains for the first sync against a remote, after `forgetPushed`, and when `selfCheck` resets a doc. Blob push uses one set-difference query. In the pull loop, yield to the event loop (`setImmediate`) between documents so a large first pull is sliced.
- **Parallelization Constraints:** Owns the `LocalStore` interface; update `memoryLocal.ts` in the same commit. After B4. Track D's fault harness (D3) wraps `RemoteDrive`, not `LocalStore`, so it is unaffected.
- **Definition of Done (DoD):** A test seeds 2,000 documents, completes one sync, then runs a second with one edited document and asserts `loadDoc` was called once (it is called 2,000 times on `main`). The simulation tests pass unchanged. D4's probe shows no main-thread stall above 50 ms during an idle sync of a 2,000-page vault.

#### B6. Deadlines and cancellation for sync transfers

- **Target Subsystem/Files:** `packages/importer/src/graph.ts`, `packages/sync/src/{oneDrive.ts,gitRunner.ts,gitDrive.ts,engine.ts,types.ts}` and their tests.
- **Current Antipattern/Issue:** F8.
- **Proposed Engineering Solution:** `RemoteDrive` methods accept an optional `AbortSignal`; the engine passes its own. `GraphHttp.send` combines that signal with `AbortSignal.timeout` (60 s for metadata calls, 10 minutes for transfers) and passes it to `fetch`. `nodeGitRunner` kills the child on abort as it does on timeout. Cap `Retry-After` at 120 s and total retry time per request at 10 minutes, then fail as `offline`. Add `GIT_ALLOW_PROTOCOL=https:ssh` to `PROMPT_FREE_ENV`, with `file` added only when the remote is a local path (the e2e and unit tests use `file://`).
- **Parallelization Constraints:** Last in the store and sync lane (shares `engine.ts` and `types.ts` with B3). The remote-URL allowlist itself is Track C's (C3); this package only sets the environment variable.
- **Definition of Done (DoD):** Tests with fake timers show: a `fetch` that never resolves fails the run as `offline` at the deadline; an abort during a transfer leaves no pending `fetch` and no live git child; `Retry-After: 86400` waits 120 s. A test shows an `ext::` remote is refused even when the user's git config allows it.

#### B5. Search work off the keystroke path

- **Target Subsystem/Files:** `packages/desktop/src/main/search/{searchIndex.ts,snippet.ts}`, `searchIndex.test.ts`, `packages/core/src/find.ts` if the matcher needs a budget parameter.
- **Current Antipattern/Issue:** F5's search parts.
- **Proposed Engineering Solution:** Make `ensureBuilt` resumable: index a batch of pages, then reschedule with `setImmediate` until done, recording progress in `sync_meta` so a restart continues. A query that arrives mid-build indexes the remaining pages first, as `flush` does today. For regex and sub-three-character queries, enforce a wall-clock budget: check elapsed time between rows and stop with `truncated: true` at 250 ms; additionally reject, before running, patterns with nested unbounded quantifiers, and cap row text handed to a regex at 20,000 characters. Replace `refreshScopes`' per-page loop with one statement driven by a temporary table of `(page_id, section_id, notebook_id)`.
- **Parallelization Constraints:** Uses `DocStore` methods as they are; if it needs a new one, it requests it from the store lane rather than editing `store.ts`. Does not edit `index.ts`: the build is still started by the existing call.
- **Definition of Done (DoD):** A test with 2,000 seeded pages shows `ensureBuilt` never holds the thread longer than 20 ms per slice (measured with an injected clock) and that a query during the build returns complete results. A test runs `(a+)+$` against a 5,000-character row and returns within 300 ms with `truncated: true`. `search.spec.ts` and `find.spec.ts` pass.

#### B7. Renderer state housekeeping

- **Target Subsystem/Files:** `packages/editor/src/{Canvas.tsx,loroBinding.ts,PageSession.ts}` and tests.
- **Current Antipattern/Issue:** `coveringHandles` (`Canvas.tsx:60`) compares every box with every other on each structural change, including each auto-push move while typing. `LoroMap.prototype.delete` is replaced for the whole renderer realm, while main, sync and MCP run the unpatched library, so the same document code behaves differently by process. `PageSession.close` clears `needsLayout` even when the page was never measured and settled.
- **Proposed Engineering Solution:** Sort boxes by `y` once and sweep, so the overlap pass is near-linear for typical pages. Scope the delete guard to the binding: wrap the content container handed to `LoroSyncPlugin` rather than the prototype, or carry the fix as a pinned patch to `loro-prosemirror` with a test that fails when the upstream behaviour changes. Clear `needsLayout` only after a settle ran.
- **Parallelization Constraints:** Same lane as B1 (shares `PageSession.ts`); do B1 first.
- **Definition of Done (DoD):** A test with 2,000 boxes shows the overlap pass under 2 ms. A test asserts `LoroMap.prototype.delete` is the library's own function after the editor module loads, and that typing a character still adds no attribute-delete operations. A test shows an imported page closed before measurement is settled on its next open.

### Track C: Cryptographic & IPC Security Hardening

One lane; C owns `index.ts`, `ipc.ts`, `services.ts` and the shared IPC types, so its packages run in order C1 to C6.

#### C1. Validate every IPC payload at the door

- **Target Subsystem/Files:** `packages/desktop/src/main/ipc.ts`, `main/theme/ipc.ts`, `main/copyHtml.ts`, `main/print.ts`, `main/editCommands.ts`, `main/update/ipc.ts`, `main/windowChromeIpc.ts`, new `packages/desktop/src/shared/ipcValidators.ts` and its test.
- **Current Antipattern/Issue:** F7. Only `searchQuery`, settings patches, and the secret channels check shape at run time.
- **Proposed Engineering Solution:** Add hand-written validators in `shared/ipcValidators.ts` in the style of `isSearchQuery` (no new dependency, so `allowlists/dependencies.json` does not grow). Minimum rules: `docId` matches `^(page|notebook):` followed by the id grammar `newId` produces; `update` and `bytes` are `Uint8Array` within a size cap (16 MiB for updates; the existing image limit for blobs); `limit` is an integer clamped to 1..1000; every string has a length cap; enums are checked against their literal sets. Each handler validates first and throws a fixed `Refused a malformed <channel> request`. Hand Track D a guard request: a test that fails when an `invoke` channel in `CHANNEL_POLICY` has a handler whose first statement is not a validator call (channels with no arguments are listed explicitly).
- **Parallelization Constraints:** Owns `ipc.ts` and the validators file. Does not add or rename channels in this package, so `CH`, `CHANNEL_POLICY` and `SELF_TEST_POLICY` are untouched.
- **Definition of Done (DoD):** A table-driven test sends each channel a wrong type, an oversized value and a missing argument and expects the refusal; it fails on `main` for the unvalidated channels. All e2e specs pass.

#### C2. File paths never come from the renderer

- **Target Subsystem/Files:** `packages/desktop/src/main/ipc.ts` (`registerOneNoteIpc`), `main/onenote/importService.ts`, `packages/desktop/src/shared/api.ts` (`BackupPick`, `OneNoteApi.startBackup`), `packages/desktop/src/preload/index.ts`, `packages/desktop/src/renderer/src/import/ImportDialog.tsx`.
- **Current Antipattern/Issue:** `onenotePickBackup` returns the chosen paths to the page and `onenoteStartBackup` accepts paths back (`ipc.ts:103`), so the page, not the file dialog, decides what main reads.
- **Proposed Engineering Solution:** Main keeps the dialog's result in a map keyed by a random `pickId` (one live pick, replaced on the next dialog, cleared on lock). `BackupPick` becomes `{ pickId, sections }`; `startBackup(pickId, ids)` resolves the paths in main and refuses an unknown id.
- **Parallelization Constraints:** Changes a shared type (section 3); the renderer dialog is updated in the same branch. A renderer change needs a UI scenario: `e2e/ui` has none for the import dialog today, so add `e2e/ui/import.ui.spec.ts` for its pick and progress states. `onenote-backup.spec.ts` must pass.
- **Definition of Done (DoD):** `BackupPick` has no `paths` field and typecheck passes. A test calls `startBackup` with an unknown id and with a path string and gets a refusal. The import e2e specs pass.

#### C3. Allow-list git remotes

- **Target Subsystem/Files:** `packages/desktop/src/shared/settings/schema.ts`, new `packages/desktop/src/shared/gitRemote.ts`, `packages/desktop/src/main/sync/git/auth.ts`, tests.
- **Current Antipattern/Issue:** `remoteUrl` and `branch` are accepted as any string and reach `git` argument lists (`auth.ts:116`, `gitDrive.ts:109-111`).
- **Proposed Engineering Solution:** `isAllowedRemote(url, { allowLocal })` accepts `https://`, `ssh://`, `git+ssh://` and scp-style `user@host:path`, rejects anything starting with `-`, any `::` helper syntax and control characters; local paths and `file://` are accepted only when `allowLocal` is set from the e2e hook. `branch` must satisfy git's ref-name rules and not start with `-`. `gitSettings` returns `undefined` for a failing value, and `testGit` and `createRepo` validate before running. Put `--` before the URL in `ls-remote`.
- **Parallelization Constraints:** Does not edit `packages/sync/src/**` (Track B). The environment-level allow-list is B6's.
- **Definition of Done (DoD):** A table test covers accepted and refused forms, including `--upload-pack=x`, `ext::sh -c id`, `-oProxyCommand=x` and a branch of `--force`. Existing git sync unit and e2e tests pass with `allowLocal`.

#### C4. Lifecycle fixes in the composition root

- **Target Subsystem/Files:** `packages/desktop/src/main/index.ts`, `main/services.ts`, `main/vault/lockSequence.ts`, tests; `e2e/quit-clean.spec.ts`.
- **Current Antipattern/Issue:** `shutdown` (`index.ts:1059`) closes services without asking windows to flush, and windows stay interactive while it awaits sync, so appends sent in that window are rejected and lost. `vaultSaveRecovery` (`index.ts:899`) takes the recovery key back from the page as a JavaScript string.
- **Proposed Engineering Solution:** Run the same bounded flush the lock uses (`flushWindows` raced against `FLUSH_TIMEOUT_MS`, with the flush channels open) at the start of `shutdown`. Apply B2's one-line `beforeCompact` wiring in `services.ts`. For the recovery key: have `Migration` retain the pending recovery text it generated and write the file from that, so the channel takes no argument; if a call site has no retained text, keep the argument but type it as `SecretBytes` so it is zeroed like the other secrets.
- **Parallelization Constraints:** Owns `index.ts` and `services.ts`; applies wiring requests from Track B. Does not restructure `index.ts` (that waits for A3's decision).
- **Definition of Done (DoD):** A main-process test types an edit, requests quit immediately and finds the edit stored (fails on `main` when the append lands after `closeServices`). `quit-clean.spec.ts` and `lock.spec.ts` pass. `grep` shows no `string` recovery key crossing `vaultSaveRecovery`.

#### C5. Tighten the page policy and the unsandboxed-renderer rule

- **Target Subsystem/Files:** `packages/desktop/src/shared/csp.ts`, `main/appProtocol.ts`, `packages/desktop/src/renderer/index.html`, `main/vault/profile.ts`, `main/rendererSandbox.ts`, tests.
- **Current Antipattern/Issue:** The production CSP is injected as a meta tag, so it covers only `index.html` and cannot carry header-only directives; it allows `worker-src 'self' blob:` although the renderer creates no worker. POAM-16's residual (an AppImage renderer with no sandbox holds the typed password) is handled by a warning in every profile.
- **Proposed Engineering Solution:** Send `PRODUCTION_CSP` as a response header from `appResponse` for every `app://slate/` document and keep the meta tag as a second layer. Set `worker-src 'none'`. Add `require-trusted-types-for 'script'` in report-only form first, list the violations from one full e2e run, then enforce with a single named policy used by the paste sanitiser. For POAM-16, propose to the maintainer that a `fips-140-3` vault refuses to unlock while `rendererSandbox.check()` reports an unsandboxed renderer, with the existing notice as the message; the `standard` profile keeps the warning.
- **Parallelization Constraints:** The CSP ratchet lives in `tools/guards/packaging.test.ts`; hand Track D the matching guard update. The profile change needs the maintainer's decision before code.
- **Definition of Done (DoD):** A test fetches `app://slate/index.html` and finds the header. The built CSP contains `worker-src 'none'` and the Trusted Types directive, and the full e2e suite passes with it enforced. If approved, a test shows a fips-profile unlock refused under a faked unsandboxed status and allowed otherwise.

#### C6. Zeroisation evidence for generated secrets

- **Target Subsystem/Files:** `packages/desktop/e2e/memory.linux.ts`, `e2e/memory.spec.ts`, `main/vault/{migration.ts,recovery.ts,recoveryFile.ts}` only if the scan finds something.
- **Current Antipattern/Issue:** Unverified candidate, not a confirmed defect. The generated recovery key is returned to the page as a string (`migration.ts:211`, `:342`, `:569`). Strings cannot be zeroed, main survives a lock, and it is not evident that T-ZERO-04's scan looks for the recovery key text as it does for the password and keys.
- **Proposed Engineering Solution:** Extend the Linux memory scan: create a new recovery key, lock, and search main's memory for the key text and its decoded bytes. If it is found, generate and carry the recovery text as bytes (`SecretBytes`) from the module to a canvas-drawn display in the page, mirroring `SecretField`, and zero every copy; if it is not found, record the result in the POA&M under POAM-10 and stop.
- **Parallelization Constraints:** Test files first; production files only on a positive finding. `memory.linux.ts` runs only in the Linux CI job.
- **Definition of Done (DoD):** The scan case exists, carries a T-ZERO id in its title, and passes in CI; the traceability matrix is regenerated; any code change has its own failing-first test.

### Track D: Test Harness Expansion & Automation

D1, D2 and D6 are the guard batch (one signed unlock, maintainer-confirmed). D3, D4 and D5 are ordinary test files and run in parallel with everything.

#### D1. Releases require the full gate

- **Target Subsystem/Files:** `.github/workflows/{release.yml,ci.yml}`, `docs/compliance/release-checklist.md`.
- **Current Antipattern/Issue:** F4.
- **Proposed Engineering Solution:** Turn `ci.yml`'s jobs into a reusable workflow (`workflow_call`) and have `release.yml`'s `verify` call it, so a tag runs lint, guards, traceability, unit, main-process, e2e and the memory evidence before `build`. Add a first step that fails unless the tagged commit is an ancestor of `origin/main`. Keep `publish` dependent on all of them.
- **Parallelization Constraints:** Guard files; lead's unlock and `Guardrail-Change:` trailer. No product code.
- **Definition of Done (DoD):** A tag pushed on a commit with a failing e2e test in a fork or a dry-run branch does not reach `build`. The release checklist names the gate.

#### D2. The trace matrix asserts that tests ran

- **Target Subsystem/Files:** `scripts/traceability.mjs`, `tools/guards/traceability.test.ts`, `packages/desktop/{playwright.config.ts,playwright.linux.config.ts,vitest.main.config.ts}`, root and package `vitest.config.ts`, `.github/workflows/ci.yml`.
- **Current Antipattern/Issue:** F9.
- **Proposed Engineering Solution:** Emit machine-readable results from every runner in CI (Vitest JSON, Playwright JSON) as artifacts. Add `node scripts/traceability.mjs --verify-run <reports...>`: for each finding, every test id must map to at least one result with status passed in the union of reports; skipped or absent is a failure listing the id and file. Run it in a final CI job that downloads the artifacts, and attach its output (commit, job, id, status) to the release as `traceability-evidence.json`. Ids whose only evidence runs outside CI (`*.keychain.ts`, lab items) are listed in an explicit `MANUAL` table with the release-checklist step that covers them.
- **Parallelization Constraints:** Guard files. Coordinates with D1 (same workflows): one branch, D1 first.
- **Definition of Done (DoD):** Renaming a traced test to `it.skip` in a scratch branch fails `--verify-run` while `--check` behaves as today. The evidence file is produced by CI on `main`.

#### D3. Sync fault-injection harness

- **Target Subsystem/Files:** New `packages/sync/test/{faultyDrive.ts,simulationFaults.test.ts}`; `packages/sync/test/simulation.ts` only to export what the new file reuses.
- **Current Antipattern/Issue:** F8's test gap.
- **Proposed Engineering Solution:** `faultyDrive(inner, plan)` wraps any `RemoteDrive` and, from a seeded plan, injects at the Nth call: a thrown `OfflineError`; success on the remote with the response lost; a stall that never resolves (driven by fake timers and the abort signal); a delta that omits or reorders items; a duplicate delivery. A crash is modelled by discarding the engine mid-run and building a new one over the same `LocalStore`. The property, over at least 500 seeds per CI run with `fast-check`: after faults stop and every device syncs to quiescence, all devices hold identical documents and no local edit is missing.
- **Parallelization Constraints:** Test files only; wraps `RemoteDrive`, so it is independent of B3's `LocalStore` change. When B6 adds the signal parameter, the wrapper forwards it. A seed that fails on `main` is reported to Track B with the seed and recorded as a WP-named `it.todo`, per the repo's rule for tests that cannot pass yet.
- **Definition of Done (DoD):** The file runs in `npm test` in under 60 s. Each fault kind is exercised (asserted by counters). Every failing seed found is listed in the PR with its minimal trace.

#### D4. Vault-scale responsiveness probe

- **Target Subsystem/Files:** New `packages/desktop/e2e/perf-vault-scale.spec.ts` and a helper beside it (the name matches the existing `perf` project glob, so no config change).
- **Current Antipattern/Issue:** The budget test cannot see vault-proportional cost (F3, F5).
- **Proposed Engineering Solution:** Seed 2,000 small pages through `window.slate.docs.append`, configure git sync against a local bare repository as `git-sync.spec.ts` does, and let the first sync finish. Then, while a sync run is in progress, measure (a) key latency with the existing `perfMeasure` helpers and (b) main-thread responsiveness as the round-trip time of `window.slate.appVersion()` sampled every 50 ms. Assert p95 key latency within the product budget and no round trip above 100 ms.
- **Parallelization Constraints:** Developed in parallel, **merged after B3** (it fails on `main` by design and is B3's end-to-end acceptance). Does not edit `e2e/spec/**`.
- **Definition of Done (DoD):** The spec fails on `main` with the measured stall in its message and passes on a branch containing B3. Its numbers are quoted in A3's ADR.

#### D5. Private-box canary across every agent tool

- **Target Subsystem/Files:** New `packages/mcp/test/privateCanary.test.ts`; `packages/mcp/test/memorySource.ts` only if it needs a seeding helper.
- **Current Antipattern/Issue:** F6: two example tests guard the rule.
- **Proposed Engineering Solution:** With `fast-check`, generate notebooks and pages with a random mix of boxes; private boxes carry a unique canary in text, link targets, image alt text and to-do items. Through `createSlateMcpServer` over an in-memory transport, call every registered tool (enumerated from the server, so a new tool is covered automatically) with generated arguments, including searches for canary fragments. Assert no canary appears in any response or audit row, and that writes never alter a private box.
- **Parallelization Constraints:** Black-box through the server, so independent of A2's interface change; must be merged before A2.
- **Definition of Done (DoD):** The test passes on `main`, and fails when `agentBoxes`' private branch is removed in a scratch edit (shown in the PR). A tool added without coverage fails the enumeration assertion.

#### D6. Explicit e2e isolation, and guard requests from other tracks

- **Target Subsystem/Files:** `packages/desktop/playwright.config.ts`, `packages/desktop/scripts/e2e.mjs`, `packages/desktop/e2e/fixtures.ts`, `.github/workflows/ci.yml`, `.dependency-cruiser.cjs`, `tools/eslint-rules/**`, `tools/guards/**`.
- **Current Antipattern/Issue:** Specs that share an OS resource are found by regular expressions over their source (`playwright.config.ts:17`, `:34`); a new shared resource is discovered only when it fails, as the Linux drag specs did in CI on the v0.6.7 commit. macOS CI runs no e2e although macOS is a release target.
- **Proposed Engineering Solution:** On Linux, give each Playwright worker its own X display (start one `Xvfb` per worker index in a worker fixture), which removes the pointer-grab and clipboard classes at the source; keep the serial project for the Mac-wide crash-report spec. Add a macOS e2e smoke job (lock, unlock, type, quit) to CI. In the same guard batch apply the other tracks' requests: dependency-cruiser rules for `packages/{sync,mcp,importer,native}` (each may import only `@slate/core` and its declared packages; `sync → importer` recorded as the one allowed cross edge) plus a `no-circular` rule; A2's import restriction for `packages/mcp/src/{tools,server}.ts`; C1's validator-per-channel guard test; C5's CSP ratchet update.
- **Parallelization Constraints:** Guard files; one unlock for the batch. Applies requests only after the requesting package has merged, so the new rules pass on arrival.
- **Definition of Done (DoD):** Twenty consecutive CI e2e runs with the drag specs back in the parallel project show no pointer or clipboard failure. `npm run lint:arch` fails on a scratch import from `packages/mcp` into `packages/desktop`, and on a scratch cycle.

## 3. Global System Interdependencies Matrix

**Ownership of shared surfaces.** Exactly one track edits each; the others send a written request to the owner.

| Shared surface | Owner | Who else is affected | Rule that keeps the build green |
| --- | --- | --- | --- |
| SQLite schema and `DocStore` API (`packages/desktop/src/main/store.ts`) | B (store lane) | A2 (reads through `loadSince`), B5, C | B4 lands the `user_version` mechanism first; every later table is a numbered migration in that file. Nobody else adds a table or column. New `DocStore` methods are added by the store lane on request. |
| `LocalStore` (`packages/sync/src/types.ts`) | B3 | D3 (unaffected: wraps `RemoteDrive`) | `memoryLocal.ts` and `localStore.ts` change in the same commit as the interface. |
| `RemoteDrive` (`packages/sync/src/types.ts`) | B6 | D3, `EncryptingDrive` in `main/sync` | The signal parameter is optional, so existing implementers compile; D3's wrapper forwards it. |
| `DocSource` (`packages/mcp/src/source.ts`) | A2 | `main/mcp/docSource.ts`, `mcp/src/index.ts`, `mcp/test/memorySource.ts`, D5 | All implementers change in A2's branch. D5 is black-box and merges first. |
| IPC surface: `shared/ipc.ts` (`CH`), `ipcGuard.ts` (`CHANNEL_POLICY`, `SELF_TEST_POLICY`), `shared/api.ts`, `preload/index.ts` | C | A, B | No track adds a channel in this plan. Both policy records are `Record<keyof typeof CH, …>`, so a channel added without both rows fails to compile; any future channel goes through C. |
| `BackupPick`, `OneNoteApi.startBackup` (`shared/api.ts`) | C2 | renderer import dialog | Type, preload, handler and dialog change in one branch. |
| Settings schema (`shared/settings/schema.ts`) | C3 | A1 (plugin settings) | A1 fixes its race in the renderer and does not touch the schema. |
| `main/index.ts`, `main/services.ts` | C4 | B2 (one-line wiring), A3 (design only) | B exposes hooks with defaults so its branches compile without C's wiring. |
| `packages/editor/src/PageSession.ts` | B (save lane) | none | B1 then B7, same lane. |
| Guard files (list at the top of section 2) | D (with the lead's unlock) | A2, A3, C1, C5 hand requests | D6 applies a request only after the requesting branch is on `main`. |
| Root and desktop `package.json` version, `CHANGELOG.md` | Lead | all | Tracks add one "Unreleased" line and never bump; the lead bumps at each merge. |

**Ordering constraints.** Everything not listed here is independent.

| Before | After | Why |
| --- | --- | --- |
| D5 | A2 | The canary test must be green on both sides of the interface change. |
| B2 → B4 → B3 → B6 | (serial) | They share `store.ts`, then `engine.ts` and `types.ts`. |
| B1 | B7 | Both edit `PageSession.ts`. |
| B3 | D4 | D4 fails on `main` by design and is B3's acceptance. |
| D4 | A3 | The ADR quotes D4's measurements. |
| C1 → C2 → C3 → C4 → C5 → C6 | (serial) | One lane over `ipc.ts`, `index.ts` and the shared types. |
| B2 | C4 | C4 wires B2's `beforeCompact` hook. |
| D1 | D2 | Same workflow files. |
| A2, C1, C5 merged | D6's matching guard rule | A new rule must pass when it lands. |

**Suggested wave plan** (at most six agents at once):

| Wave | Branches |
| --- | --- |
| 1 | B1, B2, C1, D3, D5, D1 |
| 2 | B4, B5, C2, A1, A2, D2 |
| 3 | B3, B7, C3, D4 (held until B3 merges) |
| 4 | B6, C4, C5, D6, A3 |
| 5 | C6 |
