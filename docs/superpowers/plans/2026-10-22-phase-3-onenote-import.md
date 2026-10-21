# Slate Phase 3 — OneNote Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sign in with a Microsoft account and import chosen OneNote notebooks, section groups or sections into Slate. Each absolutely positioned OneNote element becomes a Slate box at the same position, keeping text formatting, lists, tables, images and page order/levels. The import is throttled, resumable and re-runnable (it updates changed pages) and ends with a report of what could not be carried over.

**Architecture:**
- **`@slate/importer`** (pure TypeScript, tested in Node):
  - `mapOneNotePage(html)` turns Graph's page HTML into `MappedPage` boxes (via linkedom);
  - `GraphClient` implements `GraphSource` over `fetch`, with paging, concurrency 2 and retry/backoff on 429/503 honouring `Retry-After`;
  - `runImport` walks the selection and drives an `ImportSink`, checkpointing in `ImportState`.
- **Shared types** live in `packages/importer/src/types.ts` (already on `main`; do not change their shapes).
- **`@slate/core`** learns to write marks, so imported bold, colour, links and so on survive.
- **The desktop main process** adds:
  - the `AuthService` (MSAL Node public client, loopback redirect, token cache encrypted with Electron `safeStorage`, plus a fake auth for e2e);
  - the `ImportService` (sink and state over a second `DocStore` connection, so the renderer receives the writes through the Phase 2 external-update watcher);
  - IPC.
- **The renderer** adds the import dialog.

**Tech Stack:** `@azure/msal-node` 7.1, `linkedom` 0.18, plus the existing stack.

Spec: `docs/superpowers/specs/2026-10-21-slate-design.md` §6. Repo rules: `CLAUDE.md`.

## Global Constraints

- **Read-only access to OneNote:** scopes `Notes.Read`, `User.Read`, `offline_access`. Phase 4 adds `Files.ReadWrite.AppFolder`, so `AuthService` takes scopes per call.
- **Client id:** from `SLATE_MS_CLIENT_ID` (env) or the `msClientId` setting. When neither is set, the import dialog explains how to register an Azure app (public client, redirect `http://localhost`) and where to paste the id. Authority: `https://login.microsoftonline.com/common`.
- **Graph base URL:** `SLATE_GRAPH_URL` (default `https://graph.microsoft.com/v1.0`). Tests point it at a local fake server.
- **Fake auth:** `SLATE_FAKE_AUTH=1` (honoured only when `SLATE_E2E=1`) makes `AuthService` return the token `fake-token` and the account `test@example.com`.
- **Throttling:** at most 2 concurrent Graph requests. On 429/503, wait `Retry-After` seconds, or else 1, 2, 4, 8, 16 s; give up after 5 retries.
- **Uniform failure handling:** a failed page is recorded with its error in the report and in `ImportState`, and the import continues. "Retry failed" re-runs only failed pages.
- **Re-running** skips pages whose `lastModified` is unchanged and replaces pages that changed.
- **Never block the UI:** the import runs in main and reports progress events at least once per page.
- **Lossy items** are listed in the report: ink drawings, file attachments, embedded video/iframes, unsupported elements.
- E2E never contacts Microsoft; it uses the fake Graph server. No network in unit tests.
- Conventional Commits, no AI attribution, never push. The `\u` escape form for invisible characters.

---

## File Structure

```
packages/core/src/content.ts            (modify) writeContent writes marks
packages/importer/src/types.ts          (exists) shared contract — do not change shapes
packages/importer/src/map.ts            (new) mapOneNotePage
packages/importer/src/graph.ts          (new) GraphClient implements GraphSource
packages/importer/src/engine.ts         (new) runImport, selectionToPaths
packages/importer/test/fixtures/*.html  (new) Graph page HTML samples
packages/importer/test/fakeGraph.ts     (new) local HTTP fake of the OneNote Graph API (also used by e2e)
packages/importer/test/memorySink.ts    (new)
packages/importer/test/{map,graph,engine}.test.ts
packages/desktop/src/main/onenote/auth.ts           (new) AuthService (MSAL + safeStorage, fake)
packages/desktop/src/main/onenote/importService.ts  (new) sink + state over DocStore, runs runImport
packages/desktop/src/main/store.ts                  (modify) import_items table helpers
packages/desktop/src/shared/{api,ipc}.ts, preload, main/ipc.ts, main/menu.ts (modify)
packages/desktop/src/renderer/src/import/ImportDialog.tsx, import.css (new)
packages/desktop/src/renderer/src/library.ts         (modify) importExternal loads unknown notebooks
packages/desktop/e2e/onenote-import.spec.ts          (new)
```

