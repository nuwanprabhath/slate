# Slate Phase 4 — OneDrive Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sync every Slate notebook, page and image across the user's devices through their own OneDrive app folder (`/Apps/Slate`). Sync is offline-first and conflict-free for concurrent edits. Same-box text edits made on two devices while both were offline get a visible "merged edits" marker and a side-by-side resolver. A status indicator shows synced, syncing, offline or error.

**Architecture:**
- **`@slate/sync`** (pure TypeScript):
  - `SyncEngine.syncOnce()` pushes this device's new CRDT updates as **immutable chunk files**, then pulls other devices' files via the OneDrive delta API and imports them;
  - it works over two interfaces, `LocalStore` (the desktop app's SQLite) and `RemoteDrive` (OneDrive Graph, or a fake);
  - a two-device simulation tests convergence under random offline windows.
- **The desktop main process** runs a `SyncService`: on start, every 30 s, 2 s after local writes, and on demand.
  - It writes pulled updates through its own `DocStore` connection, so the Phase 2 external-update watcher delivers them to the open UI.
  - It serves missing images from OneDrive on demand.
  - It records conflicts.
- **The renderer** shows the sync status in the activity bar's bottom slot, a sync on/off control, and conflict markers with a resolver.

Spec: `docs/superpowers/specs/2026-10-21-slate-design.md` §5 (Phase 4 = §10 item 4). One refinement to the spec's layout: instead of rewriting `<deviceId>.log` (OneDrive cannot append), each push uploads a new immutable chunk file. Every file still has a single writer (its device), so OneDrive never produces conflicted copies.

## Global Constraints

- **Remote layout** under the app folder (`/me/drive/special/approot`):
  - `docs/<docKey>/<deviceId>/<seq>.chunk`, a Loro update, where `docKey` is the doc id with `:` replaced by `_` (`page_<uuid>`, `notebook_<uuid>`);
  - `docs/<docKey>/<deviceId>/snapshot-<seq>.bin`, a full snapshot written when compacting;
  - `blobs/<sha256>.<ext>`;
  - `devices/<deviceId>.json`, holding `{ name, platform, lastSeen }`.
- **Single writer per file:** a device only creates, and only deletes, files under its own `<deviceId>/` folders.
- **Device id:** a uuid created once and stored in settings (`deviceId`). Device name: `os.hostname()`.
- **Push only this device's new changes:**
  - per doc, keep `pushedVersion` (Loro version vector bytes) and upload `doc.export({ mode: 'update', from: pushedVersion })` when it is non-empty;
  - after a successful upload, `pushedVersion` becomes the doc's current version;
  - after a pull imports remote files into a doc that had nothing unpushed, set `pushedVersion` to the doc's current version, so remote ops are not re-uploaded.
- **Pull:**
  - `GET /me/drive/special/approot/delta` with the saved `deltaLink` (the first run starts from scratch);
  - for every `.chunk`/`.bin` file outside this device's folder that has not been seen (table `sync_seen(item_id, etag)`), download and import it;
  - deleted items are ignored.
- **Compaction:** when this device has more than 50 chunk files for a doc, upload `snapshot-<seq>.bin` (full doc), then delete this device's older chunks. A snapshot covers everything, so other devices that already imported the chunks lose nothing.
- **Images:**
  - push uploads `blobs/<name>` once (tracked in table `blob_synced(name)`);
  - when the `slate-blob:` protocol is asked for a missing file and sync is on, it downloads `blobs/<name>` from OneDrive, stores it, then serves it.
- **Conflicts:**
  - when a pull imports remote changes that touch the content of a box which this device also changed since its last push, record a conflict `{ pageId, boxId, mine: Markdown of the box before import, theirs: Markdown of the box from the remote change alone applied to the pre-change base, merged: Markdown after import, device }`;
  - the box shows a "merged edits" marker; the resolver offers Keep merged, Keep mine and Keep theirs;
  - resolving rewrites the box content and clears the conflict;
  - **delete vs edit:** if a remote change deletes a box that has unpushed local edits, re-create it with the local content and record a notification "A box deleted on <device> was restored because you edited it".
- **Scopes:** sign-in requests `Notes.Read`, `Files.ReadWrite.AppFolder`, `User.Read`, `offline_access` together. Phase 3's `signIn` changes to request all four, so the user consents once.
- **Network failures:**
  - `syncOnce` never throws to its caller; it returns `{ status: 'offline' | 'error', message }`;
  - fetch network errors mean offline;
  - 401 means sign-in required;
  - other errors use the Phase 3 retry policy, then error.
- **Status:**
  - `idle-synced`, `syncing`, `offline`, `error`, `signed-out`, `disabled`, plus `lastSyncedAt`;
  - the user sees a cloud icon with a tooltip in the activity bar's bottom slot;
  - clicking it opens a small popover: status, last synced, "Sync now", "Turn sync off/on", and the signed-in account.
- **Tests never contact Microsoft:** the fake drive serves the Graph drive endpoints used here.
- Conventional Commits, no AI attribution, never push to git.

## Graph drive endpoints used

Relative to the Graph base URL (`SLATE_GRAPH_URL`, as in Phase 3):
- `PUT /me/drive/special/approot:/<path>:/content` (body: bytes; for 4 MB or less). Larger files: `POST /me/drive/special/approot:/<path>:/createUploadSession`, then PUT ranges.
- `GET /me/drive/special/approot:/<path>:/content` (download).
- `DELETE /me/drive/special/approot:/<path>`.
- `GET /me/drive/special/approot/delta` (or the saved `@odata.deltaLink`). Follow `@odata.nextLink` until `@odata.deltaLink`.
  - Each item has `id`, `name`, `eTag`, `deleted?`, `file?`, and `parentReference.path` (e.g. `/drive/root:/Apps/Slate/docs/page_x/dev1`).
  - Paths relative to the app folder are computed by stripping everything up to and including the app folder's own path, which `GET /me/drive/special/approot` reveals once (`parentReference.path` + `/` + `name`).

---

## File Structure

```
packages/importer/src/graph.ts              (modify) extract GraphHttp (request/retry/semaphore) and export it
packages/sync/                              (new package @slate/sync, deps: @slate/core, @slate/importer, loro-crdt)
  src/types.ts         LocalStore, RemoteDrive, RemoteItem, SyncReport, ConflictRecord
  src/paths.ts         docKey, chunkPath, parseRemotePath
  src/oneDrive.ts      OneDriveClient implements RemoteDrive (over GraphHttp)
  src/engine.ts        SyncEngine (push, pull, compaction, conflicts)
  src/conflicts.ts     boxesTouched(updateBytes, baseDoc), describeBox
  test/memoryDrive.ts  in-memory RemoteDrive (with offline switch)
  test/memoryLocal.ts  in-memory LocalStore
  test/fakeDrive.ts    HTTP fake of the drive endpoints (used by oneDrive.test and e2e)
  test/{paths,oneDrive,engine,simulation,conflicts}.test.ts
packages/desktop/src/main/sync/{syncService.ts,localStore.ts,syncService.test.ts}
packages/desktop/src/main/{store.ts,blobs.ts,index.ts,ipc.ts,settings.ts}   (modify)
packages/desktop/src/main/onenote/auth.ts   (modify) scopes
packages/desktop/src/shared/{api,ipc}.ts, src/preload/index.ts              (modify)
packages/desktop/src/renderer/src/sync/{SyncStatus.tsx,ConflictResolver.tsx,sync.css}  (new)
packages/desktop/src/renderer/src/activity/*  (modify) bottom slot for status
packages/editor/src/Box.tsx                  (modify) conflict marker (prop from host)
packages/desktop/e2e/sync.spec.ts            (new, two app instances + fake drive)
```

---

### Task 1: Shared Graph HTTP and the OneDrive client

**Files:**
- Modify `packages/importer/src/graph.ts`: extract `export class GraphHttp { constructor(opts: { baseUrl; getToken; fetch?; maxConcurrent?; sleep?; maxRetries? }); json<T>(pathOrUrl: string, init?: RequestInit): Promise<T>; bytes(pathOrUrl: string): Promise<{ bytes: Uint8Array; mime: string }>; send(pathOrUrl: string, init: RequestInit): Promise<Response> }`, which `GraphClient` uses. Behaviour is unchanged; the importer tests stay green.
- Create the `packages/sync` package (`package.json` like `@slate/importer`'s, `vitest.config.ts` with name `sync`), `src/{types,paths,oneDrive}.ts`, `test/{fakeDrive,paths.test,oneDrive.test}.ts`.

**Interfaces** (`src/types.ts`):

```ts
export interface RemoteItem { id: string; path: string; eTag: string; deleted: boolean; isFile: boolean }
export interface DeltaPage { items: RemoteItem[]; cursor: string }
export interface RemoteDrive {
  upload(path: string, bytes: Uint8Array): Promise<void>
  download(path: string): Promise<Uint8Array>
  remove(path: string): Promise<void>
  /** All changes since `cursor` (null = from scratch), following paging; returns the next cursor. */
  delta(cursor: string | null): Promise<DeltaPage>
}
export type SyncStatus = 'idle-synced' | 'syncing' | 'offline' | 'error' | 'signed-out' | 'disabled'
export interface SyncReport { status: SyncStatus; message?: string; pushed: number; pulled: number; conflicts: number; at: number }
export interface ConflictRecord { id: string; pageId: string; boxId: string; device: string; mine: string; theirs: string; merged: string; at: number }
export interface LocalStore {
  docIds(): Promise<string[]>
  loadDoc(docId: string): Promise<Uint8Array[]>
  /** Appends updates that came from another device (they are never pushed back). */
  appendRemote(docId: string, update: Uint8Array): Promise<void>
  getMeta(key: string): Promise<string | undefined>
  setMeta(key: string, value: string): Promise<void>
  getBytesMeta(key: string): Promise<Uint8Array | undefined>
  setBytesMeta(key: string, value: Uint8Array): Promise<void>
  seen(itemId: string, eTag: string): Promise<boolean>
  markSeen(itemId: string, eTag: string): Promise<void>
  blobNames(): Promise<string[]>
  readBlob(name: string): Promise<Uint8Array>
  blobSynced(name: string): Promise<boolean>
  markBlobSynced(name: string): Promise<void>
  addConflict(c: ConflictRecord): Promise<void>
  notify(message: string): Promise<void>
}
```

`paths.ts`:
- `docKey(docId)`
- `docIdFromKey(key)`
- `chunkPath(docId, deviceId, seq)` → `docs/<key>/<device>/<seq padded to 8>.chunk`
- `snapshotPath(docId, deviceId, seq)`
- `parseRemotePath(path): { kind: 'chunk' | 'snapshot'; docId: string; deviceId: string; seq: number } | { kind: 'blob'; name: string } | { kind: 'device' | 'other' }`

`fakeDrive.ts`: `startFakeDrive(): Promise<{ url; files: Map<string, Uint8Array>; offline(on: boolean): void; close() }>`. It implements the endpoints listed above:
- delta tokens are a monotonically increasing change counter encoded in the `deltaLink`;
- items report `parentReference.path` as `/drive/root:/Apps/Slate/<dir>`;
- `GET /me/drive/special/approot` returns `{ name: 'Slate', parentReference: { path: '/drive/root:/Apps' } }`;
- it requires `Bearer fake-token`;
- when offline, it destroys sockets, so clients see network errors.

- [ ] **Step 1: Failing tests.**
  - `paths.test.ts`: round-trips for every kind, zero-padded seq, and `docIdFromKey(docKey('page:abc')) === 'page:abc'`.
  - `oneDrive.test.ts` (against `startFakeDrive`):
    - upload then download gives the same bytes;
    - remove then delta reports the item deleted;
    - delta from null lists every file with relative paths (`docs/page_x/dev1/00000001.chunk`);
    - delta from the returned cursor lists only later changes;
    - offline makes `delta` reject with an error whose `offline` property is `true` (network errors are wrapped in `class OfflineError extends Error`, exported).
- [ ] **Step 2: Implement** the `GraphHttp` extraction (run `npx vitest run packages/importer` to prove it unchanged), then `paths.ts`, `oneDrive.ts` (`OneDriveClient implements RemoteDrive`, constructed with a `GraphHttp`), and `fakeDrive.ts`.
- [ ] **Step 3: Run** `npx vitest run packages/sync packages/importer && npm run typecheck` — PASS.
- [ ] **Step 4: Commit** — `git commit -am "feat(sync): OneDrive app-folder client over shared Graph HTTP, with a fake drive"`

---

### Task 2: The sync engine (push, pull, compaction)

**Files:** Create `packages/sync/src/engine.ts`, `test/memoryDrive.ts`, `test/memoryLocal.ts`, `test/engine.test.ts`, `test/simulation.test.ts`.

**Interfaces:**
- `class SyncEngine { constructor(opts: { local: LocalStore; remote: RemoteDrive; deviceId: string; deviceName: string; compactAfter?: number /* default 50 */ }); syncOnce(): Promise<SyncReport> }`
- `memoryDrive()` returns a `RemoteDrive & { offline: boolean; files: Map<string, Uint8Array> }`, with delta over an in-memory change log.
- `memoryLocal()` returns a `LocalStore & { docs: Map<string, Uint8Array[]>; conflicts: ConflictRecord[]; notes: string[]; appendLocal(docId: string, update: Uint8Array): void; doc(docId: string): LoroDoc }`.

`syncOnce` algorithm (each step's failure maps to the report, never thrown):
1. **Push.** For each `docId`:
   - load the doc;
   - `pushedVersion` = `getBytesMeta('pushed:' + docId)` (absent means push everything);
   - `update = doc.export({ mode: 'update', from: VersionVector.decode(pushedVersion) })`;
   - if the update carries ops (decode with `decodeImportBlobMeta`, or compare the version vectors), upload it as `chunkPath(docId, deviceId, nextSeq)`, where `nextSeq` comes from meta `seq:<docId>`;
   - then store `pushedVersion = doc.oplogVersion().encode()`;
   - count this device's chunks per doc in meta, and when they exceed `compactAfter`, upload a snapshot and remove this device's chunk paths, which are recorded in meta `chunks:<docId>` as a JSON list.
2. **Upload blobs:** every `blobNames()` entry not `blobSynced` gets uploaded to `blobs/<name>` and marked.
3. **Write `devices/<deviceId>.json`.**
4. **Pull:** `delta(getMeta('deltaCursor'))`. For each file item whose parsed path is a chunk or snapshot from **another** device and that is not `seen(id, eTag)`:
   - download it;
   - run conflict detection (Task 3; a stub that returns no conflicts until then);
   - `appendRemote(docId, bytes)`;
   - `markSeen`.

   Save the cursor. Then, for each doc that imported something and had no unpushed local ops before the pull, set `pushedVersion` to its new version.
5. Return `idle-synced`, with counts and `at: Date.now()`.

- [ ] **Step 1: Failing tests.**
  - `engine.test.ts`, with two `memoryLocal`s and one `memoryDrive`:
    - a box added on A appears on B after A then B sync;
    - concurrent edits to different boxes converge (A and B sync twice each, then `toJSON` matches);
    - nothing unpushed means nothing uploaded;
    - a remote op is never re-uploaded by B (count the files under B's folder after B pulls A's change: 0 new chunks);
    - after 51 local commits synced one at a time, A has a snapshot and at most 1 chunk, and a fresh device C still converges;
    - blobs upload once;
    - offline drive returns `status: 'offline'`, and the next online sync catches up.
  - `simulation.test.ts`: a deterministic PRNG (seeded) drives 3 devices for 200 steps. Each step picks a random device and a random action:
    - add a box;
    - type into a random box (append text to its content);
    - move a box;
    - toggle offline;
    - sync.

    Finally every device goes online and syncs twice. Assert that all three docs' `toJSON()` are deep-equal. Run 5 seeds.
- [ ] **Step 2: Implement** `engine.ts` and the memory fakes.
- [ ] **Step 3: Run** `npx vitest run packages/sync` — PASS.
- [ ] **Step 4: Commit** — `git commit -am "feat(sync): push/pull/compaction engine with multi-device convergence simulation"`

---

### Task 3: Conflict detection, delete-vs-edit restore

**Files:** Create `packages/sync/src/conflicts.ts`, `test/conflicts.test.ts`. Modify `engine.ts`.

**Interfaces:**
- `boxesTouched(base: LoroDoc, update: Uint8Array): { contentEdited: Set<string>; deleted: Set<string> }`. Fork `base`, subscribe, import the update, and read event paths. `['boxes', id, 'content', …]` means content edited; a `boxes` map delete of `id` means deleted.
- `boxMarkdown(doc: LoroDoc, boxId: string): string`, through `@slate/core`'s `contentToJSON` + `toMarkdown`.
- Engine change, per pulled page update, before `appendRemote`:
  - `local` = this device's doc;
  - `localEdited` = the boxes whose content changed in `local.export({ mode: 'update', from: pushedVersion })`, applied to a fork of `local` at `pushedVersion` (`forkAt(frontiers of pushedVersion)`);
  - `remote` = `boxesTouched(local, update)`;
  - for each box in `localEdited ∩ remote.contentEdited`, record a `ConflictRecord`:
    - `mine` = `boxMarkdown(local)`;
    - `theirs` = the box after importing `update` into a fork at `pushedVersion` (the remote change without the local one);
    - `merged` = the box after importing `update` into a fork of `local`;
    - `device` = the remote device id;
  - for each box in `localEdited ∩ remote.deleted`, after `appendRemote`, re-create the box from `local`'s pre-import state as a local change (`PageDoc.addBox` + `writeContent` with the old content and position), then `notify("A box deleted on another device was restored because you edited it")`.

- [ ] **Step 1: Failing tests** (`conflicts.test.ts`, two memory devices):
  - A and B both type into the same box while offline. B syncs and pulls A's change, and gets exactly one conflict whose `mine` has B's text, `theirs` has A's text, and `merged` contains both.
  - Edits to different boxes produce no conflict.
  - A deletes a box that B edited offline. After B pulls, the box exists on B with B's text, and B's notes contain the restore message. After A pulls B's next push, A has it too.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run** `npx vitest run packages/sync` — PASS (including the simulation).
- [ ] **Step 4: Commit** — `git commit -am "feat(sync): detect same-box offline edits and restore boxes deleted against local edits"`

---

### Task 4: The desktop sync service

**Files:** Create `packages/desktop/src/main/sync/{localStore.ts,syncService.ts,syncService.test.ts}`. Modify:
- `store.ts`: `origin` column on `updates` (`'local'` default, `'remote'` from sync); tables `sync_meta(key, value BLOB)`, `sync_seen`, `blob_synced`, `conflicts`, `notices`; compaction stays local and safe because pushes export from versions.
- `blobs.ts`: `list()`, `read(name)`, `write(name, bytes)`.
- `index.ts`: start the service.
- `ipc.ts`, `settings.ts`: `syncEnabled`, default false; `deviceId`.
- `onenote/auth.ts`: sign-in scopes.
- the `slate-blob` protocol handler: fetch on miss.
- `shared/api.ts` + preload, adding:
  - `sync: { status(): Promise<SyncReport & { enabled: boolean; account?: string }>; setEnabled(on: boolean): Promise<void>; now(): Promise<SyncReport>; conflicts(pageId?: string): Promise<ConflictRecord[]>; resolve(id: string, choice: 'merged' | 'mine' | 'theirs'): Promise<void>; onStatus(h): () => void; onNotice(h: (message: string) => void): () => void }`

**Behaviour:**
- `SyncService` builds `SyncEngine` with `LocalStore` over its own `DocStore` connection (writes from `appendRemote` are external to the renderer's connection, so the Phase 2 watcher pushes them live) and an `OneDriveClient` over `GraphHttp`, whose `getToken` is `auth.token([...sync scopes])`.
- **Triggers:** start-up, a 30 s interval, 2 s after any `docs:append` IPC (debounced), and `sync.now()`. Only one sync runs at a time; a trigger during a sync schedules one more.
- **Status** goes to all windows on `sync:status`. When disabled or signed out, it never touches the network.
- **`resolve('mine' | 'theirs')`:** replace the box's content with the chosen Markdown through `markdownToBlocks` + `writeContent` in a page update appended locally (pushed next sync), then delete the conflict. `'merged'` only deletes the conflict.
- **Test mode:** with `SLATE_FAKE_AUTH=1` (e2e) the fake auth token is used, and `SLATE_GRAPH_URL` points at the fake drive. `SLATE_SYNC_INTERVAL_MS` overrides the 30 s interval in e2e.

- [ ] **Step 1: Failing tests** (`syncService.test.ts`, `test:main`). Two `DocStore` files (device A and B) and one `startFakeDrive`, each with a `SyncService` using fake auth:
  - a page doc written to A's store appears in B's store after `now()` on A then B, with `origin = 'remote'` on B;
  - B's `now()` uploads nothing for that doc;
  - status events go `syncing` → `idle-synced`;
  - drive offline gives `offline`;
  - a blob put on A is served on B after sync through the protocol's fetch-on-miss path (`BlobStore.read` after `ensureBlob(name)`).
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run** `npm run test:main && npm run typecheck` — PASS.
- [ ] **Step 4: Commit** — `git commit -am "feat(desktop): background OneDrive sync service with live delivery to the open app"`

---

### Task 5: Sync status, conflict markers and the resolver UI; two-instance e2e

**Files:**
- Create `packages/desktop/src/renderer/src/sync/{SyncStatus.tsx,ConflictResolver.tsx,sync.css}`, `packages/desktop/e2e/sync.spec.ts`.
- Modify the activity bar (a `bottom` slot rendered under the tools, for status items), `App.tsx` (notices as a dismissible toast, `data-testid="notice"`), `PageView`/`Canvas`, and `packages/editor/src/Box.tsx`.
  - `Canvas` gets an optional `conflicts?: Set<string>` prop and an `onConflictClick?(boxId)`.
  - `Box` shows a small amber "merged edits" chip (`data-testid="conflict-chip"`) in its bar when its id is in the set.

**UI:**
- **`SyncStatus`** (`data-testid="sync-status"`): a cloud icon in the activity bar's bottom slot.
  - States and their icon variants:
    - synced: check;
    - syncing: animated arrows, with a still frame under reduced motion;
    - offline: slash;
    - error: exclamation in red;
    - signed out / disabled: muted.
  - The tooltip gives the status and "Last synced 2 min ago".
  - Clicking opens a popover (`sync-popover`):
    - status text;
    - last synced;
    - "Sync now" (`sync-now`);
    - "Turn on sync" / "Turn off sync" (`sync-toggle`; turning on when signed out runs the Phase 3 sign-in);
    - the account.
- **`ConflictResolver`** (`data-testid="conflict-resolver"`): opened by the chip.
  - Three columns: "This device", "Other device (<device>)" and "Merged", each showing the Markdown in a monospace, scrollable pane.
  - Buttons: "Keep merged" (`resolve-merged`), "Keep this device's" (`resolve-mine`), "Keep other device's" (`resolve-theirs`).
  - Closes on Escape.

- [ ] **Step 1: Failing e2e** (`sync.spec.ts`):
  - **Setup:** in `beforeAll`, `startFakeDrive()`. Launch two app instances, A and B, each with its own `userData` and `SLATE_GRAPH_URL=<fake>`, `SLATE_FAKE_AUTH=1` and `SLATE_SYNC_INTERVAL_MS=500`. On both, turn sync on via the popover.
  - **Live sync:** A types "hello from A" in a new box. B shows a box with that text within 10 s, live, with no reload.
  - **Status:** the status icon shows synced (`data-state="idle-synced"`) on both.
  - **Offline:** `fake.offline(true)` makes A's status `offline` within 5 s. Back online gives `idle-synced`.
  - **Conflict:**
    1. both apps open the same page;
    2. the drive goes offline;
    3. A and B each type different text at the end of the same box;
    4. the drive comes online;
    5. within 15 s, at least one app shows `conflict-chip` on that box;
    6. opening it shows both texts; "Keep this device's" removes the chip;
    7. after the next sync both apps show the same box text.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run** the full `npm run e2e` twice, plus `npm test`, `npm run test:main` and `npm run typecheck` — all PASS.
- [ ] **Step 4: Commit** — `git commit -am "feat(desktop): sync status, conflict markers with a resolver, and two-instance sync e2e"`

---

## Done criteria for Phase 4

- **Turning sync on** while signed in makes edits on one device appear on another, live.
- **Offline work** syncs when the connection comes back.
- **Same-box offline edits** show a "merged edits" chip with a resolver. Boxes deleted elsewhere but edited here come back, with a notice.
- **Images** follow their pages.
- **The status icon** tells the truth.
- All unit, simulation, main-process and two-instance e2e tests pass.