---

### Task 1: `writeContent` writes marks

**Files:** Modify `packages/core/src/content.ts`. Test: `packages/core/test/content.test.ts` (new), plus extend `packages/editor/test/content.test.ts`.

**Interfaces:** `writeContent(root: LoroMap, blocks: PMJSON[]): void` now also writes `text` nodes' `marks`. Each mark is stored as a Loro text style whose key is the mark name and whose value is the mark's attrs object (`{}` when it has none). That is exactly loro-prosemirror's format (`nodeMarksToAttributes`: `pattrs[mark.type.name] = mark.attrs`). Before marking, the doc's text style for each mark name is configured with `expand: 'after'`, except `link` and `code`, which use `'none'`, matching ProseMirror's `inclusive: false`.

- [ ] **Step 1: Failing tests.** `packages/core/test/content.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { LoroDoc } from 'loro-crdt'
import { contentToJSON, writeContent } from '../src/content'

describe('writeContent marks', () => {
  it('round-trips text marks through contentToJSON', () => {
    const doc = new LoroDoc()
    const root = doc.getMap('c')
    writeContent(root, [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'plain ' },
          { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
          { type: 'text', text: ' red', marks: [{ type: 'textStyle', attrs: { color: '#ff0000' } }] },
          { type: 'text', text: ' link', marks: [{ type: 'link', attrs: { href: 'https://x.dev' } }] },
        ],
      },
    ])
    doc.commit()
    const para = contentToJSON(root)!.content![0]
    expect(para.content).toEqual([
      { type: 'text', text: 'plain ' },
      { type: 'text', text: 'bold', marks: [{ type: 'bold', attrs: {} }] },
      { type: 'text', text: ' red', marks: [{ type: 'textStyle', attrs: { color: '#ff0000' } }] },
      { type: 'text', text: ' link', marks: [{ type: 'link', attrs: { href: 'https://x.dev' } }] },
    ])
  })
})
```

Append to `packages/editor/test/content.test.ts` (it already imports `createNodeFromLoroObj` and `schema`):

```ts
describe('writeContent marks in the editor schema', () => {
  it('produces marks loro-prosemirror reads as ProseMirror marks', () => {
    const doc = new LoroDoc()
    const root = doc.getMap('content')
    writeContent(root, [{ type: 'paragraph', content: [{ type: 'text', text: 'B', marks: [{ type: 'bold' }] }, { type: 'text', text: 'L', marks: [{ type: 'link', attrs: { href: 'https://x.dev' } }] }] }])
    doc.commit()
    const node = createNodeFromLoroObj(schema, root as unknown as LoroNode, new Map())
    const para = node.child(0)
    expect(para.child(0).marks.map((m) => m.type.name)).toEqual(['bold'])
    expect(para.child(1).marks[0].attrs.href).toBe('https://x.dev')
  })
})
```

- [ ] **Step 2: Run them to see them fail:** `npx vitest run packages/core/test/content.test.ts packages/editor/test/content.test.ts`.

- [ ] **Step 3: Implement.** In `content.ts`, write consecutive text nodes into one `LoroText`, inserting run by run and then applying marks:

```ts
function writeTextRuns(children: LoroList, runs: PMJSON[]): void {
  const text = children.insertContainer(children.length, new LoroText())
  let at = 0
  const marks: Array<{ start: number; end: number; type: string; attrs: Record<string, unknown> }> = []
  for (const run of runs) {
    const value = run.text ?? ''
    text.insert(at, value)
    for (const m of run.marks ?? []) marks.push({ start: at, end: at + value.length, type: m.type, attrs: m.attrs ?? {} })
    at += value.length
  }
  for (const m of marks) if (m.end > m.start) text.mark({ start: m.start, end: m.end }, m.type, m.attrs as Value)
}
```

In `writeNode`, group consecutive `text` children and call `writeTextRuns` for each group, with non-text children in between as before.

Configure the text styles on the doc before any mark is applied. `writeContent` receives only the root map, so get the doc from it: in loro-crdt 1.16 a container attached to a doc exposes it (check `LoroMap` in `node_modules/loro-crdt/nodejs/loro_wasm.d.ts` for `.doc` or `getAttached()`). Then call `doc.configTextStyle({ ...existing, [type]: { expand: NON_INCLUSIVE.has(type) ? 'none' : 'after' } })` for every mark type used.

If Loro offers no way to reach the doc from a container, add an optional third parameter, `writeContent(root, blocks, doc?: LoroDoc)`, and pass the doc from every caller: `PageSession.createBoxWithContent`, the MCP tools, the importer sink. Record that under "Plan deviations".

- [ ] **Step 4: Run** `npm test && npm run typecheck` — PASS (all existing tests too).
- [ ] **Step 5: Commit** — `git commit -am "feat(core): writeContent writes text marks in loro-prosemirror's format"`

---

### Task 2: Map OneNote page HTML to boxes

**Files:** Create `packages/importer/src/map.ts`, `packages/importer/test/fixtures/{simple,formatting,lists-tables,code-and-lossy}.html`, `packages/importer/test/map.test.ts`. Modify `packages/importer/src/index.ts` (export `./map`).

**Interfaces:** `mapOneNotePage(html: string): MappedPage` (types from `types.ts`).

Mapping rules:
- **Title:** `<title>` text, trimmed.
- **Boxes:**
  - every **direct child of `<body>`** whose `style` has `position:absolute` (OneNote puts `data-absolute-enabled="true"` on body) becomes one box;
  - `x`/`y`/`width` come from `left`/`top`/`width` in px (`pt` × 4/3; missing width → 480);
  - after mapping, all `y` values are shifted so the smallest becomes 40 (OneNote's title area is not part of the canvas); `x` is kept;
  - boxes are sorted by `y` then `x`;
  - a body child that is not absolutely positioned (rare: pages without absolute layout) joins one box at `x: 48`, after the positioned ones.
- **Blocks inside a box:**
  - `p` → `paragraph`, `h1`–`h6` → `heading` (level capped at 3);
  - `ul`/`ol` → `bulletList`/`orderedList` (with `start`), with `li` → `listItem`; nested lists are kept;
  - `table`/`tr`/`td`/`th` → `table`/`tableRow`/`tableCell` (`tableHeader` for `th`); each cell's content is blocks, with bare inline text wrapped in a paragraph;
  - `img` → `image` with `attrs.src` = the `src` attribute (a Graph resource URL) and `attrs.alt` = `alt`;
  - `br` → `hardBreak`; `div` → recurse into its children;
  - `pre`, or two or more **consecutive** paragraphs whose `font-family` is monospace (Consolas, Courier New, Menlo, Monaco, `monospace`), → one `codeBlock`, with lines joined by `\n` and `language: 'plaintext'`.
- **Inline marks:**
  - `b`/`strong` or `font-weight:bold|700+` → `bold`;
  - `i`/`em` or `font-style:italic` → `italic`;
  - `u` or `text-decoration:underline` → `underline`;
  - `s`/`del`/`strike` or `line-through` → `strike`;
  - `a[href]` → `link {href}`;
  - inline `font-family` (non-default) → `textStyle {fontFamily}`, `font-size` → `textStyle {fontSize}` (as written, e.g. `14pt`), `color` → `textStyle {color}`. Merge them into one `textStyle` mark;
  - `background-color` → `highlight {color}`;
  - the body's default font (`font-family:Calibri;font-size:11pt` on `<body>`) is never emitted as a mark.
- **To-do tags:** an element with `data-tag` containing `to-do` → text prefixed `☐ `, or `☑ ` when the tag contains `completed`.
- **Lossy items:**
  - `<object data-attachment="name">` → paragraph `[Attachment: name]` + lossy `Attachment "name"`;
  - `<iframe data-original-src=…>` → paragraph with a link to the original src + lossy `Embedded content (<host>)`;
  - an `img` whose `data-src-type` is missing and whose `src` is not a Graph resource and not `data:` → kept, plus lossy `External image`;
  - an ink placeholder (an element with `data-ink` or an `img` with `alt` starting "Ink") → lossy `Ink drawing (imported as image)` if it has an src, else `Ink drawing (not imported)`.
- **Whitespace:** NBSP becomes a space, zero-width characters are dropped, and empty paragraphs produced by OneNote spacing are kept, at most one in a row.

- [ ] **Step 1: Fixtures.** Write the four HTML fixtures by hand in Graph's format. `simple.html`:

```html
<html lang="en-US">
<head><title>Deploy notes</title><meta name="created" content="2026-01-02T10:00:00.0000000" /></head>
<body data-absolute-enabled="true" style="font-family:Calibri;font-size:11pt">
<div style="position:absolute;left:48px;top:115px;width:624px">
<p style="margin-top:0pt;margin-bottom:0pt">First box line</p>
<p>Second line</p>
</div>
<div style="position:absolute;left:700px;top:160px;width:300px">
<p>Right box</p>
</div>
</body>
</html>
```

`formatting.html` exercises `<b>`, `<span style="font-weight:bold">`, `<i>`, `<u>`, `<span style="color:#FF0000">`, `<span style="font-family:Consolas">`, `<span style="background-color:yellow">`, `<a href>`, `<br />`, NBSP, and a to-do tag. `lists-tables.html` has nested `ol` (start 3) / `ul`, a 2×2 table with a `<th>` header row, and an `<img src="https://graph.microsoft.com/v1.0/users('x')/onenote/resources/abc/$value" data-src-type="image/png" width="100" height="50" />`. `code-and-lossy.html` has three consecutive Consolas paragraphs, an `<object data-attachment="report.pdf" …>`, an `<iframe data-original-src="https://www.youtube.com/watch?v=x">`, and a non-positioned trailing `<p>`.

- [ ] **Step 2: Failing tests.** `map.test.ts`, one test per fixture, asserting exact `MappedPage` structures:
  - `simple`: title, 2 boxes, y values `40` and `85`, x values `48` and `700`, widths, paragraph texts.
  - `formatting`: the exact mark lists per text run, including the merged `textStyle`. Also no mark for the body default font, and NBSP → space.
  - `lists-tables`: the nested list JSON with `start: 3`, the table with `tableHeader` cells, and the image `src` equal to the Graph URL.
  - `code-and-lossy`: one `codeBlock` whose text is the three lines joined with `\n`; the attachment and embed paragraphs; `lossy` equal to `['Attachment "report.pdf"', 'Embedded content (www.youtube.com)']`; the trailing paragraph in a box at x 48 after the others.

Write the expected objects in full in the test, from the rules above. Run `npx vitest run packages/importer` and expect FAIL.

- [ ] **Step 3: Implement `map.ts`** with `parseHTML` from `linkedom`. Structure:
  - `parseStyle(style: string): Record<string, string>`;
  - `px(value: string): number | null`;
  - `blocksOf(element, inherited): PMJSON[]`;
  - `inlineOf(node, marks): PMJSON[]`, which accumulates marks from the element chain and drops the body's default font family and size;
  - `mergeCodeParagraphs(blocks)`;
  - `mapOneNotePage(html)`.

  Keep each function under ~60 lines. Use only the DOM API linkedom provides (`childNodes`, `nodeType`, `tagName`, `getAttribute`, `textContent`).

- [ ] **Step 4: Run** `npx vitest run packages/importer && npm run typecheck` — PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(importer): map OneNote page HTML to positioned Slate boxes"`

---

### Task 3: Graph client and the fake Graph server

**Files:** Create `packages/importer/src/graph.ts`, `packages/importer/test/fakeGraph.ts`, `packages/importer/test/graph.test.ts`. Export `./graph` from `index.ts`.

**Interfaces:**
- `class GraphClient implements GraphSource`, with `constructor(opts: { baseUrl: string; getToken: () => Promise<string>; fetch?: typeof fetch; maxConcurrent?: number; sleep?: (ms: number) => Promise<void>; maxRetries?: number })`
- `startFakeGraph(data: FakeGraphData): Promise<{ url: string; requests: string[]; failNext(status: number, times: number, retryAfter?: number): void; close(): Promise<void> }>`
- `interface FakeGraphData { notebooks: Array<{ id: string; name: string; sections: FakeSection[]; sectionGroups: Array<{ id: string; name: string; sections: FakeSection[]; sectionGroups: [] }> }> }`
- `interface FakeSection { id: string; name: string; pages: Array<{ id: string; title: string; level: number; order: number; lastModified: string; html: string }> }`
- The fake also serves `/resources/<id>/$value` as a 1×1 PNG.

Graph endpoints used (relative to `baseUrl`):
- `GET /me/onenote/notebooks?$select=id,displayName`
- `GET /me/onenote/notebooks/{id}/sections?$select=id,displayName,lastModifiedDateTime`
- `GET /me/onenote/notebooks/{id}/sectionGroups?$select=id,displayName`
- `GET /me/onenote/sectionGroups/{id}/sections…` and `GET /me/onenote/sectionGroups/{id}/sectionGroups…`
- `GET /me/onenote/sections/{id}/pages?pagelevel=true&$select=id,title,level,order,lastModifiedDateTime&$top=100`, following `@odata.nextLink` (absolute URL)
- `GET /me/onenote/pages/{id}/content?includeIDs=true` (text/html)
- resources: the absolute URL found in the page HTML. The client rewrites `https://graph.microsoft.com/v1.0` to `baseUrl` so the fake can serve them.

Every request sends `Authorization: Bearer <token>`.

- [ ] **Step 1: Failing tests** (`graph.test.ts`, using `startFakeGraph` with an instant `sleep`):
  - `listTree()` returns the nested notebooks → groups → sections with `name` from `displayName` and `lastModified`;
  - `listPages()` follows paging (the fake pages at 2 items when the section has more than 2 pages) and returns pages sorted by `order`;
  - `pageContent()` returns the page HTML;
  - `resource()` returns bytes plus the mime from `Content-Type`;
  - retry: after `failNext(429, 2, 1)` the call succeeds, and the injected `sleep` was called with `[1000, 1000]`;
  - after `failNext(503, 6)` the call rejects with a message containing `503`;
  - concurrency: with `maxConcurrent: 2`, 6 parallel `pageContent` calls never have more than 2 in flight (the fake tracks the peak);
  - the bearer token is sent (the fake rejects requests without `Bearer fake-token` with 401).

- [ ] **Step 2: Implement** `fakeGraph.ts`: a `node:http` server on port 0 that routes the paths above and builds `@odata.nextLink` with its own URL. Then `graph.ts`:
  - a small semaphore for `maxConcurrent` (default 2);
  - `request(url)` that retries 429/503 with `Retry-After` × 1000 or `2^attempt × 1000` up to `maxRetries` (default 5) and throws `Graph <status> <path>` otherwise for non-2xx;
  - `listTree()` built from the per-container calls, run sequentially, so the semaphore bounds load.

- [ ] **Step 3: Run** `npx vitest run packages/importer` — PASS.
- [ ] **Step 4: Commit** — `git commit -am "feat(importer): throttled, paging, retrying OneNote Graph client and a fake Graph server"`

---

### Task 4: The import engine

**Files:** Create `packages/importer/src/engine.ts`, `packages/importer/test/memorySink.ts`, `packages/importer/test/engine.test.ts`. Export `./engine`.

**Interfaces:**
- `selectionToPaths(tree: OneNoteNotebook[], selectedIds: Set<string>): SectionPath[]`. Selecting a notebook or a group selects every section under it; the result is in tree order with no duplicates.
- `runImport(opts: { graph: GraphSource; sink: ImportSink; state: ImportState; paths: SectionPath[]; onProgress: (p: ImportProgress) => void; signal?: AbortSignal; onlyFailed?: boolean }): Promise<ImportProgress>`

Behaviour:
- For each path:
  - `ensureNotebook`;
  - then `ensureGroup` down the group chain (parent tree ids passed along);
  - then `ensureSection`;
  - then `listPages`, in `order`.
- For each page:
  - **skip check:** if `state.get(id)` is `done` with an equal `lastModified`, count it as skipped (with `onlyFailed`, skip everything not `failed`);
  - **import:** otherwise fetch `pageContent` and `mapOneNotePage` it. For each image node (walk the blocks recursively), `graph.resource(src)` → `sink.putBlob` → replace `attrs.src`; cache by src within a page. Then `sink.writePage(...)` with `{ title: meta.title || mapped.title, level: meta.level }`, and record `done` with the new `lastModified`;
  - **lossy items:** when a page has any, add `{ title, items }` to `progress.lossy`;
  - **failure:** any error records `failed` with the message and pushes to `progress.failed`, and the import continues.
- `onProgress` runs after every page and section.
- When `signal` aborts, stop before the next page and return `phase: 'cancelled'`. A rerun resumes from the checkpoints.

- [ ] **Step 1: `memorySink.ts`.** An in-memory `ImportSink`:
  - it keeps `notebooks: Map<onenoteId, { id, name, groups: Map, sections: Map<onenoteId, { treeId, pages: Map<onenotePageId, { title, level, page: MappedPage }> }> }>`;
  - it returns stable ids (`nb-1`, `sg-1`, `s-1`…) so tests can assert idempotence;
  - `putBlob` returns `slate-blob://blob/<n>.png` and counts calls.

  Plus `memoryState()` over a `Map`.

- [ ] **Step 2: Failing tests** (`engine.test.ts`, with `startFakeGraph` and a real `GraphClient` using an instant sleep):
  - selecting one section imports its pages in order, with levels; boxes come from the mapping; image srcs are blob URLs;
  - selecting a notebook imports every section under it, including inside groups, and creates the group;
  - running again with nothing changed skips every page (`skipped` = page count, `writePage` not called again);
  - changing one page's `lastModified` and HTML in the fake re-imports only that page;
  - a page whose content returns 500 six times fails without stopping the rest; `onlyFailed: true` after `failNext` is cleared imports just that page;
  - aborting after the first page returns `cancelled`, and a rerun imports the remaining pages and skips the first;
  - `lossy` lists the attachment from `code-and-lossy.html`.

- [ ] **Step 3: Implement `engine.ts`.**
- [ ] **Step 4: Run** `npx vitest run packages/importer && npm run typecheck` — PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(importer): resumable, re-runnable OneNote import engine"`

---

### Task 5: Sign-in and the import service (desktop main)

**Files:**
- Create `packages/desktop/src/main/onenote/{auth.ts,importService.ts,importService.test.ts}`.
- Modify `packages/desktop/src/main/store.ts` (+ test), `src/shared/{api,ipc}.ts`, `src/preload/index.ts`, `src/main/ipc.ts`, `src/main/index.ts`, `src/main/settings.ts` (`msClientId`), and `packages/desktop/package.json` (`@azure/msal-node` in **dependencies**, because it must stay external for main; `@slate/importer` in devDependencies).

**Interfaces:**
- `DocStore`:
  - `getImportItem(id: string): ImportRecord | undefined`
  - `setImportItem(id: string, record: ImportRecord): void` (table `import_items(id TEXT PRIMARY KEY, last_modified TEXT, status TEXT, error TEXT)`)
  - `getMapping(onenoteId: string): string | undefined`
  - `setMapping(onenoteId: string, slateId: string): void` (table `import_map`)
- `interface AuthService { status(): Promise<{ configured: boolean; signedIn: boolean; account?: string }>; signIn(): Promise<void>; signOut(): Promise<void>; token(scopes: string[]): Promise<string> }`
- `createAuthService(opts: { clientId: string | null; cacheFile: string; openBrowser: (url: string) => Promise<void>; fake: boolean }): AuthService`
- `class ImportService { constructor(deps: { dbFile: string; blobs: BlobStore; auth: AuthService; graphUrl: string; emit: (p: ImportProgress) => void }); tree(): Promise<OneNoteNotebook[]>; start(selectedIds: string[]): Promise<ImportProgress>; retryFailed(): Promise<ImportProgress>; cancel(): void }`
- `SlateApi.onenote`:
  - `status()`, `signIn()`, `signOut()`, `tree()`, `start(ids: string[])`, `retryFailed()`, `cancel()`
  - `onProgress(handler: (p: ImportProgress) => void): () => void`
  - `setClientId(id: string): Promise<void>`

Sink over `DocStore` (`importService.ts`), using its **own** `DocStore` connection on the app's db file, so the external-update watcher pushes every write to the renderer:
- **`ensureNotebook`:**
  - if `import_map` has the id, return it;
  - else create a notebook with `newId()` and a `NotebookDoc` named after the OneNote notebook, save its snapshot as `notebook:<id>`, and map it.
- **`ensureGroup` / `ensureSection`:** load the notebook doc, find the mapped tree id or create the node with `addSectionGroup` / `addSection` (colours cycle through `SECTION_COLORS`), save the update (`export({ mode: 'update', from })`), and map it.
- **`writePage`:**
  - find a page node mapped to this OneNote page id, or `addPage(section, title)` and `setLevel`;
  - build a fresh `PageDoc` with one box per `MappedBox` (`addBox` + `writeContent` + commit);
  - for a re-import, `remove` the old `page:<pageId>` rows first, then append the new snapshot;
  - update the title and level in the tree if they changed.
- **`putBlob`:** `BlobStore.put`.

Auth:
- **MSAL path:** `PublicClientApplication` with `auth: { clientId, authority }` and a cache plugin that reads and writes `cacheFile` encrypted with `safeStorage.encryptString`/`decryptString` (plain JSON if `safeStorage.isEncryptionAvailable()` is false — log a warning).
- **`token(scopes)`:** `acquireTokenSilent` with the first cached account, falling back to `acquireTokenInteractive({ scopes, openBrowser, successTemplate: '<h1>Signed in to Slate. You can close this tab.</h1>' })`.
- **`signIn`:** interactive with `['Notes.Read', 'User.Read', 'offline_access']`.
- **`signOut`:** removes the accounts from the cache.
- **`configured`:** false when `clientId` is null.
- **Fake path** (`fake: true`): `configured: true`; `signIn` flips a flag; `token` returns `fake-token` (throws `not signed in` before `signIn`); account `test@example.com`.

In `main/index.ts`:
- `clientId = process.env.SLATE_MS_CLIENT_ID ?? readSettings(store).msClientId ?? null`;
- `fake = process.env.SLATE_E2E === '1' && process.env.SLATE_FAKE_AUTH === '1'`;
- `graphUrl = process.env.SLATE_GRAPH_URL ?? 'https://graph.microsoft.com/v1.0'`;
- `openBrowser = (url) => shell.openExternal(url)`;
- progress goes to every window on `onenote:progress`.

- [ ] **Step 1: Failing tests:**
  - `store.test.ts`: import_items and import_map round-trip;
  - `importService.test.ts` (runs under `test:main`): with `startFakeGraph` from `@slate/importer`'s test folder (import it by relative path) and fake auth, `start([sectionId])` writes a notebook doc and page docs readable through a second `DocStore`. The notebook tree has the section with the pages in order. A page's boxes match the mapping. `retryFailed()` imports a page that failed earlier. A second `start` is skipped entirely.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run** `npm run test:main && npm run typecheck && npm run e2e -- smoke.spec.ts` — PASS.
- [ ] **Step 4: Commit** — `git commit -am "feat(desktop): Microsoft sign-in and the OneNote import service"`

---

### Task 6: Import dialog and live import into the open app

**Files:**
- Create `packages/desktop/src/renderer/src/import/{ImportDialog.tsx,import.css}`, `packages/desktop/e2e/onenote-import.spec.ts`.
- Modify `src/renderer/src/{App.tsx,library.ts,main.tsx}`, `sidebar/NotebookPicker.tsx`, `src/main/menu.ts` (File → "Import from OneNote…", id `import-onenote`, sends `{ cmd: 'show-import' }`), and `src/shared/api.ts` (MenuCommand).

**Behaviour:**
- **`Library.importExternal(notebookId, updates)`:** for an unknown notebook id, call `window.slate.docs.load('notebook:' + id)` and attach the new notebook (the importer creates notebooks). The sidebar shows it straight away.
- **Opening the dialog:** from File → Import from OneNote… or the notebook menu's "Import from OneNote…". It's an in-app overlay (`data-testid="import-dialog"`) that closes on Escape or ✕ when not running.
- **Dialog states:**
  1. **Not configured** (`status().configured === false`): explains the Azure app registration in five short numbered steps (portal.azure.com → App registrations → New → "Accounts in any organizational directory and personal Microsoft accounts" → Redirect URI: Public client/native `http://localhost` → copy the Application (client) ID). A text field and "Save" call `onenote.setClientId`.
  2. **Signed out:** a "Sign in with Microsoft" button (`import-sign-in`).
  3. **Picker:**
     - the signed-in account and a "Sign out" link;
     - a tree with tri-state checkboxes (notebook → groups → sections; `role="tree"`, items `role="treeitem"` with `aria-checked`);
     - "Import N sections" (`import-start`), disabled at 0.
  4. **Running:** a progress bar, "Section X of Y · Page A of B", the current page title, and Cancel.
  5. **Report:**
     - imported, skipped and failed counts;
     - a list of failed pages with errors and "Retry failed" (`import-retry`);
     - a "Couldn't import exactly" list (`import-lossy`) of page title → items;
     - a "Done" button.
- The sidebar shows imported notebooks, sections and pages live while the import runs.

- [ ] **Step 1: Failing e2e** (`onenote-import.spec.ts`):
  - in `beforeAll`, start `startFakeGraph(…)` (import from `../../importer/test/fakeGraph`) with a notebook "Work", a group "Projects" holding section "TERN" (3 pages: "Releases" with two boxes at different positions and an image, "Hot fixes" level 1, "Old" with an attachment) and a section "AD" outside the group;
  - launch the app with `SLATE_GRAPH_URL=<fake url>` and `SLATE_FAKE_AUTH=1` (extend `launchApp` with an optional `env` argument);
  - steps:
    1. File → Import from OneNote… (`app.evaluate` on the menu item `import-onenote`);
    2. `import-sign-in`;
    3. check only "TERN";
    4. `import-start`;
    5. wait for the report;
    6. assert the counts (3 imported) and that the lossy list mentions `report.pdf`;
    7. Done;
  - then:
    - the notebook picker lists "Work", and selecting it shows the section "TERN" inside the group "Projects" with pages "Releases", "Hot fixes" (`data-level="1"`), "Old" in that order;
    - opening "Releases" shows 2 boxes, the left box above/left of the right one as in the source;
    - the image's `naturalWidth` > 0 (blob loaded);
    - reopening the dialog and importing "TERN" again reports 3 skipped.
- [ ] **Step 2: Implement** the dialog, menu, library change and wiring.
- [ ] **Step 3: Run** the full `npm run e2e` twice, plus `npm test`, `npm run test:main` and `npm run typecheck` — all PASS.
- [ ] **Step 4: Commit** — `git commit -am "feat(desktop): OneNote import dialog with live import into the sidebar"`

---

## Done criteria for Phase 3

- **Without a client id**, the dialog explains how to get one.
- **With one:** sign-in opens the system browser; the tree loads; the chosen sections import with positions, formatting, lists, tables, code, images, page order and levels.
- **Re-running** skips unchanged pages and updates changed ones. **Failures** are retryable. **Lossy items** are reported.
- All unit, main-process and e2e tests pass.
