# Slate Phase 1 — Local Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a fast, offline desktop notes app (Electron) with notebooks → section groups → sections → pages, free-positioned rich-text boxes that push boxes below them down as they grow, developer-clean copy/paste, a per-box private flag, and local SQLite persistence.

**Architecture:**
- **`@slate/core`** — pure TypeScript: the data model (Loro CRDT documents for notebook trees and pages), the auto-push layout maths, and the plain-text clipboard serializer.
- **`@slate/editor`** — React and TipTap: the canvas, the boxes, the Loro↔ProseMirror binding and the clipboard handling.
- **`@slate/desktop`** — the Electron shell. The main process owns SQLite and the image-blob files. The sandboxed renderer reaches them only through a typed preload API.

**Tech Stack:**
- Electron 45, electron-vite 6, React 19, TypeScript 7
- TipTap 3, with `loro-crdt` 1.16 and `loro-prosemirror` 0.4
- better-sqlite3 13
- Vitest 5 and happy-dom for unit tests; Playwright 1.64 (Electron mode) for end-to-end tests

Spec: `docs/superpowers/specs/2026-10-21-slate-design.md` (Phase 1 = §10 item 1).

## Global Constraints

- Repo root: `/Users/nuwan/projects/pet-projects/slate` (npm workspaces, `packages/*`). Node ≥ 22.
- **No auto-formatting by default:** lists, headings and code blocks are created only by an explicit command (shortcut or toolbar). TipTap input rules and paste rules are off unless the user turns on the "Markdown Shortcuts" setting. Auto-capitalisation, smart quotes, dash replacement, link auto-formatting and spell-check auto-replace are all off.
- **`text/plain` copy rules** (verbatim from spec):
  - Ordered lists use their real numbers (`start` + index). Nested lists are indented 2 spaces per level. Bullets are `- `.
  - Code blocks are copied verbatim. Tables are tab-separated.
  - LF line endings; NBSP → space; no zero-width characters; no trailing control characters.
  - Additionally: trailing newlines are trimmed from the whole copy, so pasting into a terminal never auto-runs a command.
- **`text/html` copy:** clean semantic HTML with no inline styles except colour.
- **Default paste:** keep structure (lists, headings, tables, code, bold, italic, links). Drop font family, size, colour, background and all other inline styles. Cmd/Ctrl+Shift+V pastes as plain text.
- **Performance budget:** under 16 ms per keystroke and under 100 ms to open a page (local read only).
- **Renderer security:** `contextIsolation: true`, `sandbox: true`. The renderer never touches the disk or network directly; everything goes through `window.slate`.
- **Commits:** commit at the end of every task. Commit messages must **not** contain any AI attribution (no `Co-Authored-By: Claude…`, no "Generated with Claude Code"). Never push, tag or release.
- **E2E windows:** e2e launches set `SLATE_E2E=1`, which keeps the window hidden (`show: false`) so test runs don't pop windows onto the user's screen.
- **Platform:** use `Mod` (Cmd on macOS, Ctrl elsewhere) for every shortcut.

---

## File Structure

```
slate/
  package.json                 workspaces, root scripts
  tsconfig.json                one typecheck config for all packages
  vitest.config.ts             runs packages/core + packages/editor unit tests
  .gitignore  README.md
  packages/core/
    package.json  vitest.config.ts
    src/index.ts               public exports
    src/ids.ts                 newId()
    src/layout.ts              computePush() — auto-push maths
    src/plaintext.ts           toPlainText() — developer-clean clipboard text
    src/page.ts                PageDoc — boxes in a Loro doc
    src/tree.ts                NotebookDoc — notebook tree in a Loro doc
    test/*.test.ts
  packages/editor/
    package.json  vitest.config.ts
    src/index.ts
    src/extensions.ts          buildExtensions(), schema
    src/clipboard.ts           cleanPastedHtml, stripCopiedStyles, makeClipboardSerializer, serializeSliceAsText
    src/content.ts             writeContent() — write PM JSON straight into a Loro content map
    src/staticRender.ts        renderStaticHtml() — off-screen box rendering
    src/loroBinding.ts         TipTap extension wrapping LoroSyncPlugin
    src/PageSession.ts         one open page: doc, undo, persistence, auto-push
    src/activeEditor.ts        last-focused editor store (for the toolbar/menu)
    src/services.ts            EditorServices context (blobs, clipboard, settings)
    src/keymap.ts              SlateKeymap — undo/redo/plain paste
    src/images.ts              image paste/copy helpers
    src/Canvas.tsx  src/Box.tsx  src/BoxEditor.tsx  src/StaticBox.tsx
    src/canvas.css
    test/*.test.ts
  packages/desktop/
    package.json  electron.vite.config.ts  vitest.main.config.ts  playwright.config.ts
    src/shared/api.ts          SlateApi, Settings, MenuCommand types
    src/shared/ipc.ts          IPC channel names
    src/main/index.ts          app/window bootstrap, blob protocol
    src/main/store.ts          DocStore (SQLite, WAL, compaction)
    src/main/blobs.ts          BlobStore (content-addressed image files)
    src/main/settings.ts       read/write Settings via DocStore
    src/main/ipc.ts            ipcMain handlers
    src/main/menu.ts           application menu
    src/main/*.test.ts         run under Electron's Node (native ABI)
    src/preload/index.ts       contextBridge → window.slate
    src/renderer/index.html
    src/renderer/src/main.tsx  App.tsx  env.d.ts  library.ts  currentSession.ts
    src/renderer/src/selection.ts  treeUtils.ts  PageView.tsx  Toolbar.tsx  testHooks.ts
    src/renderer/src/sidebar/  NotebookPicker.tsx SectionList.tsx PageList.tsx ContextMenu.tsx InlineRename.tsx dnd.ts
    src/renderer/src/app.css  sidebar.css  toolbar.css
    e2e/fixtures.ts  e2e/*.spec.ts
```

---

### Task 1: Monorepo scaffold and auto-push layout maths

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `README.md`
- Create: `packages/core/package.json`, `packages/core/vitest.config.ts`, `packages/core/src/index.ts`, `packages/core/src/ids.ts`, `packages/core/src/layout.ts`
- Test: `packages/core/test/layout.test.ts`

**Interfaces:**
- Produces: `newId(): string`; `interface BoxRect { id: string; x: number; y: number; width: number; height: number }`; `computePush(boxes: BoxRect[], grownId: string, oldHeight: number, newHeight: number): Map<string, number>` (box id → new y).

- [ ] **Step 1: Create the root workspace files**

`package.json`:
```json
{
  "name": "slate",
  "version": "0.1.0",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^7.0.2",
    "vitest": "^5.0.5"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "types": ["node"],
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["packages/*/src", "packages/*/test", "packages/*/e2e", "packages/*/*.config.ts"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

// Picks up packages/*/vitest.config.ts (core, editor). Desktop main-process tests use
// vitest.main.config.ts instead: they need Electron's Node ABI and run via `npm run test:main`.
export default defineConfig({ test: { projects: ['packages/*/vitest.config.ts'] } })
```

`.gitignore`:
```
node_modules/
out/
dist/
test-results/
playwright-report/
*.log
.DS_Store
```

`README.md`:
````markdown
# Slate

Fast, developer-friendly free-form notes. See `docs/superpowers/specs/2026-10-21-slate-design.md`.

```bash
npm install        # also rebuilds better-sqlite3 for Electron
npm run dev        # run the app with hot reload
npm test           # unit tests (core + editor)
npm run test:main  # main-process tests (SQLite, blobs) under Electron's Node
npm run e2e        # build + Playwright end-to-end tests
npm run typecheck
```
````

- [ ] **Step 2: Create the core package shell**

`packages/core/package.json`:
```json
{
  "name": "@slate/core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": "./src/index.ts",
  "dependencies": {
    "loro-crdt": "^1.16.4"
  }
}
```

`packages/core/vitest.config.ts`:
```ts
import { defineProject } from 'vitest/config'

export default defineProject({ test: { name: 'core', environment: 'node', include: ['test/**/*.test.ts'] } })
```

`packages/core/src/ids.ts`:
```ts
export function newId(): string {
  return crypto.randomUUID()
}
```

`packages/core/src/index.ts`:
```ts
export * from './ids'
export * from './layout'
```

- [ ] **Step 3: Write the failing layout tests**

`packages/core/test/layout.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { computePush, type BoxRect } from '../src/layout'

const box = (id: string, x: number, y: number, width: number, height: number): BoxRect => ({ id, x, y, width, height })

describe('computePush', () => {
  it('moves nothing when the box shrinks or keeps its height', () => {
    const boxes = [box('a', 0, 0, 200, 100), box('b', 0, 120, 200, 50)]
    expect(computePush(boxes, 'a', 100, 80).size).toBe(0)
    expect(computePush(boxes, 'a', 100, 100).size).toBe(0)
  })

  it('pushes a horizontally overlapping box below by the growth delta', () => {
    const boxes = [box('a', 0, 0, 200, 100), box('b', 100, 120, 200, 50)]
    expect(computePush(boxes, 'a', 100, 150)).toEqual(new Map([['b', 170]]))
  })

  it('ignores boxes below that do not overlap horizontally', () => {
    const boxes = [box('a', 0, 0, 200, 100), box('b', 250, 120, 200, 50)]
    expect(computePush(boxes, 'a', 100, 150).size).toBe(0)
  })

  it('ignores boxes above or beside the growing box', () => {
    const boxes = [box('a', 0, 100, 200, 100), box('above', 0, 0, 200, 50), box('beside', 0, 150, 200, 50)]
    expect(computePush(boxes, 'a', 100, 150).size).toBe(0)
  })

  it('cascades through boxes that are pushed', () => {
    // c does not overlap a horizontally, but it sits under b, which a pushes.
    const boxes = [box('a', 0, 0, 200, 100), box('b', 150, 120, 200, 50), box('c', 300, 200, 200, 50)]
    expect(computePush(boxes, 'a', 100, 140)).toEqual(new Map([['b', 160], ['c', 240]]))
  })

  it('moves each box at most once', () => {
    const boxes = [box('a', 0, 0, 400, 100), box('b', 0, 120, 200, 50), box('c', 0, 200, 400, 50)]
    expect(computePush(boxes, 'a', 100, 130)).toEqual(new Map([['b', 150], ['c', 230]]))
  })

  it('returns nothing for an unknown box id', () => {
    expect(computePush([box('a', 0, 0, 10, 10)], 'zzz', 10, 20).size).toBe(0)
  })
})
```

- [ ] **Step 4: Install and run the tests to see them fail**

Run: `npm install && npx vitest run packages/core`
Expected: FAIL — `Failed to resolve import "../src/layout"`.

- [ ] **Step 5: Implement `computePush`**

`packages/core/src/layout.ts`:
```ts
export interface BoxRect {
  id: string
  x: number
  y: number
  width: number
  height: number
}

function overlapsX(a: BoxRect, b: BoxRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width
}

/**
 * When box `grownId` grows from `oldHeight` to `newHeight`, every box that sits at or below
 * its old bottom edge and overlaps it horizontally moves down by the growth delta. Pushed
 * boxes push the boxes under them in turn. Shrinking never pulls boxes up.
 * Returns the new y for every moved box.
 */
export function computePush(boxes: BoxRect[], grownId: string, oldHeight: number, newHeight: number): Map<string, number> {
  const moved = new Map<string, number>()
  const delta = newHeight - oldHeight
  const grown = boxes.find((b) => b.id === grownId)
  if (delta <= 0 || !grown) return moved

  const queue: Array<{ rect: BoxRect; bottom: number }> = [{ rect: grown, bottom: grown.y + oldHeight }]
  while (queue.length > 0) {
    const pusher = queue.shift()!
    for (const b of boxes) {
      if (b.id === grownId || moved.has(b.id)) continue
      if (b.y >= pusher.bottom && overlapsX(pusher.rect, b)) {
        moved.set(b.id, b.y + delta)
        queue.push({ rect: b, bottom: b.y + b.height })
      }
    }
  }
  return moved
}
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `npx vitest run packages/core && npm run typecheck`
Expected: 7 tests PASS; typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(core): monorepo scaffold and auto-push layout maths"
```

---

### Task 2: Developer-clean plain-text serializer

**Files:**
- Create: `packages/core/src/plaintext.ts`
- Modify: `packages/core/src/index.ts` (add export)
- Test: `packages/core/test/plaintext.test.ts`

**Interfaces:**
- Produces: `interface PMJSON { type: string; attrs?: Record<string, unknown>; content?: PMJSON[]; text?: string; marks?: Array<{ type: string; attrs?: Record<string, unknown> }> }`; `toPlainText(nodes: PMJSON[]): string`. Node type names follow TipTap: `doc, paragraph, heading, text, hardBreak, bulletList, orderedList, listItem, codeBlock, blockquote, horizontalRule, table, tableRow, tableCell, tableHeader, image`.

- [ ] **Step 1: Write the failing tests**

`packages/core/test/plaintext.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { toPlainText, type PMJSON } from '../src/plaintext'

const t = (text: string): PMJSON => ({ type: 'text', text })
const p = (text: string): PMJSON => ({ type: 'paragraph', content: text ? [t(text)] : [] })
const li = (...content: PMJSON[]): PMJSON => ({ type: 'listItem', content })
const ol = (items: PMJSON[], start = 1): PMJSON => ({ type: 'orderedList', attrs: { start }, content: items })
const ul = (items: PMJSON[]): PMJSON => ({ type: 'bulletList', content: items })

describe('toPlainText', () => {
  it('joins blocks with a single LF', () => {
    expect(toPlainText([p('one'), { type: 'heading', attrs: { level: 1 }, content: [t('two')] }])).toBe('one\ntwo')
  })

  it('numbers ordered lists with real numbers and indents nested lists by 2 spaces', () => {
    const doc = [ol([li(p('one')), li(p('two'), ul([li(p('a')), li(p('b'))])), li(p('three'))])]
    expect(toPlainText(doc)).toBe('1. one\n2. two\n  - a\n  - b\n3. three')
  })

  it('honours the ordered list start attribute', () => {
    expect(toPlainText([ol([li(p('x')), li(p('y'))], 5)])).toBe('5. x\n6. y')
  })

  it('numbers nested ordered lists independently', () => {
    expect(toPlainText([ol([li(p('a'), ol([li(p('b')), li(p('c'))]))])])).toBe('1. a\n  1. b\n  2. c')
  })

  it('copies code blocks verbatim, only normalising CRLF', () => {
    const code: PMJSON = { type: 'codeBlock', attrs: { language: 'js' }, content: [t('if (a) {\r\n    b()\r\n}')] }
    expect(toPlainText([code])).toBe('if (a) {\n    b()\n}')
  })

  it('replaces NBSP and strips zero-width characters in text', () => {
    expect(toPlainText([p('a b​c﻿d⁠')])).toBe('a bcd')
  })

  it('turns hard breaks into LF and normalises CRLF', () => {
    expect(toPlainText([{ type: 'paragraph', content: [t('a\r\nb'), { type: 'hardBreak' }, t('c')] }])).toBe('a\nb\nc')
  })

  it('tab-separates table cells, one row per line', () => {
    const cell = (s: string): PMJSON => ({ type: 'tableCell', content: [p(s)] })
    const table: PMJSON = { type: 'table', content: [{ type: 'tableRow', content: [cell('a'), cell('b')] }, { type: 'tableRow', content: [cell('c'), cell('d')] }] }
    expect(toPlainText([table])).toBe('a\tb\nc\td')
  })

  it('prefixes blockquote lines and renders horizontal rules', () => {
    expect(toPlainText([{ type: 'blockquote', content: [p('q1'), p('q2')] }, { type: 'horizontalRule' }])).toBe('> q1\n> q2\n---')
  })

  it('handles bare inline nodes from partial selections', () => {
    expect(toPlainText([t('hi '), t('there')])).toBe('hi there')
  })

  it('trims trailing newlines so a terminal paste never auto-runs', () => {
    expect(toPlainText([p('ls -la'), p(''), p('')])).toBe('ls -la')
  })

  it('skips images', () => {
    expect(toPlainText([p('a'), { type: 'image', attrs: { src: 'slate-blob://blob/x.png' } }, p('b')])).toBe('a\nb')
  })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run packages/core/test/plaintext.test.ts`
Expected: FAIL — `Failed to resolve import "../src/plaintext"`.

- [ ] **Step 3: Implement the serializer**

`packages/core/src/plaintext.ts`:
```ts
/** ProseMirror JSON as produced by `Node.toJSON()` / `Fragment.toJSON()`. */
export interface PMJSON {
  type: string
  attrs?: Record<string, unknown>
  content?: PMJSON[]
  text?: string
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>
}

const ZERO_WIDTH = /[​-‍⁠﻿]/g
const INDENT = '  '

function cleanText(s: string): string {
  return s.replace(/ /g, ' ').replace(ZERO_WIDTH, '').replace(/\r\n?/g, '\n')
}

function inlineText(nodes: PMJSON[] = []): string {
  return nodes
    .map((n) => (n.type === 'text' ? cleanText(n.text ?? '') : n.type === 'hardBreak' ? '\n' : inlineText(n.content)))
    .join('')
}

function prefixLines(text: string, indent: string): string[] {
  return text.split('\n').map((line) => indent + line)
}

function listLines(list: PMJSON, indent: string, marker: (i: number) => string): string[] {
  const out: string[] = []
  ;(list.content ?? []).forEach((item, i) => {
    const children = item.content ?? []
    const [first, ...rest] = children
    if (first && (first.type === 'paragraph' || first.type === 'heading')) {
      const [line0, ...more] = inlineText(first.content).split('\n')
      out.push(indent + marker(i) + line0)
      for (const line of more) out.push(indent + INDENT + line)
      out.push(...blocksToLines(rest, indent + INDENT))
    } else {
      out.push(indent + marker(i).trimEnd())
      out.push(...blocksToLines(children, indent + INDENT))
    }
  })
  return out
}

function blockLines(node: PMJSON, indent: string): string[] {
  switch (node.type) {
    case 'paragraph':
    case 'heading':
      return prefixLines(inlineText(node.content), indent)
    case 'codeBlock':
      return prefixLines((node.content ?? []).map((n) => (n.text ?? '').replace(/\r\n?/g, '\n')).join(''), indent)
    case 'bulletList':
      return listLines(node, indent, () => '- ')
    case 'orderedList': {
      const start = typeof node.attrs?.start === 'number' ? node.attrs.start : 1
      return listLines(node, indent, (i) => `${start + i}. `)
    }
    case 'blockquote':
      return blocksToLines(node.content ?? [], indent + '> ')
    case 'horizontalRule':
      return [indent + '---']
    case 'table':
      return (node.content ?? []).map(
        (row) => indent + (row.content ?? []).map((cell) => blocksToLines(cell.content ?? [], '').join(' ')).join('\t'),
      )
    case 'image':
      return []
    default:
      return blocksToLines(node.content ?? [], indent)
  }
}

function blocksToLines(nodes: PMJSON[], indent: string): string[] {
  const out: string[] = []
  let inline: PMJSON[] = []
  const flush = () => {
    if (inline.length > 0) out.push(...prefixLines(inlineText(inline), indent))
    inline = []
  }
  for (const n of nodes) {
    if (n.type === 'text' || n.type === 'hardBreak') inline.push(n)
    else {
      flush()
      out.push(...blockLines(n, indent))
    }
  }
  flush()
  return out
}

/** Plain text for the clipboard: real list numbers, verbatim code, LF only, no invisible characters. */
export function toPlainText(nodes: PMJSON[]): string {
  return blocksToLines(nodes, '').join('\n').replace(/\n+$/, '')
}
```

Append to `packages/core/src/index.ts`:
```ts
export * from './plaintext'
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run packages/core`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): developer-clean plain-text serializer"
```

---

### Task 3: PageDoc — boxes in a Loro document

**Files:**
- Create: `packages/core/src/page.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/page.test.ts`

**Interfaces:**
- Consumes: `newId()` (Task 1).
- Produces:
  ```ts
  interface BoxState { id: string; x: number; y: number; width: number; private: boolean; contentId: ContainerID }
  type BoxPatch = Partial<Pick<BoxState, 'x' | 'y' | 'width' | 'private'>>
  class PageDoc {
    readonly doc: LoroDoc
    constructor(doc?: LoroDoc)
    static fromUpdates(updates: Uint8Array[]): PageDoc
    addBox(init: { x: number; y: number; width: number }): string
    getBox(id: string): BoxState | undefined
    listBoxes(): BoxState[]            // sorted by id
    updateBox(id: string, patch: BoxPatch): void
    moveBoxes(ys: Map<string, number>): void   // one commit
    deleteBox(id: string): void
    contentMap(id: string): LoroMap | undefined
  }
  ```
  Layout of the page doc: root map `boxes` → `boxId` → LoroMap `{ x, y, width, private, content: LoroMap }`. `content` is owned by loro-prosemirror (Task 8).

- [ ] **Step 1: Write the failing tests**

`packages/core/test/page.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { LoroDoc } from 'loro-crdt'
import { PageDoc } from '../src/page'

function recordUpdates(doc: LoroDoc): Uint8Array[] {
  const updates: Uint8Array[] = []
  doc.subscribeLocalUpdates((u) => updates.push(u))
  return updates
}

describe('PageDoc', () => {
  it('adds a box with position, width, private=false and a content container', () => {
    const page = new PageDoc()
    const id = page.addBox({ x: 10, y: 20, width: 300 })
    const box = page.getBox(id)!
    expect(box).toMatchObject({ id, x: 10, y: 20, width: 300, private: false })
    expect(typeof box.contentId).toBe('string')
    expect(page.contentMap(id)?.id).toBe(box.contentId)
  })

  it('patches box fields', () => {
    const page = new PageDoc()
    const id = page.addBox({ x: 0, y: 0, width: 100 })
    page.updateBox(id, { x: 5, width: 250, private: true })
    expect(page.getBox(id)).toMatchObject({ x: 5, y: 0, width: 250, private: true })
  })

  it('moves several boxes in one commit', () => {
    const page = new PageDoc()
    const a = page.addBox({ x: 0, y: 0, width: 100 })
    const b = page.addBox({ x: 0, y: 50, width: 100 })
    const updates = recordUpdates(page.doc)
    page.moveBoxes(new Map([[a, 10], [b, 60]]))
    expect(page.getBox(a)!.y).toBe(10)
    expect(page.getBox(b)!.y).toBe(60)
    expect(updates).toHaveLength(1)
  })

  it('deletes boxes', () => {
    const page = new PageDoc()
    const id = page.addBox({ x: 0, y: 0, width: 100 })
    page.deleteBox(id)
    expect(page.listBoxes()).toEqual([])
  })

  it('round-trips through exported updates', () => {
    const page = new PageDoc()
    const updates = recordUpdates(page.doc)
    const id = page.addBox({ x: 1, y: 2, width: 3 })
    page.updateBox(id, { private: true })
    const restored = PageDoc.fromUpdates(updates)
    expect(restored.listBoxes()).toEqual(page.listBoxes())
  })

  it('merges concurrent moves of different boxes', () => {
    const one = new PageDoc()
    const a = one.addBox({ x: 0, y: 0, width: 100 })
    const b = one.addBox({ x: 0, y: 100, width: 100 })
    const two = PageDoc.fromUpdates([one.doc.export({ mode: 'snapshot' })])
    one.updateBox(a, { x: 50 })
    two.updateBox(b, { y: 300 })
    one.doc.import(two.doc.export({ mode: 'update', from: one.doc.oplogVersion() }))
    two.doc.import(one.doc.export({ mode: 'update', from: two.doc.oplogVersion() }))
    expect(one.listBoxes()).toEqual(two.listBoxes())
    expect(one.getBox(a)!.x).toBe(50)
    expect(one.getBox(b)!.y).toBe(300)
  })
})
```

Note: `subscribeLocalUpdates` fires synchronously on `commit()` in loro-crdt 1.x. If the update-count assertion sees 0, add `await Promise.resolve()` before asserting and make the test `async`.

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run packages/core/test/page.test.ts`
Expected: FAIL — cannot resolve `../src/page`.

- [ ] **Step 3: Implement PageDoc**

`packages/core/src/page.ts`:
```ts
import { LoroDoc, LoroMap, type ContainerID } from 'loro-crdt'
import { newId } from './ids'

export interface BoxState {
  id: string
  x: number
  y: number
  width: number
  private: boolean
  /** Loro container that loro-prosemirror binds this box's editor to. */
  contentId: ContainerID
}

export type BoxPatch = Partial<Pick<BoxState, 'x' | 'y' | 'width' | 'private'>>

function toState(id: string, m: LoroMap): BoxState {
  return {
    id,
    x: Number(m.get('x') ?? 0),
    y: Number(m.get('y') ?? 0),
    width: Number(m.get('width') ?? 0),
    private: m.get('private') === true,
    contentId: (m.get('content') as LoroMap).id,
  }
}

export class PageDoc {
  readonly doc: LoroDoc

  constructor(doc: LoroDoc = new LoroDoc()) {
    this.doc = doc
  }

  static fromUpdates(updates: Uint8Array[]): PageDoc {
    const doc = new LoroDoc()
    if (updates.length > 0) doc.importBatch(updates)
    return new PageDoc(doc)
  }

  private get boxes(): LoroMap {
    return this.doc.getMap('boxes')
  }

  private boxMap(id: string): LoroMap | undefined {
    const value = this.boxes.get(id)
    return value instanceof LoroMap ? value : undefined
  }

  addBox(init: { x: number; y: number; width: number }): string {
    const id = newId()
    const box = this.boxes.setContainer(id, new LoroMap())
    box.set('x', init.x)
    box.set('y', init.y)
    box.set('width', init.width)
    box.set('private', false)
    box.setContainer('content', new LoroMap())
    this.doc.commit()
    return id
  }

  getBox(id: string): BoxState | undefined {
    const m = this.boxMap(id)
    return m ? toState(id, m) : undefined
  }

  listBoxes(): BoxState[] {
    return this.boxes
      .keys()
      .sort()
      .flatMap((id) => {
        const m = this.boxMap(id)
        return m ? [toState(id, m)] : []
      })
  }

  contentMap(id: string): LoroMap | undefined {
    const content = this.boxMap(id)?.get('content')
    return content instanceof LoroMap ? content : undefined
  }

  updateBox(id: string, patch: BoxPatch): void {
    const m = this.boxMap(id)
    if (!m) return
    for (const [key, value] of Object.entries(patch)) if (value !== undefined) m.set(key, value)
    this.doc.commit()
  }

  moveBoxes(ys: Map<string, number>): void {
    for (const [id, y] of ys) this.boxMap(id)?.set('y', y)
    this.doc.commit()
  }

  deleteBox(id: string): void {
    this.boxes.delete(id)
    this.doc.commit()
  }
}
```

Append to `packages/core/src/index.ts`:
```ts
export * from './page'
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run packages/core && npm run typecheck`
Expected: all PASS; typecheck 0.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): PageDoc with boxes stored in a Loro document"
```

---

### Task 4: NotebookDoc — the notebook tree

**Files:**
- Create: `packages/core/src/tree.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/tree.test.ts`

**Interfaces:**
- Consumes: `newId()`.
- Produces:
  ```ts
  type NodeKind = 'sectionGroup' | 'section' | 'page'
  interface TreeItem { id: TreeID; kind: NodeKind; title: string; color: string | null; level: number; pageId: string | null; children: TreeItem[] }
  const SECTION_COLORS: readonly string[]
  class NotebookDoc {
    readonly doc: LoroDoc
    constructor(doc?: LoroDoc)
    static create(name: string): NotebookDoc
    static fromUpdates(updates: Uint8Array[]): NotebookDoc
    get name(): string
    rename(name: string): void
    items(): TreeItem[]
    get(id: TreeID): TreeItem | undefined
    addSectionGroup(title: string, parent?: TreeID): TreeID
    addSection(title: string, parent?: TreeID, color?: string): TreeID
    addPage(sectionId: TreeID, title?: string): { id: TreeID; pageId: string }
    setTitle(id: TreeID, title: string): void
    setColor(id: TreeID, color: string): void
    setLevel(id: TreeID, level: number): void      // clamped 0..2
    moveBefore(id: TreeID, targetId: TreeID): void
    moveAfter(id: TreeID, targetId: TreeID): void
    moveInto(id: TreeID, parentId?: TreeID): void  // appends as last child; undefined = root
    delete(id: TreeID): string[]                   // returns removed pageIds
    pageIdsUnder(id: TreeID): string[]
    allPageIds(): string[]
  }
  ```
  Placement rules: a page's parent must be a section. A section's or section group's parent must be the root or a section group. Any other placement throws an `Error`.

- [ ] **Step 1: Write the failing tests**

`packages/core/test/tree.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { LoroDoc } from 'loro-crdt'
import { NotebookDoc, SECTION_COLORS } from '../src/tree'

const titles = (nb: NotebookDoc) => nb.items().map((i) => i.title)

describe('NotebookDoc', () => {
  it('stores the notebook name', () => {
    const nb = NotebookDoc.create('Work')
    expect(nb.name).toBe('Work')
    nb.rename('Personal')
    expect(nb.name).toBe('Personal')
  })

  it('builds groups, sections and pages in order', () => {
    const nb = NotebookDoc.create('N')
    const group = nb.addSectionGroup('Projects')
    const s1 = nb.addSection('TERN')
    const s2 = nb.addSection('AdNav', group)
    const { pageId } = nb.addPage(s1, 'Releases')
    nb.addPage(s1, 'Hot fixes')
    const items = nb.items()
    expect(items.map((i) => [i.kind, i.title])).toEqual([['sectionGroup', 'Projects'], ['section', 'TERN']])
    expect(items[0].children.map((c) => c.id)).toEqual([s2])
    expect(items[1].color).toBe(SECTION_COLORS[0])
    expect(items[1].children.map((c) => [c.title, c.level])).toEqual([['Releases', 0], ['Hot fixes', 0]])
    expect(items[1].children[0].pageId).toBe(pageId)
  })

  it('rejects invalid placements', () => {
    const nb = NotebookDoc.create('N')
    const group = nb.addSectionGroup('G')
    const section = nb.addSection('S')
    const { id: page } = nb.addPage(section)
    expect(() => nb.addPage(group)).toThrow()
    expect(() => nb.addSection('x', section)).toThrow()
    expect(() => nb.moveInto(page, undefined)).toThrow()
    expect(() => nb.moveBefore(section, page)).toThrow()
  })

  it('reorders siblings with moveBefore and moveAfter', () => {
    const nb = NotebookDoc.create('N')
    const a = nb.addSection('A')
    nb.addSection('B')
    const c = nb.addSection('C')
    nb.moveBefore(c, a)
    expect(titles(nb)).toEqual(['C', 'A', 'B'])
    nb.moveAfter(c, nb.items()[2].id)
    expect(titles(nb)).toEqual(['A', 'B', 'C'])
  })

  it('moves sections into groups and pages between sections', () => {
    const nb = NotebookDoc.create('N')
    const group = nb.addSectionGroup('G')
    const s1 = nb.addSection('S1')
    const s2 = nb.addSection('S2')
    const { id: page } = nb.addPage(s1, 'P')
    nb.moveInto(s1, group)
    nb.moveInto(page, s2)
    expect(nb.get(group)!.children.map((c) => c.id)).toEqual([s1])
    expect(nb.get(s2)!.children.map((c) => c.id)).toEqual([page])
  })

  it('updates title, colour and clamps level', () => {
    const nb = NotebookDoc.create('N')
    const s = nb.addSection('S')
    const { id } = nb.addPage(s)
    nb.setTitle(id, 'Renamed')
    nb.setColor(s, '#123456')
    nb.setLevel(id, 7)
    expect(nb.get(id)).toMatchObject({ title: 'Renamed', level: 2 })
    expect(nb.get(s)!.color).toBe('#123456')
    nb.setLevel(id, -3)
    expect(nb.get(id)!.level).toBe(0)
  })

  it('deletes a subtree and returns its page ids', () => {
    const nb = NotebookDoc.create('N')
    const group = nb.addSectionGroup('G')
    const s = nb.addSection('S', group)
    const p1 = nb.addPage(s).pageId
    const p2 = nb.addPage(s).pageId
    expect(nb.allPageIds().sort()).toEqual([p1, p2].sort())
    expect(nb.delete(group).sort()).toEqual([p1, p2].sort())
    expect(nb.items()).toEqual([])
    expect(nb.get(s)).toBeUndefined()
  })

  it('round-trips through updates and converges across peers', () => {
    const one = NotebookDoc.create('N')
    const s = one.addSection('S')
    const two = NotebookDoc.fromUpdates([one.doc.export({ mode: 'snapshot' })])
    one.addPage(s, 'from one')
    two.addPage(s, 'from two')
    one.doc.import(two.doc.export({ mode: 'update', from: one.doc.oplogVersion() }))
    two.doc.import(one.doc.export({ mode: 'update', from: two.doc.oplogVersion() }))
    expect(one.items()).toEqual(two.items())
    expect(one.get(s)!.children).toHaveLength(2)
    expect(new NotebookDoc(new LoroDoc()).items()).toEqual([])
  })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run packages/core/test/tree.test.ts`
Expected: FAIL — cannot resolve `../src/tree`.

- [ ] **Step 3: Implement NotebookDoc**

`packages/core/src/tree.ts`:
```ts
import { LoroDoc, type LoroTreeNode, type TreeID } from 'loro-crdt'
import { newId } from './ids'

export type NodeKind = 'sectionGroup' | 'section' | 'page'

export interface TreeItem {
  id: TreeID
  kind: NodeKind
  title: string
  color: string | null
  /** Page indent level (0–2), like OneNote subpages. Always 0 for sections and groups. */
  level: number
  /** Id of the page's own Loro document. Null for sections and groups. */
  pageId: string | null
  children: TreeItem[]
}

export const SECTION_COLORS: readonly string[] = ['#2e9e5b', '#e45b5b', '#18a3c8', '#1f7ae0', '#e83e8c', '#f07d1a', '#f2c12e', '#8e6bd8']

const ALLOWED_PARENTS: Record<NodeKind, ReadonlyArray<NodeKind | 'root'>> = {
  sectionGroup: ['root', 'sectionGroup'],
  section: ['root', 'sectionGroup'],
  page: ['section'],
}

function toItem(n: LoroTreeNode): TreeItem {
  const d = n.data
  return {
    id: n.id,
    kind: d.get('kind') as NodeKind,
    title: String(d.get('title') ?? ''),
    color: (d.get('color') as string | undefined) ?? null,
    level: Number(d.get('level') ?? 0),
    pageId: (d.get('pageId') as string | undefined) ?? null,
    children: (n.children() ?? []).map(toItem),
  }
}

function collectPageIds(item: TreeItem): string[] {
  return [...(item.pageId ? [item.pageId] : []), ...item.children.flatMap(collectPageIds)]
}

export class NotebookDoc {
  readonly doc: LoroDoc

  constructor(doc: LoroDoc = new LoroDoc()) {
    this.doc = doc
    this.tree.enableFractionalIndex(0)
  }

  static create(name: string): NotebookDoc {
    const nb = new NotebookDoc()
    nb.rename(name)
    return nb
  }

  static fromUpdates(updates: Uint8Array[]): NotebookDoc {
    const doc = new LoroDoc()
    if (updates.length > 0) doc.importBatch(updates)
    return new NotebookDoc(doc)
  }

  private get tree() {
    return this.doc.getTree('tree')
  }

  get name(): string {
    return (this.doc.getMap('meta').get('name') as string | undefined) ?? 'Untitled notebook'
  }

  rename(name: string): void {
    this.doc.getMap('meta').set('name', name)
    this.doc.commit()
  }

  items(): TreeItem[] {
    return this.tree.roots().map(toItem)
  }

  get(id: TreeID): TreeItem | undefined {
    const n = this.node(id)
    return n ? toItem(n) : undefined
  }

  addSectionGroup(title: string, parent?: TreeID): TreeID {
    return this.create('sectionGroup', parent, { title })
  }

  addSection(title: string, parent?: TreeID, color: string = SECTION_COLORS[0]): TreeID {
    return this.create('section', parent, { title, color })
  }

  addPage(sectionId: TreeID, title = 'Untitled page'): { id: TreeID; pageId: string } {
    const pageId = newId()
    return { id: this.create('page', sectionId, { title, pageId, level: 0 }), pageId }
  }

  setTitle(id: TreeID, title: string): void {
    this.setData(id, 'title', title)
  }

  setColor(id: TreeID, color: string): void {
    this.setData(id, 'color', color)
  }

  setLevel(id: TreeID, level: number): void {
    this.setData(id, 'level', Math.max(0, Math.min(2, Math.round(level))))
  }

  moveBefore(id: TreeID, targetId: TreeID): void {
    const target = this.requireNode(targetId)
    this.assertPlacement(this.kindOf(id), target.parent()?.id)
    this.requireNode(id).moveBefore(target)
    this.doc.commit()
  }

  moveAfter(id: TreeID, targetId: TreeID): void {
    const target = this.requireNode(targetId)
    this.assertPlacement(this.kindOf(id), target.parent()?.id)
    this.requireNode(id).moveAfter(target)
    this.doc.commit()
  }

  moveInto(id: TreeID, parentId?: TreeID): void {
    this.assertPlacement(this.kindOf(id), parentId)
    this.tree.move(id, parentId)
    this.doc.commit()
  }

  delete(id: TreeID): string[] {
    const pageIds = this.pageIdsUnder(id)
    this.tree.delete(id)
    this.doc.commit()
    return pageIds
  }

  pageIdsUnder(id: TreeID): string[] {
    const item = this.get(id)
    return item ? collectPageIds(item) : []
  }

  allPageIds(): string[] {
    return this.items().flatMap(collectPageIds)
  }

  private node(id: TreeID): LoroTreeNode | undefined {
    if (!this.tree.has(id)) return undefined
    const n = this.tree.getNodeByID(id)
    return n && !n.isDeleted() ? n : undefined
  }

  private requireNode(id: TreeID): LoroTreeNode {
    const n = this.node(id)
    if (!n) throw new Error(`Unknown notebook node ${id}`)
    return n
  }

  private kindOf(id: TreeID): NodeKind {
    return this.requireNode(id).data.get('kind') as NodeKind
  }

  private assertPlacement(kind: NodeKind, parentId: TreeID | undefined): void {
    const parentKind = parentId === undefined ? 'root' : this.kindOf(parentId)
    if (!ALLOWED_PARENTS[kind].includes(parentKind)) throw new Error(`A ${kind} cannot be placed in ${parentKind}`)
  }

  private create(kind: NodeKind, parent: TreeID | undefined, data: Record<string, string | number>): TreeID {
    this.assertPlacement(kind, parent)
    const node = this.tree.createNode(parent)
    node.data.set('kind', kind)
    for (const [key, value] of Object.entries(data)) node.data.set(key, value)
    this.doc.commit()
    return node.id
  }

  private setData(id: TreeID, key: string, value: string | number): void {
    this.requireNode(id).data.set(key, value)
    this.doc.commit()
  }
}
```

Append to `packages/core/src/index.ts`:
```ts
export * from './tree'
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run packages/core && npm run typecheck`
Expected: all PASS. If `roots()` comes back in a different order than created, call `this.tree.roots()` sorted by `n.index() ?? 0` in `items()`. With fractional index enabled, Loro orders roots by position.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): NotebookDoc tree for groups, sections and pages"
```

---

### Task 5: Main-process storage — DocStore (SQLite) and BlobStore

**Files:**
- Create: `packages/desktop/package.json`, `packages/desktop/vitest.main.config.ts`
- Create: `packages/desktop/src/main/store.ts`, `packages/desktop/src/main/blobs.ts`
- Test: `packages/desktop/src/main/store.test.ts`, `packages/desktop/src/main/blobs.test.ts`
- Modify: root `package.json` (scripts `postinstall`, `test:main`)

**Interfaces:**
- Produces:
  ```ts
  class DocStore {
    constructor(file: string)
    list(prefix: string): string[]
    load(docId: string): Uint8Array[]          // snapshot (if any) then updates, in order
    append(docId: string, update: Uint8Array): void   // auto-compacts at 500 updates
    compact(docId: string): void
    remove(docId: string): void
    getSetting<T>(key: string): T | undefined
    setSetting(key: string, value: unknown): void
    close(): void
  }
  const BLOB_SCHEME = 'slate-blob'
  class BlobStore {
    constructor(dir: string)
    put(bytes: Uint8Array, mime: string): string     // returns 'slate-blob://blob/<sha256>.<ext>'
    pathForUrl(url: string): string | null
  }
  ```
  Doc id conventions (used by later tasks): `notebook:<uuid>`, `page:<uuid>`.

- [ ] **Step 1: Create the desktop package**

`packages/desktop/package.json`:
```json
{
  "name": "@slate/desktop",
  "version": "0.1.0",
  "private": true,
  "main": "out/main/index.js",
  "scripts": {
    "test": "cross-env ELECTRON_RUN_AS_NODE=1 electron ../../node_modules/vitest/vitest.mjs run --config vitest.main.config.ts"
  },
  "dependencies": {
    "better-sqlite3": "^13.0.3",
    "loro-crdt": "^1.16.4"
  },
  "devDependencies": {
    "@electron/rebuild": "^4.2.1",
    "@types/better-sqlite3": "^9.6.0",
    "cross-env": "^10.1.0",
    "electron": "^45.0.0"
  }
}
```

`packages/desktop/vitest.main.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

// Runs under Electron's Node (ELECTRON_RUN_AS_NODE=1) so better-sqlite3's Electron build loads.
export default defineConfig({ test: { environment: 'node', include: ['src/main/**/*.test.ts'] } })
```

Root `package.json` — add these scripts to the `scripts` block:
```json
"postinstall": "electron-rebuild -f -o better-sqlite3",
"test:main": "npm run test -w @slate/desktop"
```

Run: `npm install`
Expected: installs, then `electron-rebuild` prints `Rebuild Complete`.

- [ ] **Step 2: Write the failing store tests**

`packages/desktop/src/main/store.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc } from 'loro-crdt'
import { DocStore } from './store'

const dirs: string[] = []
function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slate-store-'))
  dirs.push(dir)
  return join(dir, 'slate.db')
}
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

function edits(n: number): { doc: LoroDoc; updates: Uint8Array[] } {
  const doc = new LoroDoc()
  const updates: Uint8Array[] = []
  for (let i = 0; i < n; i++) {
    const from = doc.oplogVersion()
    doc.getMap('m').set(`k${i}`, i)
    doc.commit()
    updates.push(doc.export({ mode: 'update', from }))
  }
  return { doc, updates }
}

describe('DocStore', () => {
  it('appends and loads updates in order', () => {
    const store = new DocStore(tempDb())
    store.append('page:1', new Uint8Array([1, 2]))
    store.append('page:1', new Uint8Array([3]))
    expect(store.load('page:1').map((u) => Array.from(u))).toEqual([[1, 2], [3]])
    expect(store.load('page:missing')).toEqual([])
    store.close()
  })

  it('lists doc ids by literal prefix', () => {
    const store = new DocStore(tempDb())
    store.append('notebook:a', new Uint8Array([1]))
    store.append('page:b', new Uint8Array([1]))
    store.append('notebook_x', new Uint8Array([1]))
    expect(store.list('notebook:')).toEqual(['notebook:a'])
    store.close()
  })

  it('compacts automatically and preserves document state', () => {
    const store = new DocStore(tempDb())
    const { doc, updates } = edits(520)
    for (const u of updates) store.append('page:c', u)
    const parts = store.load('page:c')
    expect(parts.length).toBeLessThan(30)
    const restored = new LoroDoc()
    restored.importBatch(parts)
    expect(restored.toJSON()).toEqual(doc.toJSON())
    store.close()
  })

  it('persists across reopen and removes docs', () => {
    const file = tempDb()
    const first = new DocStore(file)
    first.append('page:p', new Uint8Array([9]))
    first.close()
    const second = new DocStore(file)
    expect(second.load('page:p')).toHaveLength(1)
    second.remove('page:p')
    expect(second.load('page:p')).toEqual([])
    expect(second.list('page:')).toEqual([])
    second.close()
  })

  it('stores settings as JSON', () => {
    const store = new DocStore(tempDb())
    expect(store.getSetting('settings')).toBeUndefined()
    store.setSetting('settings', { markdownShortcuts: true })
    expect(store.getSetting('settings')).toEqual({ markdownShortcuts: true })
    store.close()
  })
})
```

`packages/desktop/src/main/blobs.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BlobStore } from './blobs'

describe('BlobStore', () => {
  it('stores bytes content-addressed and resolves the URL back to the file', () => {
    const blobs = new BlobStore(mkdtempSync(join(tmpdir(), 'slate-blobs-')))
    const bytes = new Uint8Array([137, 80, 78, 71])
    const url = blobs.put(bytes, 'image/png')
    expect(url).toMatch(/^slate-blob:\/\/blob\/[a-f0-9]{64}\.png$/)
    expect(blobs.put(bytes, 'image/png')).toBe(url)
    expect(Array.from(readFileSync(blobs.pathForUrl(url)!))).toEqual(Array.from(bytes))
  })

  it('rejects foreign or malformed URLs', () => {
    const blobs = new BlobStore(mkdtempSync(join(tmpdir(), 'slate-blobs-')))
    expect(blobs.pathForUrl('file:///etc/passwd')).toBeNull()
    expect(blobs.pathForUrl('slate-blob://other/' + 'a'.repeat(64) + '.png')).toBeNull()
    expect(blobs.pathForUrl('slate-blob://blob/../../etc/passwd')).toBeNull()
    expect(blobs.pathForUrl('not a url')).toBeNull()
  })
})
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `npm run test:main`
Expected: FAIL — cannot resolve `./store` / `./blobs`.

- [ ] **Step 4: Implement DocStore and BlobStore**

`packages/desktop/src/main/store.ts`:
```ts
import Database from 'better-sqlite3'
import { LoroDoc } from 'loro-crdt'

const COMPACT_THRESHOLD = 500

/** Local document store: Loro snapshots + append-only update rows, WAL-journaled. */
export class DocStore {
  private db: Database.Database

  constructor(file: string) {
    this.db = new Database(file)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (doc_id TEXT PRIMARY KEY, data BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS updates (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id TEXT NOT NULL, data BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS updates_doc ON updates (doc_id, id);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `)
  }

  list(prefix: string): string[] {
    const like = prefix.replace(/[\\%_]/g, (c) => `\\${c}`) + '%'
    const rows = this.db
      .prepare(
        `SELECT doc_id FROM snapshots WHERE doc_id LIKE ? ESCAPE '\\'
         UNION SELECT doc_id FROM updates WHERE doc_id LIKE ? ESCAPE '\\' ORDER BY doc_id`,
      )
      .all(like, like) as Array<{ doc_id: string }>
    return rows.map((r) => r.doc_id)
  }

  load(docId: string): Uint8Array[] {
    const snapshot = this.db.prepare('SELECT data FROM snapshots WHERE doc_id = ?').get(docId) as { data: Buffer } | undefined
    const updates = this.db.prepare('SELECT data FROM updates WHERE doc_id = ? ORDER BY id').all(docId) as Array<{ data: Buffer }>
    return [...(snapshot ? [snapshot.data] : []), ...updates.map((u) => u.data)].map((b) => new Uint8Array(b))
  }

  append(docId: string, update: Uint8Array): void {
    this.db.prepare('INSERT INTO updates (doc_id, data) VALUES (?, ?)').run(docId, Buffer.from(update))
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM updates WHERE doc_id = ?').get(docId) as { n: number }
    if (n >= COMPACT_THRESHOLD) this.compact(docId)
  }

  compact(docId: string): void {
    this.db.transaction(() => {
      const parts = this.load(docId)
      if (parts.length === 0) return
      const doc = new LoroDoc()
      doc.importBatch(parts)
      const snapshot = doc.export({ mode: 'snapshot' })
      this.db
        .prepare('INSERT INTO snapshots (doc_id, data) VALUES (?, ?) ON CONFLICT(doc_id) DO UPDATE SET data = excluded.data')
        .run(docId, Buffer.from(snapshot))
      this.db.prepare('DELETE FROM updates WHERE doc_id = ?').run(docId)
    })()
  }

  remove(docId: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM snapshots WHERE doc_id = ?').run(docId)
      this.db.prepare('DELETE FROM updates WHERE doc_id = ?').run(docId)
    })()
  }

  getSetting<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row ? (JSON.parse(row.value) as T) : undefined
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value))
  }

  close(): void {
    this.db.close()
  }
}
```

`packages/desktop/src/main/blobs.ts`:
```ts
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const BLOB_SCHEME = 'slate-blob'

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
}
const FILE_NAME = /^[a-f0-9]{64}\.[a-z0-9]{1,5}$/

/** Content-addressed image files, served to the renderer as slate-blob://blob/<sha256>.<ext>. */
export class BlobStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true })
  }

  put(bytes: Uint8Array, mime: string): string {
    const name = `${createHash('sha256').update(bytes).digest('hex')}.${EXTENSIONS[mime] ?? 'bin'}`
    const file = join(this.dir, name)
    if (!existsSync(file)) {
      writeFileSync(`${file}.tmp`, bytes)
      renameSync(`${file}.tmp`, file)
    }
    return `${BLOB_SCHEME}://blob/${name}`
  }

  pathForUrl(url: string): string | null {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return null
    }
    if (parsed.protocol !== `${BLOB_SCHEME}:` || parsed.host !== 'blob') return null
    const name = parsed.pathname.slice(1)
    return FILE_NAME.test(name) ? join(this.dir, name) : null
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `npm run test:main && npm run typecheck`
Expected: 7 tests PASS. If better-sqlite3 reports `NODE_MODULE_VERSION` mismatch, rerun `npx electron-rebuild -f -o better-sqlite3`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(desktop): SQLite DocStore with compaction and content-addressed BlobStore"
```

---

### Task 6: Electron shell — window, IPC, preload, menu and e2e harness

**Files:**
- Create: `packages/desktop/electron.vite.config.ts`, `packages/desktop/playwright.config.ts`
- Create: `packages/desktop/src/shared/api.ts`, `packages/desktop/src/shared/ipc.ts`
- Create: `packages/desktop/src/main/index.ts`, `packages/desktop/src/main/ipc.ts`, `packages/desktop/src/main/menu.ts`, `packages/desktop/src/main/settings.ts`
- Create: `packages/desktop/src/preload/index.ts`
- Create: `packages/desktop/src/renderer/index.html`, `packages/desktop/src/renderer/src/main.tsx`, `packages/desktop/src/renderer/src/App.tsx`, `packages/desktop/src/renderer/src/env.d.ts`, `packages/desktop/src/renderer/src/app.css`
- Create: `packages/desktop/e2e/fixtures.ts`
- Test: `packages/desktop/e2e/smoke.spec.ts`
- Modify: `packages/desktop/package.json`, root `package.json`

**Interfaces:**
- Consumes: `DocStore`, `BlobStore`, `BLOB_SCHEME` (Task 5).
- Produces (`src/shared/api.ts`):
  ```ts
  interface Settings { markdownShortcuts: boolean }
  const DEFAULT_SETTINGS: Settings
  type MenuCommand = { cmd: 'undo' } | { cmd: 'redo' } | { cmd: 'paste-plain' } | { cmd: 'settings-changed'; settings: Settings }
  interface SlateApi {
    isE2E: boolean
    docs: { list(prefix: string): Promise<string[]>; load(docId: string): Promise<Uint8Array[]>; append(docId: string, update: Uint8Array): Promise<void>; remove(docId: string): Promise<void> }
    blobs: { put(bytes: Uint8Array, mime: string): Promise<string>; copyImage(url: string): Promise<boolean> }
    settings: { get(): Promise<Settings>; set(patch: Partial<Settings>): Promise<Settings> }
    clipboardText(): Promise<string>
    onMenu(handler: (command: MenuCommand) => void): () => void
  }
  ```
  `window.slate: SlateApi`. e2e fixtures: `launchApp(userData: string): Promise<{ app: ElectronApplication; page: Page }>`, `test` fixture with `{ userData, app, page }`, `MOD`.

- [ ] **Step 1: Add Electron/Vite/React/Playwright deps and scripts**

Replace `packages/desktop/package.json` with:
```json
{
  "name": "@slate/desktop",
  "version": "0.1.0",
  "private": true,
  "main": "out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "start": "electron-vite preview",
    "test": "cross-env ELECTRON_RUN_AS_NODE=1 electron ../../node_modules/vitest/vitest.mjs run --config vitest.main.config.ts",
    "e2e": "electron-vite build && playwright test"
  },
  "dependencies": {
    "@slate/core": "*",
    "better-sqlite3": "^13.0.3",
    "loro-crdt": "^1.16.4",
    "react": "^19.3.1",
    "react-dom": "^19.3.1"
  },
  "devDependencies": {
    "@electron/rebuild": "^4.2.1",
    "@playwright/test": "^1.64.1",
    "@types/better-sqlite3": "^9.6.0",
    "@types/react": "^19.3.0",
    "@types/react-dom": "^19.3.0",
    "@vitejs/plugin-react": "^6.1.2",
    "cross-env": "^10.1.0",
    "electron": "^45.0.0",
    "electron-vite": "^6.0.0",
    "vite": "^8.3.5"
  }
}
```

Root `package.json` — add to `scripts`:
```json
"dev": "npm run dev -w @slate/desktop",
"e2e": "npm run e2e -w @slate/desktop"
```

Run: `npm install`

- [ ] **Step 2: Shared API types and IPC channel names**

`packages/desktop/src/shared/api.ts`:
```ts
export interface Settings {
  /** When true, typing "1. ", "- ", "# " or "```" turns into lists/headings/code. Off by default. */
  markdownShortcuts: boolean
}

export const DEFAULT_SETTINGS: Settings = { markdownShortcuts: false }

export type MenuCommand =
  | { cmd: 'undo' }
  | { cmd: 'redo' }
  | { cmd: 'paste-plain' }
  | { cmd: 'settings-changed'; settings: Settings }

export interface SlateApi {
  isE2E: boolean
  docs: {
    list(prefix: string): Promise<string[]>
    load(docId: string): Promise<Uint8Array[]>
    append(docId: string, update: Uint8Array): Promise<void>
    remove(docId: string): Promise<void>
  }
  blobs: {
    put(bytes: Uint8Array, mime: string): Promise<string>
    copyImage(url: string): Promise<boolean>
  }
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
  }
  clipboardText(): Promise<string>
  onMenu(handler: (command: MenuCommand) => void): () => void
}
```

`packages/desktop/src/shared/ipc.ts`:
```ts
export const CH = {
  docsList: 'docs:list',
  docsLoad: 'docs:load',
  docsAppend: 'docs:append',
  docsRemove: 'docs:remove',
  blobsPut: 'blobs:put',
  blobsCopyImage: 'blobs:copy-image',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  clipboardText: 'clipboard:text',
  menu: 'menu:command',
} as const
```

- [ ] **Step 3: Main process**

`packages/desktop/src/main/settings.ts`:
```ts
import { DEFAULT_SETTINGS, type Settings } from '../shared/api'
import type { DocStore } from './store'

export function readSettings(store: DocStore): Settings {
  return { ...DEFAULT_SETTINGS, ...store.getSetting<Partial<Settings>>('settings') }
}

export function writeSettings(store: DocStore, patch: Partial<Settings>): Settings {
  const next = { ...readSettings(store), ...patch }
  store.setSetting('settings', next)
  return next
}
```

`packages/desktop/src/main/ipc.ts`:
```ts
import { clipboard, ipcMain, nativeImage } from 'electron'
import { CH } from '../shared/ipc'
import type { Settings } from '../shared/api'
import type { BlobStore } from './blobs'
import { readSettings, writeSettings } from './settings'
import type { DocStore } from './store'

export function registerIpc(store: DocStore, blobs: BlobStore): void {
  ipcMain.handle(CH.docsList, (_e, prefix: string) => store.list(prefix))
  ipcMain.handle(CH.docsLoad, (_e, docId: string) => store.load(docId))
  ipcMain.handle(CH.docsAppend, (_e, docId: string, update: Uint8Array) => store.append(docId, update))
  ipcMain.handle(CH.docsRemove, (_e, docId: string) => store.remove(docId))
  ipcMain.handle(CH.blobsPut, (_e, bytes: Uint8Array, mime: string) => blobs.put(bytes, mime))
  ipcMain.handle(CH.blobsCopyImage, (_e, url: string) => {
    const file = blobs.pathForUrl(url)
    const image = file ? nativeImage.createFromPath(file) : null
    if (!image || image.isEmpty()) return false
    clipboard.writeImage(image)
    return true
  })
  ipcMain.handle(CH.settingsGet, () => readSettings(store))
  ipcMain.handle(CH.settingsSet, (_e, patch: Partial<Settings>) => writeSettings(store, patch))
  ipcMain.handle(CH.clipboardText, () => clipboard.readText())
}
```

`packages/desktop/src/main/menu.ts`:
```ts
import { BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import type { MenuCommand } from '../shared/api'
import { CH } from '../shared/ipc'
import { readSettings, writeSettings } from './settings'
import type { DocStore } from './store'

function send(command: MenuCommand): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  win?.webContents.send(CH.menu, command)
}

export function buildMenu(store: DocStore): void {
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    {
      label: 'Edit',
      submenu: [
        // Keystrokes go to the page (the editor keymap handles them); the menu entries are for mouse use.
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', registerAccelerator: false, click: () => send({ cmd: 'undo' }) },
        { label: 'Redo', accelerator: isMac ? 'Shift+Cmd+Z' : 'Ctrl+Y', registerAccelerator: false, click: () => send({ cmd: 'redo' }) },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { label: 'Paste as Plain Text', accelerator: 'CmdOrCtrl+Shift+V', registerAccelerator: false, click: () => send({ cmd: 'paste-plain' }) },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          id: 'markdown-shortcuts',
          label: 'Markdown Shortcuts',
          type: 'checkbox',
          checked: readSettings(store).markdownShortcuts,
          click: (item) => send({ cmd: 'settings-changed', settings: writeSettings(store, { markdownShortcuts: item.checked }) }),
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
```

`packages/desktop/src/main/index.ts`:
```ts
import { app, BrowserWindow, net, protocol } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BLOB_SCHEME, BlobStore } from './blobs'
import { registerIpc } from './ipc'
import { buildMenu } from './menu'
import { DocStore } from './store'

if (process.env.SLATE_USER_DATA) app.setPath('userData', process.env.SLATE_USER_DATA)
const isE2E = process.env.SLATE_E2E === '1'

protocol.registerSchemesAsPrivileged([{ scheme: BLOB_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }])

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    title: 'Slate',
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: !isE2E,
    },
  })
  // E2E runs keep the window hidden so tests never pop windows onto the user's screen.
  if (!isE2E) win.once('ready-to-show', () => win.show())
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

void app.whenReady().then(() => {
  const dataDir = app.getPath('userData')
  const store = new DocStore(join(dataDir, 'slate.db'))
  const blobs = new BlobStore(join(dataDir, 'blobs'))
  protocol.handle(BLOB_SCHEME, (request) => {
    const file = blobs.pathForUrl(request.url)
    return file ? net.fetch(pathToFileURL(file).toString()) : new Response('Not found', { status: 404 })
  })
  registerIpc(store, blobs)
  buildMenu(store)
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  app.on('will-quit', () => store.close())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
```

- [ ] **Step 4: Preload bridge**

`packages/desktop/src/preload/index.ts`:
```ts
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { MenuCommand, SlateApi } from '../shared/api'
import { CH } from '../shared/ipc'

const api: SlateApi = {
  isE2E: process.env.SLATE_E2E === '1',
  docs: {
    list: (prefix) => ipcRenderer.invoke(CH.docsList, prefix),
    load: (docId) => ipcRenderer.invoke(CH.docsLoad, docId),
    append: (docId, update) => ipcRenderer.invoke(CH.docsAppend, docId, update),
    remove: (docId) => ipcRenderer.invoke(CH.docsRemove, docId),
  },
  blobs: {
    put: (bytes, mime) => ipcRenderer.invoke(CH.blobsPut, bytes, mime),
    copyImage: (url) => ipcRenderer.invoke(CH.blobsCopyImage, url),
  },
  settings: {
    get: () => ipcRenderer.invoke(CH.settingsGet),
    set: (patch) => ipcRenderer.invoke(CH.settingsSet, patch),
  },
  clipboardText: () => ipcRenderer.invoke(CH.clipboardText),
  onMenu(handler) {
    const listener = (_e: IpcRendererEvent, command: MenuCommand) => handler(command)
    ipcRenderer.on(CH.menu, listener)
    return () => ipcRenderer.removeListener(CH.menu, listener)
  },
}

contextBridge.exposeInMainWorld('slate', api)
```

- [ ] **Step 5: Build config and a placeholder renderer**

`packages/desktop/electron.vite.config.ts`:
```ts
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [react()],
    // The base64 build inlines Loro's wasm, so the renderer needs no wasm bundler plugin.
    resolve: { alias: [{ find: /^loro-crdt$/, replacement: 'loro-crdt/base64' }] },
  },
})
```

`packages/desktop/src/renderer/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: slate-blob: https: http:; connect-src 'self' ws: http://localhost:*"
    />
    <title>Slate</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./src/main.tsx"></script>
  </body>
</html>
```

`packages/desktop/src/renderer/src/env.d.ts`:
```ts
import type { SlateApi } from '../../shared/api'

declare global {
  interface Window {
    slate: SlateApi
  }
}

export {}
```

`packages/desktop/src/renderer/src/main.tsx`:
```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './app.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

`packages/desktop/src/renderer/src/App.tsx` (placeholder, replaced in Task 9):
```tsx
export function App() {
  return <div className="app">Slate</div>
}
```

`packages/desktop/src/renderer/src/app.css`:
```css
:root {
  color-scheme: dark;
  --bg: #1e1e1e;
  --panel: #252526;
  --panel-2: #2d2d2d;
  --border: #3a3a3a;
  --text: #e6e6e6;
  --muted: #9a9a9a;
  --accent: #b48ce8;
  --hover: #333333;
  --selected: #3d3d3d;
  --danger: #e45b5b;
  font-family: system-ui, -apple-system, 'Segoe UI', Ubuntu, sans-serif;
  font-size: 14px;
}
@media (prefers-color-scheme: light) {
  :root {
    color-scheme: light;
    --bg: #ffffff;
    --panel: #f4f4f5;
    --panel-2: #e9e9eb;
    --border: #d4d4d8;
    --text: #1f1f1f;
    --muted: #6b6b6b;
    --accent: #7c3aed;
    --hover: #ececee;
    --selected: #e2e2e6;
  }
}
* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; }
body { background: var(--bg); color: var(--text); overflow: hidden; }
.app { display: grid; grid-template-columns: auto 1fr; height: 100%; }
.app-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.app-loading, .empty { padding: 24px; color: var(--muted); }
```

- [ ] **Step 6: E2E harness and failing smoke test**

`packages/desktop/playwright.config.ts`:
```ts
import { defineConfig } from '@playwright/test'

export default defineConfig({ testDir: 'e2e', timeout: 30_000, workers: 1, reporter: 'list' })
```

`packages/desktop/e2e/fixtures.ts`:
```ts
import { test as base, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

export async function launchApp(userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...(process.env as Record<string, string>), SLATE_E2E: '1', SLATE_USER_DATA: userData },
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

export const test = base.extend<{ userData: string; app: ElectronApplication; page: Page }>({
  userData: async ({}, use) => {
    await use(mkdtempSync(join(tmpdir(), 'slate-e2e-')))
  },
  app: async ({ userData }, use) => {
    const { app } = await launchApp(userData)
    await use(app)
    await app.close()
  },
  page: async ({ app }, use) => {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await use(page)
  },
})

export { expect } from '@playwright/test'
```

`packages/desktop/e2e/smoke.spec.ts`:
```ts
import { expect, test } from './fixtures'

test('boots and round-trips a document through IPC', async ({ page }) => {
  await expect(page).toHaveTitle('Slate')
  const bytes = await page.evaluate(async () => {
    await window.slate.docs.append('test:1', new Uint8Array([1, 2, 3]))
    return Array.from((await window.slate.docs.load('test:1'))[0])
  })
  expect(bytes).toEqual([1, 2, 3])
})

test('keeps the window hidden during e2e runs', async ({ app }) => {
  const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())
  expect(visible).toBe(false)
})
```

- [ ] **Step 7: Build and run the e2e smoke tests**

Run: `npm run e2e`
Expected: build succeeds; 2 tests PASS. If Playwright input or clipboard calls misbehave later on a hidden window, the fallback is to show the window off-screen under e2e. Don't make that change unless a test proves it's needed.

- [ ] **Step 8: Manual check**

Run: `npm run dev`
Expected: a window titled "Slate" shows the text "Slate", and the Edit menu contains "Paste as Plain Text". Close it.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(desktop): Electron shell with sandboxed preload API, menu and e2e harness"
```

---

### Task 7: Editor package — TipTap extensions and clipboard cleaning

**Files:**
- Create: `packages/editor/package.json`, `packages/editor/vitest.config.ts`, `packages/editor/src/index.ts`, `packages/editor/src/extensions.ts`, `packages/editor/src/clipboard.ts`
- Test: `packages/editor/test/clipboard.test.ts`

**Interfaces:**
- Consumes: `toPlainText`, `PMJSON` (Task 2).
- Produces: `buildExtensions(): Extensions`; `schema: Schema` (built from `buildExtensions()`); `cleanPastedHtml(html: string): string`; `stripCopiedStyles(root: ParentNode): void`; `makeClipboardSerializer(schema: Schema): DOMSerializer`; `serializeSliceAsText(slice: Slice): string`.

- [ ] **Step 1: Create the editor package**

`packages/editor/package.json`:
```json
{
  "name": "@slate/editor",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": "./src/index.ts",
  "dependencies": {
    "@slate/core": "*",
    "@tiptap/core": "^3.32.0",
    "@tiptap/extension-code-block-lowlight": "^3.32.0",
    "@tiptap/extension-highlight": "^3.32.0",
    "@tiptap/extension-image": "^3.32.0",
    "@tiptap/extension-table": "^3.32.0",
    "@tiptap/extension-text-style": "^3.32.0",
    "@tiptap/pm": "^3.32.0",
    "@tiptap/react": "^3.32.0",
    "@tiptap/starter-kit": "^3.32.0",
    "loro-crdt": "^1.16.4",
    "loro-prosemirror": "^0.4.4",
    "lowlight": "^3.3.0",
    "react": "^19.3.1",
    "react-dom": "^19.3.1"
  },
  "devDependencies": {
    "happy-dom": "^21.0.4"
  }
}
```

`packages/editor/vitest.config.ts`:
```ts
import { defineProject } from 'vitest/config'

export default defineProject({ test: { name: 'editor', environment: 'node', include: ['test/**/*.test.ts'] } })
```

Run: `npm install && npm ls prosemirror-model`
Expected: a **single** `prosemirror-model` version, shared by `@tiptap/pm` and `loro-prosemirror`. If there are two, add `"overrides": { "prosemirror-model": "<the @tiptap/pm version>" }` to the root `package.json` and reinstall. Two copies break `instanceof` checks inside ProseMirror.

- [ ] **Step 2: Extensions**

`packages/editor/src/extensions.ts`:
```ts
import { getSchema, type Extensions } from '@tiptap/core'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import Highlight from '@tiptap/extension-highlight'
import Image from '@tiptap/extension-image'
import { TableKit } from '@tiptap/extension-table'
import { Color, FontFamily, FontSize, TextStyle } from '@tiptap/extension-text-style'
import StarterKit from '@tiptap/starter-kit'
import { common, createLowlight } from 'lowlight'

const lowlight = createLowlight(common)

/**
 * Every box editor uses exactly this extension list, so the static renderer's schema matches.
 * Undo/redo is handled per page by Loro (PageSession), not by TipTap history.
 * No Typography extension: no smart quotes or dash replacement.
 */
export function buildExtensions(): Extensions {
  return [
    StarterKit.configure({
      undoRedo: false,
      codeBlock: false,
      trailingNode: false,
      heading: { levels: [1, 2, 3] },
      link: { autolink: false, linkOnPaste: false, openOnClick: false },
    }),
    TextStyle,
    Color,
    FontFamily,
    FontSize,
    Highlight.configure({ multicolor: true }),
    Image.configure({ inline: false, allowBase64: true }),
    TableKit.configure({ table: { resizable: false } }),
    CodeBlockLowlight.configure({ lowlight, defaultLanguage: 'plaintext' }),
  ]
}

export const schema = getSchema(buildExtensions())
```

- [ ] **Step 3: Write the failing clipboard tests**

`packages/editor/test/clipboard.test.ts`:
```ts
// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { cleanPastedHtml, makeClipboardSerializer, serializeSliceAsText, stripCopiedStyles } from '../src/clipboard'
import { schema } from '../src/extensions'

describe('cleanPastedHtml', () => {
  it('drops fonts, sizes, colours, classes and style blocks but keeps structure', () => {
    const html =
      '<meta charset="utf-8"><style>p{color:red}</style>' +
      '<p class="x" style="font-family:Comic Sans MS;font-size:30px;color:red">Hello <font face="Arial" color="blue">there</font></p>' +
      '<ol start="3"><li><a href="https://example.com" style="color:green">link</a></li></ol>'
    const out = cleanPastedHtml(html)
    expect(out).toBe('<p>Hello there</p><ol start="3"><li><a href="https://example.com">link</a></li></ol>')
  })

  it('keeps bold and italic expressed as inline styles (Google Docs style)', () => {
    const html =
      '<b style="font-weight:normal;" id="docs-internal-guid-1"><p><span style="font-weight:700">bold</span> ' +
      '<span style="font-style:italic">it</span> plain</p></b>'
    expect(cleanPastedHtml(html)).toBe('<p><strong>bold</strong> <em>it</em> plain</p>')
  })
})

describe('stripCopiedStyles', () => {
  it('keeps colour and drops every other inline style, class and data attribute', () => {
    const root = document.createElement('div')
    root.innerHTML = '<p class="a" data-x="1"><span style="color: red; font-family: Mono; font-size: 20px">t</span></p>'
    stripCopiedStyles(root)
    expect(root.innerHTML).toBe('<p><span style="color: red;">t</span></p>')
  })
})

describe('clipboard serializers', () => {
  const doc = schema.nodeFromJSON({
    type: 'doc',
    content: [
      {
        type: 'orderedList',
        attrs: { start: 1 },
        content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] },
          {
            type: 'listItem',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'two' }] },
              { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] }] },
            ],
          },
        ],
      },
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'styled', marks: [{ type: 'textStyle', attrs: { color: '#ff0000', fontFamily: 'Comic Sans MS', fontSize: '30px' } }] }],
      },
    ],
  })

  it('serializes a slice to developer-clean plain text', () => {
    expect(serializeSliceAsText(doc.slice(0, doc.content.size))).toBe('1. one\n2. two\n  - a\nstyled')
  })

  it('serializes HTML with semantic lists and colour only', () => {
    const out = makeClipboardSerializer(schema).serializeFragment(doc.content, { document })
    const div = document.createElement('div')
    div.appendChild(out)
    expect(div.querySelector('ol > li')).not.toBeNull()
    expect(div.innerHTML).toContain('color')
    expect(div.innerHTML).not.toContain('font-family')
    expect(div.innerHTML).not.toContain('font-size')
  })
})
```

- [ ] **Step 4: Run the tests to see them fail**

Run: `npx vitest run packages/editor`
Expected: FAIL — cannot resolve `../src/clipboard`.

- [ ] **Step 5: Implement clipboard helpers**

`packages/editor/src/clipboard.ts`:
```ts
import { DOMSerializer, type Fragment, type Schema, type Slice } from '@tiptap/pm/model'
import { toPlainText, type PMJSON } from '@slate/core'

const KEEP_PASTE_ATTRS = new Set(['href', 'src', 'alt', 'start', 'colspan', 'rowspan'])

function unwrap(el: Element): void {
  el.replaceWith(...Array.from(el.childNodes))
}

function wrapContents(el: Element, tag: string): void {
  const wrapper = el.ownerDocument.createElement(tag)
  while (el.firstChild) wrapper.appendChild(el.firstChild)
  el.appendChild(wrapper)
}

/** Default paste: keep structure and bold/italic, drop the source's fonts, sizes, colours and classes. */
export function cleanPastedHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('style, script, meta, link, title').forEach((e) => e.remove())
  for (const el of Array.from(doc.body.querySelectorAll<HTMLElement>('*'))) {
    const weight = el.style.fontWeight
    if ((el.tagName === 'B' || el.tagName === 'STRONG') && /^(normal|[1-4]00)$/.test(weight)) {
      unwrap(el)
      continue
    }
    if (/^(bold|bolder|[6-9]00)$/.test(weight) && !/^(B|STRONG|H[1-6]|TH)$/.test(el.tagName)) wrapContents(el, 'strong')
    if (el.style.fontStyle === 'italic' && !/^(I|EM)$/.test(el.tagName)) wrapContents(el, 'em')
  }
  for (const el of Array.from(doc.body.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) if (!KEEP_PASTE_ATTRS.has(attr.name)) el.removeAttribute(attr.name)
  }
  doc.body.querySelectorAll('font, span').forEach(unwrap)
  return doc.body.innerHTML
}

/** Copied HTML keeps colour only; fonts and sizes would fight the destination app's styling. */
export function stripCopiedStyles(root: ParentNode): void {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    const color = el.style.color
    el.removeAttribute('style')
    el.removeAttribute('class')
    for (const attr of Array.from(el.attributes)) if (attr.name.startsWith('data-')) el.removeAttribute(attr.name)
    if (color) el.style.color = color
  }
}

class CleanSerializer extends DOMSerializer {
  override serializeFragment(
    fragment: Fragment,
    options: { document?: Document } = {},
    target?: HTMLElement | DocumentFragment,
  ): HTMLElement | DocumentFragment {
    const out = super.serializeFragment(fragment, options, target)
    stripCopiedStyles(out)
    return out
  }
}

export function makeClipboardSerializer(schema: Schema): DOMSerializer {
  return new CleanSerializer(DOMSerializer.nodesFromSchema(schema), DOMSerializer.marksFromSchema(schema))
}

export function serializeSliceAsText(slice: Slice): string {
  return toPlainText((slice.content.toJSON() as PMJSON[] | null) ?? [])
}
```

`packages/editor/src/index.ts`:
```ts
export * from './extensions'
export * from './clipboard'
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run packages/editor && npm run typecheck`
Expected: all PASS. If happy-dom serializes `style="color: red;"` without the trailing semicolon, change only that expected string to match what the browser engine produces.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(editor): TipTap extensions and clean clipboard serializers"
```

---

### Task 8: Loro binding, content writer, static renderer and PageSession

**Files:**
- Create: `packages/editor/src/loroBinding.ts`, `packages/editor/src/content.ts`, `packages/editor/src/staticRender.ts`, `packages/editor/src/PageSession.ts`
- Modify: `packages/editor/src/index.ts`
- Test: `packages/editor/test/content.test.ts`, `packages/editor/test/pageSession.test.ts`

**Interfaces:**
- Consumes: `PageDoc`, `BoxState`, `computePush`, `PMJSON` (core); `schema`, `buildExtensions` (Task 7).
- Produces:
  ```ts
  const LoroBinding: Extension<{ doc: LoroDoc | null; containerId: ContainerID | null }>
  function writeContent(root: LoroMap, blocks: PMJSON[]): void
  function renderStaticHtml(schema: Schema, doc: LoroDoc, contentId: ContainerID, document: Document): DocumentFragment | null
  interface DocPersistence { load(docId: string): Promise<Uint8Array[]>; append(docId: string, update: Uint8Array): Promise<void> }
  const pageDocId: (pageId: string) => string     // `page:${pageId}`
  const DEFAULT_BOX_WIDTH = 480
  class PageSession {
    static open(pageId: string, persistence: DocPersistence): Promise<PageSession>
    readonly pageId: string
    readonly page: PageDoc
    readonly undoManager: UndoManager
    get doc(): LoroDoc
    getBoxes: () => BoxState[]                      // stable snapshot for useSyncExternalStore
    subscribe: (listener: () => void) => () => void
    createBox(x: number, y: number, width?: number): string
    createBoxWithContent(x: number, y: number, blocks: PMJSON[], width?: number): string
    noteLocalEdit(boxId: string): void
    reportHeight(boxId: string, height: number): void
    heightOf(boxId: string): number | undefined
    undo(): boolean
    redo(): boolean
    close(): void
  }
  ```

- [ ] **Step 1: Write the failing tests**

`packages/editor/test/content.test.ts`:
```ts
// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { LoroDoc, type LoroMap } from 'loro-crdt'
import { createNodeFromLoroObj, type LoroNode } from 'loro-prosemirror'
import { writeContent } from '../src/content'
import { schema } from '../src/extensions'
import { renderStaticHtml } from '../src/staticRender'

function seeded(): { doc: LoroDoc; root: LoroMap } {
  const doc = new LoroDoc()
  const root = doc.getMap('content')
  writeContent(root, [
    { type: 'paragraph', content: [{ type: 'text', text: 'hello' }] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'item' }] }] }] },
    { type: 'image', attrs: { src: 'slate-blob://blob/x.png' } },
  ])
  doc.commit()
  return { doc, root }
}

describe('writeContent', () => {
  it('writes ProseMirror JSON in the layout loro-prosemirror reads', () => {
    const { root } = seeded()
    const node = createNodeFromLoroObj(schema, root as unknown as LoroNode, new Map())
    expect(node.type.name).toBe('doc')
    expect(node.childCount).toBe(3)
    expect(node.child(0).textContent).toBe('hello')
    expect(node.child(1).type.name).toBe('bulletList')
    expect(node.child(2).attrs.src).toBe('slate-blob://blob/x.png')
  })
})

describe('renderStaticHtml', () => {
  it('renders the box content to DOM', () => {
    const { doc, root } = seeded()
    const frag = renderStaticHtml(schema, doc, root.id, document)!
    const div = document.createElement('div')
    div.appendChild(frag)
    expect(div.querySelector('p')!.textContent).toBe('hello')
    expect(div.querySelector('ul li')!.textContent).toBe('item')
  })

  it('returns null for an empty box', () => {
    const doc = new LoroDoc()
    expect(renderStaticHtml(schema, doc, doc.getMap('empty').id, document)).toBeNull()
  })
})
```

`packages/editor/test/pageSession.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { PageSession, pageDocId, type DocPersistence } from '../src/PageSession'

function memoryPersistence(): DocPersistence & { data: Map<string, Uint8Array[]> } {
  const data = new Map<string, Uint8Array[]>()
  return {
    data,
    load: async (id) => data.get(id) ?? [],
    append: async (id, update) => {
      data.set(id, [...(data.get(id) ?? []), update])
    },
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('PageSession', () => {
  it('persists local changes and reloads them', async () => {
    const persistence = memoryPersistence()
    const first = await PageSession.open('p1', persistence)
    const id = first.createBox(10, 20)
    await tick()
    expect(persistence.data.get(pageDocId('p1'))!.length).toBeGreaterThan(0)
    first.close()
    const second = await PageSession.open('p1', persistence)
    expect(second.getBoxes().map((b) => b.id)).toEqual([id])
    second.close()
  })

  it('notifies subscribers with a fresh snapshot', async () => {
    const session = await PageSession.open('p2', memoryPersistence())
    const before = session.getBoxes()
    let calls = 0
    session.subscribe(() => calls++)
    session.createBox(0, 0)
    await tick()
    expect(calls).toBeGreaterThan(0)
    expect(session.getBoxes()).not.toBe(before)
    expect(session.getBoxes()).toHaveLength(1)
    session.close()
  })

  it('pushes boxes below only when growth follows a local edit', async () => {
    const session = await PageSession.open('p3', memoryPersistence())
    const a = session.createBox(0, 0, 300)
    const b = session.createBox(0, 200, 300)
    await tick()
    session.reportHeight(a, 100)
    session.reportHeight(b, 50)
    session.reportHeight(a, 160) // no local edit noted: e.g. remote change or undo
    await tick()
    expect(session.getBoxes().find((x) => x.id === b)!.y).toBe(200)
    session.noteLocalEdit(a)
    session.reportHeight(a, 200)
    await tick()
    expect(session.getBoxes().find((x) => x.id === b)!.y).toBe(240)
    session.close()
  })

  it('undoes and redoes page changes', async () => {
    const session = await PageSession.open('p4', memoryPersistence())
    session.createBox(0, 0)
    await tick()
    expect(session.undo()).toBe(true)
    await tick()
    expect(session.getBoxes()).toHaveLength(0)
    expect(session.redo()).toBe(true)
    await tick()
    expect(session.getBoxes()).toHaveLength(1)
    session.close()
  })

  it('creates a box with initial content', async () => {
    const session = await PageSession.open('p5', memoryPersistence())
    const id = session.createBoxWithContent(5, 5, [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }])
    expect(session.page.contentMap(id)!.size).toBeGreaterThan(0)
    session.close()
  })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run packages/editor`
Expected: FAIL — missing `../src/content`, `../src/staticRender`, `../src/PageSession`.

- [ ] **Step 3: Implement the binding, writer and static renderer**

`packages/editor/src/loroBinding.ts`:
```ts
import { Extension } from '@tiptap/core'
import type { ContainerID, LoroDoc } from 'loro-crdt'
import { LoroSyncPlugin, type LoroDocType } from 'loro-prosemirror'

/** Binds one box editor to its `content` container inside the page's Loro doc. */
export const LoroBinding = Extension.create<{ doc: LoroDoc | null; containerId: ContainerID | null }>({
  name: 'loroBinding',
  addOptions() {
    return { doc: null, containerId: null }
  },
  addProseMirrorPlugins() {
    const { doc, containerId } = this.options
    if (!doc || !containerId) throw new Error('LoroBinding needs doc and containerId')
    return [LoroSyncPlugin({ doc: doc as unknown as LoroDocType, containerId })]
  },
})
```

`packages/editor/src/content.ts`:
```ts
import { LoroList, LoroMap, LoroText, type Value } from 'loro-crdt'
import { ATTRIBUTES_KEY, CHILDREN_KEY, NODE_NAME_KEY } from 'loro-prosemirror'
import type { PMJSON } from '@slate/core'

function writeNode(map: LoroMap, node: PMJSON): void {
  map.set(NODE_NAME_KEY, node.type)
  const attrs = map.setContainer(ATTRIBUTES_KEY, new LoroMap())
  for (const [key, value] of Object.entries(node.attrs ?? {})) if (value !== undefined) attrs.set(key, value as Value)
  const children = map.setContainer(CHILDREN_KEY, new LoroList())
  for (const child of node.content ?? []) {
    if (child.type === 'text') children.insertContainer(children.length, new LoroText()).insert(0, child.text ?? '')
    else writeNode(children.insertContainer(children.length, new LoroMap()), child)
  }
}

/**
 * Writes block content straight into an empty box content container, in the same layout
 * loro-prosemirror uses. For boxes created without a mounted editor (paste on empty canvas,
 * test seeding). Marks are not written. Caller commits.
 */
export function writeContent(root: LoroMap, blocks: PMJSON[]): void {
  writeNode(root, { type: 'doc', content: blocks })
}
```

`packages/editor/src/staticRender.ts`:
```ts
import { DOMSerializer, type Schema } from '@tiptap/pm/model'
import { LoroMap, type ContainerID, type LoroDoc } from 'loro-crdt'
import { createNodeFromLoroObj, type LoroNode } from 'loro-prosemirror'

/** Renders a box's content without an editor (used for off-screen boxes). Null when empty. */
export function renderStaticHtml(schema: Schema, doc: LoroDoc, contentId: ContainerID, document: Document): DocumentFragment | null {
  const map = doc.getContainerById(contentId)
  if (!(map instanceof LoroMap) || map.size === 0) return null
  const node = createNodeFromLoroObj(schema, map as unknown as LoroNode, new Map())
  return DOMSerializer.fromSchema(schema).serializeFragment(node.content, { document }) as DocumentFragment
}
```

- [ ] **Step 4: Implement PageSession**

`packages/editor/src/PageSession.ts`:
```ts
import { UndoManager, type LoroDoc } from 'loro-crdt'
import { PageDoc, computePush, type BoxState, type PMJSON } from '@slate/core'
import { writeContent } from './content'

export interface DocPersistence {
  load(docId: string): Promise<Uint8Array[]>
  append(docId: string, update: Uint8Array): Promise<void>
}

export const pageDocId = (pageId: string): string => `page:${pageId}`
export const DEFAULT_BOX_WIDTH = 480
/** A height change counts as caused by the user's own edit only if it lands this soon after it. */
const LOCAL_EDIT_WINDOW_MS = 500

/** One open page: its Loro doc, page-wide undo, persistence and auto-push. */
export class PageSession {
  readonly page: PageDoc
  readonly undoManager: UndoManager
  private snapshot: BoxState[]
  private listeners = new Set<() => void>()
  private heights = new Map<string, number>()
  private localEdits = new Map<string, number>()
  private cleanup: Array<() => void> = []

  private constructor(readonly pageId: string, page: PageDoc, persistence: DocPersistence) {
    this.page = page
    // sys:* origins are loro-prosemirror's editor initialisation commits; never undo those.
    this.undoManager = new UndoManager(page.doc, { mergeInterval: LOCAL_EDIT_WINDOW_MS, excludeOriginPrefixes: ['sys:'] })
    this.snapshot = page.listBoxes()
    this.cleanup.push(page.doc.subscribeLocalUpdates((update) => void persistence.append(pageDocId(pageId), update)))
    this.cleanup.push(
      page.doc.subscribe(() => {
        this.snapshot = page.listBoxes()
        this.listeners.forEach((l) => l())
      }),
    )
  }

  static async open(pageId: string, persistence: DocPersistence): Promise<PageSession> {
    return new PageSession(pageId, PageDoc.fromUpdates(await persistence.load(pageDocId(pageId))), persistence)
  }

  get doc(): LoroDoc {
    return this.page.doc
  }

  getBoxes = (): BoxState[] => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  createBox(x: number, y: number, width = DEFAULT_BOX_WIDTH): string {
    return this.page.addBox({ x, y, width })
  }

  createBoxWithContent(x: number, y: number, blocks: PMJSON[], width = DEFAULT_BOX_WIDTH): string {
    const id = this.page.addBox({ x, y, width })
    writeContent(this.page.contentMap(id)!, blocks)
    this.doc.commit()
    return id
  }

  noteLocalEdit(boxId: string): void {
    this.localEdits.set(boxId, Date.now())
  }

  heightOf(boxId: string): number | undefined {
    return this.heights.get(boxId)
  }

  reportHeight(boxId: string, height: number): void {
    const old = this.heights.get(boxId)
    this.heights.set(boxId, height)
    const editedAt = this.localEdits.get(boxId)
    const local = editedAt !== undefined && Date.now() - editedAt < LOCAL_EDIT_WINDOW_MS
    if (!local || old === undefined || height <= old) return
    const rects = this.snapshot.map((b) => ({ id: b.id, x: b.x, y: b.y, width: b.width, height: this.heights.get(b.id) ?? 0 }))
    const moved = computePush(rects, boxId, old, height)
    if (moved.size > 0) this.page.moveBoxes(moved)
  }

  undo(): boolean {
    return this.undoManager.undo()
  }

  redo(): boolean {
    return this.undoManager.redo()
  }

  close(): void {
    this.cleanup.forEach((c) => c())
    this.cleanup = []
    this.listeners.clear()
  }
}
```

Replace `packages/editor/src/index.ts` with:
```ts
export * from './extensions'
export * from './clipboard'
export * from './content'
export * from './staticRender'
export * from './loroBinding'
export * from './PageSession'
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run packages/editor && npm run typecheck`
Expected: all PASS. If the `createNodeFromLoroObj` assertion fails because loro-prosemirror stores attributes differently, open `node_modules/loro-prosemirror/dist/index.js` and read `createNodeFromLoroObj` and `updateLoroToPmState`. Match `writeNode` to that layout, then re-run.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(editor): Loro binding, static renderer and PageSession with auto-push and undo"
```

---

### Task 9: Canvas UI wired into the app

**Files:**
- Create: `packages/editor/src/activeEditor.ts`, `packages/editor/src/services.ts`, `packages/editor/src/keymap.ts`, `packages/editor/src/Canvas.tsx`, `packages/editor/src/Box.tsx`, `packages/editor/src/BoxEditor.tsx`, `packages/editor/src/StaticBox.tsx`, `packages/editor/src/canvas.css`
- Modify: `packages/editor/src/index.ts`
- Create: `packages/desktop/src/renderer/src/library.ts`, `packages/desktop/src/renderer/src/currentSession.ts`, `packages/desktop/src/renderer/src/PageView.tsx`
- Modify: `packages/desktop/src/renderer/src/App.tsx`, `packages/desktop/package.json` (add `@slate/editor`)
- Test: `packages/desktop/e2e/canvas.spec.ts`

**Interfaces:**
- Consumes: `PageSession`, `LoroBinding`, `buildExtensions`, `schema`, `renderStaticHtml` (Task 8); `NotebookDoc`, `newId` (core); `SlateApi` (Task 6).
- Produces:
  - `activeEditor: { get(): Editor | null; set(e: Editor | null): void; clear(e: Editor): void; subscribe(l: () => void): () => void }`. This is the **last focused** editor; it isn't cleared on blur, so toolbar selects still work after taking focus.
  - `interface EditorServices { putBlob(bytes: Uint8Array, mime: string): Promise<string>; copyImage(url: string): Promise<boolean>; readClipboardText(): Promise<string>; markdownShortcuts: boolean }`, `EditorServicesContext`, `useEditorServices()`.
  - `Canvas({ session }: { session: PageSession })`.
  - Renderer: `Library` (`load(api)`, `notebooks()`, `createNotebook(name)`, `deleteNotebook(id)`, `removePageDocs(pageIds)`, `subscribe`, `getVersion`), `notebookDocId(id)`, `currentSession` (`get/set/clear`).
  - Test ids: `canvas`, `canvas-scroll`, `box`, `box-handle`, `box-resize`, `box-editor`, `box-static`.

- [ ] **Step 1: Write the failing e2e test**

`packages/desktop/e2e/canvas.spec.ts`:
```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, launchApp, MOD, test } from './fixtures'

async function newBox(page: Page, x: number, y: number) {
  await page.getByTestId('canvas').click({ position: { x, y } })
  await expect(page.getByTestId('box-editor').last()).toBeFocused()
}

test('click on the canvas creates a box you can type in', async ({ page }) => {
  await newBox(page, 200, 150)
  await page.keyboard.type('hello slate')
  await expect(page.getByTestId('box')).toHaveCount(1)
  await expect(page.getByTestId('box-editor')).toHaveText('hello slate')
})

test('an empty box disappears when it loses focus', async ({ page }) => {
  await newBox(page, 100, 100)
  await page.evaluate(() => (document.activeElement as HTMLElement).blur())
  await expect(page.getByTestId('box')).toHaveCount(0)
})

test('boxes can be dragged and resized', async ({ page }) => {
  await newBox(page, 100, 100)
  await page.keyboard.type('drag me')
  const box = page.getByTestId('box')
  const before = await box.boundingBox()
  await box.hover()
  const handle = await page.getByTestId('box-handle').boundingBox()
  await page.mouse.move(handle!.x + 20, handle!.y + 5)
  await page.mouse.down()
  await page.mouse.move(handle!.x + 120, handle!.y + 65, { steps: 5 })
  await page.mouse.up()
  await expect.poll(async () => (await box.boundingBox())!.x).toBeCloseTo(before!.x + 100, -1)
  const resize = await page.getByTestId('box-resize').boundingBox()
  await page.mouse.move(resize!.x + 4, resize!.y + 10)
  await page.mouse.down()
  await page.mouse.move(resize!.x + 104, resize!.y + 10, { steps: 5 })
  await page.mouse.up()
  await expect.poll(async () => (await box.boundingBox())!.width).toBeCloseTo(before!.width + 100, -1)
})

test('undo reverts typing', async ({ page }) => {
  await newBox(page, 100, 100)
  await page.keyboard.type('keep')
  await page.waitForTimeout(700) // let the undo step close
  await page.keyboard.type(' drop')
  await page.keyboard.press(`${MOD}+z`)
  await expect(page.getByTestId('box-editor')).toHaveText('keep')
})

test('content persists across restarts', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  const first = await launchApp(userData)
  await newBox(first.page, 150, 120)
  await first.page.keyboard.type('survives restart')
  await first.page.waitForTimeout(300)
  await first.app.close()
  const second = await launchApp(userData)
  await expect(second.page.getByTestId('box')).toHaveCount(1)
  await expect(second.page.getByTestId('box').first()).toContainText('survives restart')
  await second.app.close()
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run e2e -- canvas.spec.ts`
Expected: FAIL — no element with test id `canvas`.

- [ ] **Step 3: Editor-side stores, services and keymap**

`packages/editor/src/activeEditor.ts`:
```ts
import type { Editor } from '@tiptap/core'

let active: Editor | null = null
const listeners = new Set<() => void>()

/** The most recently focused box editor. Kept after blur so toolbar controls can act on it. */
export const activeEditor = {
  get: (): Editor | null => active,
  set(editor: Editor | null): void {
    if (active === editor) return
    active = editor
    listeners.forEach((l) => l())
  },
  clear(editor: Editor): void {
    if (active === editor) activeEditor.set(null)
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
}
```

`packages/editor/src/services.ts`:
```ts
import { createContext, useContext } from 'react'

/** What box editors need from the host app. */
export interface EditorServices {
  putBlob(bytes: Uint8Array, mime: string): Promise<string>
  copyImage(url: string): Promise<boolean>
  readClipboardText(): Promise<string>
  markdownShortcuts: boolean
}

export const EditorServicesContext = createContext<EditorServices | null>(null)

export function useEditorServices(): EditorServices {
  const services = useContext(EditorServicesContext)
  if (!services) throw new Error('EditorServicesContext is missing')
  return services
}
```

`packages/editor/src/keymap.ts`:
```ts
import { Extension } from '@tiptap/core'
import type { PageSession } from './PageSession'
import type { EditorServices } from './services'

/** Page-wide undo/redo (Loro) and plain-text paste. */
export const SlateKeymap = Extension.create<{ session: PageSession | null; services: EditorServices | null }>({
  name: 'slateKeymap',
  addOptions() {
    return { session: null, services: null }
  },
  addKeyboardShortcuts() {
    const undo = () => {
      this.options.session?.undo()
      return true
    }
    const redo = () => {
      this.options.session?.redo()
      return true
    }
    return {
      'Mod-z': undo,
      'Mod-Shift-z': redo,
      'Mod-y': redo,
      'Mod-Shift-v': () => {
        const view = this.editor.view
        void this.options.services?.readClipboardText().then((text) => {
          if (!view.isDestroyed) view.pasteText(text)
        })
        return true
      },
    }
  },
})
```

- [ ] **Step 4: Canvas components**

`packages/editor/src/StaticBox.tsx`:
```tsx
import { useLayoutEffect, useRef } from 'react'
import { LoroMap, type ContainerID, type LoroDoc } from 'loro-crdt'
import { schema } from './extensions'
import { renderStaticHtml } from './staticRender'

interface Props {
  doc: LoroDoc
  contentId: ContainerID
  onActivate: () => void
}

/** Lightweight rendering for off-screen boxes; becomes a real editor when scrolled into view or clicked. */
export function StaticBox({ doc, contentId, onActivate }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current!
    const render = () => {
      const fragment = renderStaticHtml(schema, doc, contentId, document)
      el.replaceChildren(...(fragment ? [fragment] : []))
    }
    render()
    const container = doc.getContainerById(contentId)
    return container instanceof LoroMap ? container.subscribe(render) : undefined
  }, [doc, contentId])
  return (
    <div
      ref={ref}
      className="slate-box-content"
      data-testid="box-static"
      onMouseDown={(e) => {
        e.preventDefault()
        onActivate()
      }}
    />
  )
}
```

`packages/editor/src/BoxEditor.tsx`:
```tsx
import { useEffect } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { loroSyncPluginKey } from 'loro-prosemirror'
import type { BoxState } from '@slate/core'
import { activeEditor } from './activeEditor'
import { buildExtensions } from './extensions'
import { SlateKeymap } from './keymap'
import { LoroBinding } from './loroBinding'
import type { PageSession } from './PageSession'
import { useEditorServices } from './services'

interface Props {
  box: BoxState
  session: PageSession
  autoFocus: boolean
  onFocus: () => void
}

export function BoxEditor({ box, session, autoFocus, onFocus }: Props) {
  const services = useEditorServices()
  const editor = useEditor(
    {
      extensions: [
        ...buildExtensions(),
        LoroBinding.configure({ doc: session.doc, containerId: box.contentId }),
        SlateKeymap.configure({ session, services }),
      ],
      enableInputRules: services.markdownShortcuts,
      enablePasteRules: false,
      autofocus: autoFocus ? 'end' : false,
      editorProps: {
        attributes: {
          class: 'slate-box-content',
          spellcheck: 'false',
          autocorrect: 'off',
          autocapitalize: 'off',
          'data-testid': 'box-editor',
        },
      },
      onUpdate: ({ transaction }) => {
        // Transactions from loro-prosemirror (initial load, remote changes, undo) carry its meta.
        if (!transaction.getMeta(loroSyncPluginKey)) session.noteLocalEdit(box.id)
      },
      onFocus: ({ editor: e }) => {
        activeEditor.set(e)
        onFocus()
      },
      onBlur: ({ editor: e }) => {
        if (e.isEmpty) session.page.deleteBox(box.id)
      },
    },
    [box.contentId, services.markdownShortcuts],
  )
  useEffect(
    () => () => {
      if (editor) activeEditor.clear(editor)
    },
    [editor],
  )
  return <EditorContent editor={editor} />
}
```

`packages/editor/src/Box.tsx`:
```tsx
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { BoxState } from '@slate/core'
import { BoxEditor } from './BoxEditor'
import type { PageSession } from './PageSession'
import { StaticBox } from './StaticBox'

const MIN_WIDTH = 120

interface Props {
  box: BoxState
  session: PageSession
  scrollRoot: HTMLElement
  autoFocus: boolean
  onFocus: () => void
}

type Gesture = { x: number; y: number; width: number }

export function Box({ box, session, scrollRoot, autoFocus, onFocus }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [gesture, setGesture] = useState<Gesture | null>(null)

  useEffect(() => {
    const io = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { root: scrollRoot, rootMargin: '600px 0px' })
    io.observe(ref.current!)
    return () => io.disconnect()
  }, [scrollRoot])

  useEffect(() => {
    const el = ref.current!
    const ro = new ResizeObserver(() => session.reportHeight(box.id, el.offsetHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [session, box.id])

  // Drop the local gesture override once the doc reflects the committed position.
  useEffect(() => setGesture(null), [box.x, box.y, box.width])

  const startGesture = (e: ReactPointerEvent<HTMLElement>, mode: 'move' | 'resize') => {
    e.preventDefault()
    e.stopPropagation()
    const target = e.currentTarget
    target.setPointerCapture(e.pointerId)
    const start = { px: e.clientX, py: e.clientY, x: box.x, y: box.y, width: box.width }
    let current: Gesture = { x: start.x, y: start.y, width: start.width }
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - start.px
      const dy = ev.clientY - start.py
      current =
        mode === 'move'
          ? { x: Math.max(0, start.x + dx), y: Math.max(0, start.y + dy), width: start.width }
          : { x: start.x, y: start.y, width: Math.max(MIN_WIDTH, start.width + dx) }
      setGesture(current)
    }
    const up = () => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
      if (mode === 'resize') session.noteLocalEdit(box.id)
      session.page.updateBox(box.id, { x: Math.round(current.x), y: Math.round(current.y), width: Math.round(current.width) })
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
  }

  const { x, y, width } = gesture ?? box
  return (
    <div ref={ref} className="slate-box" data-testid="box" data-box-id={box.id} style={{ left: x, top: y, width }}>
      <div className="slate-box-bar">
        <div className="slate-box-handle" data-testid="box-handle" onPointerDown={(e) => startGesture(e, 'move')} />
      </div>
      {visible || autoFocus ? (
        <BoxEditor box={box} session={session} autoFocus={autoFocus} onFocus={onFocus} />
      ) : (
        <StaticBox doc={session.doc} contentId={box.contentId} onActivate={onFocus} />
      )}
      <div className="slate-box-resize" data-testid="box-resize" onPointerDown={(e) => startGesture(e, 'resize')} />
    </div>
  )
}
```

`packages/editor/src/Canvas.tsx`:
```tsx
import { useState, useSyncExternalStore, type MouseEvent } from 'react'
import { Box } from './Box'
import type { PageSession } from './PageSession'
import './canvas.css'

export function Canvas({ session }: { session: PageSession }) {
  const boxes = useSyncExternalStore(session.subscribe, session.getBoxes)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null)

  const onMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || e.button !== 0) return
    e.preventDefault()
    const rect = e.currentTarget.getBoundingClientRect()
    setFocusId(session.createBox(Math.max(0, Math.round(e.clientX - rect.left)), Math.max(0, Math.round(e.clientY - rect.top))))
  }

  const bottom = boxes.reduce((max, b) => Math.max(max, b.y + (session.heightOf(b.id) ?? 0)), 0)
  const right = boxes.reduce((max, b) => Math.max(max, b.x + b.width), 0)
  return (
    <div className="slate-scroll" ref={setScrollRoot} data-testid="canvas-scroll">
      <div className="slate-canvas" data-testid="canvas" style={{ minHeight: bottom + 400, minWidth: right + 200 }} onMouseDown={onMouseDown}>
        {scrollRoot &&
          boxes.map((b) => (
            <Box key={b.id} box={b} session={session} scrollRoot={scrollRoot} autoFocus={b.id === focusId} onFocus={() => setFocusId(b.id)} />
          ))}
      </div>
    </div>
  )
}
```

`packages/editor/src/canvas.css`:
```css
.slate-scroll { flex: 1; overflow: auto; position: relative; }
.slate-canvas { position: relative; width: 100%; cursor: text; }
.slate-box { position: absolute; border: 1px solid transparent; border-radius: 4px; cursor: auto; }
.slate-box:hover, .slate-box:focus-within { border-color: var(--border); }
.slate-box-bar { position: absolute; top: -14px; left: -1px; right: -1px; height: 14px; display: flex; gap: 2px; opacity: 0; }
.slate-box:hover .slate-box-bar, .slate-box:focus-within .slate-box-bar { opacity: 1; }
.slate-box-handle { flex: 1; cursor: move; background: var(--panel-2); border-radius: 4px 4px 0 0; }
.slate-box-resize { position: absolute; top: 0; right: -5px; width: 9px; height: 100%; cursor: ew-resize; }
.slate-box-content { padding: 6px 8px; outline: none; min-height: 1.6em; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
.slate-box-content p { margin: 0; }
.slate-box-content h1, .slate-box-content h2, .slate-box-content h3 { margin: 0.2em 0; line-height: 1.25; }
.slate-box-content h1 { font-size: 1.6em; }
.slate-box-content h2 { font-size: 1.35em; }
.slate-box-content h3 { font-size: 1.15em; }
.slate-box-content ul, .slate-box-content ol { margin: 0; padding-left: 1.6em; }
.slate-box-content blockquote { margin: 0; padding-left: 10px; border-left: 3px solid var(--border); color: var(--muted); }
.slate-box-content code { font-family: ui-monospace, 'SF Mono', Menlo, Consolas, 'Ubuntu Mono', monospace; font-size: 0.92em; background: var(--panel-2); padding: 0 3px; border-radius: 3px; }
.slate-box-content pre { margin: 4px 0; padding: 8px 10px; border-radius: 4px; background: var(--panel); white-space: pre; overflow-x: auto; }
.slate-box-content pre code { background: none; padding: 0; font-size: 13px; }
.slate-box-content table { border-collapse: collapse; margin: 4px 0; }
.slate-box-content td, .slate-box-content th { border: 1px solid var(--border); padding: 4px 6px; min-width: 60px; vertical-align: top; }
.slate-box-content th { background: var(--panel); text-align: left; }
.slate-box-content img { max-width: 100%; display: block; }
.slate-box-content img.ProseMirror-selectednode { outline: 2px solid var(--accent); }
.slate-box-content .selectedCell { background: color-mix(in srgb, var(--accent) 20%, transparent); }
.hljs-keyword, .hljs-selector-tag, .hljs-built_in { color: #c792ea; }
.hljs-string, .hljs-attr { color: #c3e88d; }
.hljs-number, .hljs-literal { color: #f78c6c; }
.hljs-comment { color: #7f848e; font-style: italic; }
.hljs-title, .hljs-function { color: #82aaff; }
```

Replace `packages/editor/src/index.ts` with:
```ts
export * from './extensions'
export * from './clipboard'
export * from './content'
export * from './staticRender'
export * from './loroBinding'
export * from './PageSession'
export * from './activeEditor'
export * from './services'
export * from './keymap'
export * from './Canvas'
```

- [ ] **Step 5: Renderer — Library, current session, PageView, App**

Add `"@slate/editor": "*"` to `dependencies` in `packages/desktop/package.json`, then run `npm install`.

`packages/desktop/src/renderer/src/library.ts`:
```ts
import { NotebookDoc, newId } from '@slate/core'
import { pageDocId } from '@slate/editor'
import type { SlateApi } from '../../shared/api'

export const notebookDocId = (id: string): string => `notebook:${id}`

export interface NotebookEntry {
  id: string
  doc: NotebookDoc
  detach: () => void
}

/** All notebooks on this device, persisted through window.slate.docs. */
export class Library {
  private entries: NotebookEntry[] = []
  private listeners = new Set<() => void>()
  private version = 0

  private constructor(private readonly api: SlateApi) {}

  static async load(api: SlateApi): Promise<Library> {
    const library = new Library(api)
    for (const docId of await api.docs.list('notebook:')) {
      library.attach(docId.slice('notebook:'.length), NotebookDoc.fromUpdates(await api.docs.load(docId)))
    }
    if (library.entries.length === 0) library.createNotebook('My Notebook')
    return library
  }

  notebooks(): NotebookEntry[] {
    return [...this.entries].sort((a, b) => a.doc.name.localeCompare(b.doc.name))
  }

  createNotebook(name: string): NotebookEntry {
    const entry = this.attach(newId(), new NotebookDoc())
    entry.doc.rename(name)
    const section = entry.doc.addSection('Quick Notes')
    entry.doc.addPage(section, 'Untitled page')
    this.bump()
    return entry
  }

  async deleteNotebook(id: string): Promise<void> {
    const index = this.entries.findIndex((e) => e.id === id)
    if (index < 0) return
    const [entry] = this.entries.splice(index, 1)
    entry.detach()
    const pageIds = entry.doc.allPageIds()
    if (this.entries.length === 0) this.createNotebook('My Notebook')
    this.bump()
    await this.removePageDocs(pageIds)
    await this.api.docs.remove(notebookDocId(id))
  }

  async removePageDocs(pageIds: string[]): Promise<void> {
    await Promise.all(pageIds.map((p) => this.api.docs.remove(pageDocId(p))))
  }

  getVersion = (): number => this.version

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private attach(id: string, doc: NotebookDoc): NotebookEntry {
    const offUpdates = doc.doc.subscribeLocalUpdates((u) => void this.api.docs.append(notebookDocId(id), u))
    const offChanges = doc.doc.subscribe(() => this.bump())
    const entry = { id, doc, detach: () => (offUpdates(), offChanges()) }
    this.entries.push(entry)
    return entry
  }

  private bump(): void {
    this.version++
    this.listeners.forEach((l) => l())
  }
}
```

`packages/desktop/src/renderer/src/currentSession.ts`:
```ts
import type { PageSession } from '@slate/editor'

let current: PageSession | null = null

/** The page session on screen; menu commands (undo/redo) act on it. */
export const currentSession = {
  get: (): PageSession | null => current,
  set: (session: PageSession): void => {
    current = session
  },
  clear: (session: PageSession): void => {
    if (current === session) current = null
  },
}
```

`packages/desktop/src/renderer/src/PageView.tsx`:
```tsx
import { useEffect, useState } from 'react'
import { Canvas, PageSession } from '@slate/editor'
import { currentSession } from './currentSession'

export function PageView({ pageId }: { pageId: string }) {
  const [session, setSession] = useState<PageSession | null>(null)
  useEffect(() => {
    let opened: PageSession | null = null
    let cancelled = false
    void PageSession.open(pageId, window.slate.docs).then((s) => {
      if (cancelled) return s.close()
      opened = s
      currentSession.set(s)
      setSession(s)
    })
    return () => {
      cancelled = true
      if (opened) {
        currentSession.clear(opened)
        opened.close()
      }
    }
  }, [pageId])
  return <div className="page-view">{session && <Canvas session={session} />}</div>
}
```

`packages/desktop/src/renderer/src/App.tsx` (interim; Task 12 adds the sidebar):
```tsx
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { TreeItem } from '@slate/core'
import { activeEditor, EditorServicesContext, type EditorServices } from '@slate/editor'
import { DEFAULT_SETTINGS, type Settings } from '../../shared/api'
import { currentSession } from './currentSession'
import { Library } from './library'
import { PageView } from './PageView'

function firstPage(items: TreeItem[]): TreeItem | undefined {
  for (const item of items) {
    if (item.kind === 'page') return item
    const found = firstPage(item.children)
    if (found) return found
  }
  return undefined
}

export function useMenuCommands(setSettings: (s: Settings) => void): void {
  useEffect(
    () =>
      window.slate.onMenu((command) => {
        const el = document.activeElement
        const inField = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
        switch (command.cmd) {
          case 'undo':
            if (inField) document.execCommand('undo')
            else currentSession.get()?.undo()
            break
          case 'redo':
            if (inField) document.execCommand('redo')
            else currentSession.get()?.redo()
            break
          case 'paste-plain':
            void window.slate.clipboardText().then((text) => {
              const editor = activeEditor.get()
              if (inField) document.execCommand('insertText', false, text)
              else if (editor?.isFocused) editor.view.pasteText(text)
            })
            break
          case 'settings-changed':
            setSettings(command.settings)
            break
        }
      }),
    [setSettings],
  )
}

export function useServices(settings: Settings): EditorServices {
  return useMemo(
    () => ({
      putBlob: (bytes, mime) => window.slate.blobs.put(bytes, mime),
      copyImage: (url) => window.slate.blobs.copyImage(url),
      readClipboardText: () => window.slate.clipboardText(),
      markdownShortcuts: settings.markdownShortcuts,
    }),
    [settings.markdownShortcuts],
  )
}

export function App() {
  const [library, setLibrary] = useState<Library | null>(null)
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  useEffect(() => {
    void Library.load(window.slate).then(setLibrary)
    void window.slate.settings.get().then(setSettings)
  }, [])
  useMenuCommands(setSettings)
  const services = useServices(settings)
  if (!library) return <div className="app-loading">Loading…</div>
  return (
    <EditorServicesContext.Provider value={services}>
      <Interim library={library} />
    </EditorServicesContext.Provider>
  )
}

function Interim({ library }: { library: Library }) {
  useSyncExternalStore(library.subscribe, library.getVersion)
  const page = firstPage(library.notebooks()[0].doc.items())
  return <main className="app-main">{page?.pageId && <PageView key={page.pageId} pageId={page.pageId} />}</main>
}
```

Add to `packages/desktop/src/renderer/src/app.css`:
```css
.page-view { display: flex; flex-direction: column; flex: 1; min-height: 0; }
```

- [ ] **Step 6: Run the e2e tests**

Run: `npm run e2e -- canvas.spec.ts smoke.spec.ts`
Expected: all PASS.

If "undo reverts typing" fails because the sync plugin writes the undone state back as a new local change, that is the `doc-changed` path in `LoroSyncPlugin`. Fix it by passing a shared undo manager to `LoroUndoPlugin`:
- Add `LoroUndoPlugin({ doc, undoManager: session.undoManager })` to `LoroBinding`'s plugins.
- Point `SlateKeymap`'s undo/redo at loro-prosemirror's `undo`/`redo` commands (`undo(view.state, view.dispatch)`).
- Re-run.

- [ ] **Step 7: Run unit tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: free-form canvas with Loro-backed box editors, drag/resize and persistence"
```

---

### Task 10: Clean copy, clean paste, plain paste and images

**Files:**
- Create: `packages/editor/src/images.ts`
- Modify: `packages/editor/src/BoxEditor.tsx`, `packages/editor/src/Canvas.tsx`, `packages/editor/src/index.ts`
- Test: `packages/desktop/e2e/clipboard.spec.ts`

**Interfaces:**
- Consumes: `serializeSliceAsText`, `makeClipboardSerializer`, `cleanPastedHtml`, `schema` (Task 7); `EditorServices`, `activeEditor`, `PageSession.createBoxWithContent` (Tasks 8–9).
- Produces: `imageFilesFrom(data: DataTransfer | null): File[]`; `insertImages(view: EditorView, files: File[], putBlob: EditorServices['putBlob']): void`; `copySelectedImage(view: EditorView, event: ClipboardEvent, copyImage: EditorServices['copyImage']): boolean`.

- [ ] **Step 1: Write the failing e2e tests**

`packages/desktop/e2e/clipboard.spec.ts`:
```ts
import type { ElectronApplication, Page } from '@playwright/test'
import { expect, MOD, test } from './fixtures'

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

async function newBox(page: Page, x = 120, y = 120) {
  await page.getByTestId('canvas').click({ position: { x, y } })
  await expect(page.getByTestId('box-editor').last()).toBeFocused()
}
const copy = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.copy())
const paste = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.paste())
const clipboardText = (app: ElectronApplication) => app.evaluate(({ clipboard }) => clipboard.readText())

test('copying a nested numbered list gives real numbers and no stray characters', async ({ app, page }) => {
  await newBox(page)
  await page.keyboard.press(`${MOD}+Shift+7`)
  await page.keyboard.type('one')
  await page.keyboard.press('Enter')
  await page.keyboard.type('two')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Tab')
  await page.keyboard.type('a')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.type('three')
  await page.keyboard.press(`${MOD}+a`)
  await copy(app)
  await expect.poll(() => clipboardText(app)).toBe('1. one\n2. two\n  1. a\n3. three')
})

test('default paste keeps bold but drops source fonts, sizes and colours', async ({ app, page }) => {
  await newBox(page)
  await app.evaluate(({ clipboard }) =>
    clipboard.write({
      html: '<meta charset="utf-8"><p><span style="font-family:Comic Sans MS;color:red;font-size:30px">Hello</span> <b>world</b></p>',
      text: 'Hello world',
    }),
  )
  await paste(app)
  const editor = page.getByTestId('box-editor')
  await expect(editor).toContainText('Hello world')
  const html = await editor.innerHTML()
  expect(html).toContain('<strong>world</strong>')
  expect(html).not.toMatch(/font-family|font-size|color/)
})

test('Mod+Shift+V pastes plain text', async ({ app, page }) => {
  await newBox(page)
  await app.evaluate(({ clipboard }) => clipboard.write({ html: '<p><b>bold</b> text</p>', text: 'bold text' }))
  await page.keyboard.press(`${MOD}+Shift+V`)
  const editor = page.getByTestId('box-editor')
  await expect(editor).toContainText('bold text')
  expect(await editor.innerHTML()).not.toContain('<strong>')
})

test('pasted images are stored as blobs and can be copied back out', async ({ app, page }) => {
  await newBox(page)
  await app.evaluate(({ clipboard, nativeImage }, url) => clipboard.writeImage(nativeImage.createFromDataURL(url)), PNG)
  await paste(app)
  const img = page.locator('[data-testid="box-editor"] img')
  await expect(img).toHaveAttribute('src', /^slate-blob:\/\/blob\/[a-f0-9]{64}\.png$/)
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0)
  await app.evaluate(({ clipboard }) => clipboard.clear())
  await img.click()
  await copy(app)
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readImage().isEmpty())).toBe(false)
})

test('pasting with no box focused creates a new box', async ({ app, page }) => {
  await app.evaluate(({ clipboard }) => clipboard.writeText('line one\nline two'))
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await paste(app)
  await expect(page.getByTestId('box')).toHaveCount(1)
  await expect(page.getByTestId('box')).toContainText('line two')
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm run e2e -- clipboard.spec.ts`
Expected: FAIL — the list copies without numbers, the HTML paste keeps `font-family`, Mod+Shift+V keeps `<strong>`, and there's no image or new box.

- [ ] **Step 3: Image helpers**

`packages/editor/src/images.ts`:
```ts
import { NodeSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import type { EditorServices } from './services'

/** Image files on the clipboard. Ignored when there is text too (Office apps add a picture of copied text). */
export function imageFilesFrom(data: DataTransfer | null): File[] {
  if (!data || data.getData('text/plain').trim() !== '') return []
  return Array.from(data.files).filter((f) => f.type.startsWith('image/'))
}

export function insertImages(view: EditorView, files: File[], putBlob: EditorServices['putBlob']): void {
  void (async () => {
    for (const file of files) {
      const src = await putBlob(new Uint8Array(await file.arrayBuffer()), file.type)
      if (view.isDestroyed) return
      view.dispatch(view.state.tr.replaceSelectionWith(view.state.schema.nodes.image.create({ src })).scrollIntoView())
    }
  })()
}

/** Copying a selected image puts real image data on the clipboard, not an <img> pointing at slate-blob://. */
export function copySelectedImage(view: EditorView, event: ClipboardEvent, copyImage: EditorServices['copyImage']): boolean {
  const { selection } = view.state
  if (!(selection instanceof NodeSelection) || selection.node.type.name !== 'image') return false
  event.preventDefault()
  void copyImage(String(selection.node.attrs.src))
  return true
}
```

Append to `packages/editor/src/index.ts`:
```ts
export * from './images'
```

- [ ] **Step 4: Wire clipboard handling into BoxEditor**

In `packages/editor/src/BoxEditor.tsx`, add imports:
```tsx
import { cleanPastedHtml, makeClipboardSerializer, serializeSliceAsText } from './clipboard'
import { schema } from './extensions'
import { copySelectedImage, imageFilesFrom, insertImages } from './images'
```
Add a module-level constant below the imports:
```tsx
const clipboardSerializer = makeClipboardSerializer(schema)
```
Replace the `editorProps` object with:
```tsx
      editorProps: {
        attributes: {
          class: 'slate-box-content',
          spellcheck: 'false',
          autocorrect: 'off',
          autocapitalize: 'off',
          'data-testid': 'box-editor',
        },
        clipboardTextSerializer: serializeSliceAsText,
        clipboardSerializer,
        transformPastedHTML: cleanPastedHtml,
        handlePaste: (view, event) => {
          const files = imageFilesFrom(event.clipboardData)
          if (files.length === 0) return false
          event.preventDefault()
          insertImages(view, files, services.putBlob)
          return true
        },
        handleDOMEvents: {
          copy: (view, event) => copySelectedImage(view, event, services.copyImage),
        },
      },
```

- [ ] **Step 5: Paste onto an unfocused canvas creates a box**

In `packages/editor/src/Canvas.tsx`, add imports:
```tsx
import { useEffect } from 'react'
import type { PMJSON } from '@slate/core'
import { imageFilesFrom } from './images'
import { useEditorServices } from './services'
```
(merge `useEffect` into the existing `react` import).

Inside `Canvas`, after the `useState` calls, add:
```tsx
  const services = useEditorServices()
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.closest('.slate-box, input, textarea, [contenteditable="true"]')) return
      const top = (scrollRoot?.scrollTop ?? 0) + 40
      const files = imageFilesFrom(e.clipboardData)
      const text = e.clipboardData?.getData('text/plain') ?? ''
      if (files.length === 0 && text.trim() === '') return
      e.preventDefault()
      void (async () => {
        const blocks: PMJSON[] = files.length > 0
          ? await Promise.all(files.map(async (f) => ({ type: 'image', attrs: { src: await services.putBlob(new Uint8Array(await f.arrayBuffer()), f.type) } })))
          : text.replace(/\r\n?/g, '\n').split('\n').map((line) => ({ type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [] }))
        session.createBoxWithContent(40, top, blocks)
      })()
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [session, services, scrollRoot])
```

- [ ] **Step 6: Run the tests**

Run: `npm run e2e -- clipboard.spec.ts canvas.spec.ts && npm test && npm run typecheck`
Expected: all PASS. If `webContents.paste()` with nothing focused doesn't fire a `paste` event on `document`, change the last test to press `${MOD}+v` with the body focused. That's the path a real user takes.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(editor): developer-clean copy, structure-only paste, plain paste and image blobs"
```

---

### Task 11: Private boxes and auto-push end to end

**Files:**
- Modify: `packages/editor/src/Box.tsx`, `packages/editor/src/canvas.css`
- Test: `packages/desktop/e2e/layout.spec.ts`

**Interfaces:**
- Consumes: `PageDoc.updateBox(id, { private })` (Task 3); auto-push in `PageSession.reportHeight` (Task 8).
- Produces: test ids `box-lock`; `.slate-box.is-private` class; `aria-pressed` on the lock button.

- [ ] **Step 1: Write the failing e2e tests**

`packages/desktop/e2e/layout.spec.ts`:
```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, launchApp, test } from './fixtures'

async function newBox(page: Page, x: number, y: number, text: string) {
  await page.getByTestId('canvas').click({ position: { x, y } })
  await expect(page.getByTestId('box-editor').last()).toBeFocused()
  await page.keyboard.type(text)
}

test('a growing box pushes the box below it down', async ({ page }) => {
  await newBox(page, 40, 40, 'top box')
  await newBox(page, 60, 140, 'below')
  const top = page.getByTestId('box').filter({ hasText: 'top box' })
  const below = page.getByTestId('box').filter({ hasText: 'below' })
  const before = (await below.boundingBox())!.y
  await top.getByTestId('box-editor').click()
  await page.keyboard.press('End')
  for (let i = 0; i < 8; i++) await page.keyboard.press('Enter')
  await page.keyboard.type('more')
  await expect.poll(async () => (await below.boundingBox())!.y).toBeGreaterThan(before + 60)
  const topBox = (await top.boundingBox())!
  expect((await below.boundingBox())!.y).toBeGreaterThanOrEqual(topBox.y + topBox.height)
})

test('a box beside the growing box does not move', async ({ page }) => {
  await newBox(page, 40, 40, 'left')
  await newBox(page, 700, 100, 'right side')
  const right = page.getByTestId('box').filter({ hasText: 'right side' })
  const before = (await right.boundingBox())!.y
  await page.getByTestId('box').filter({ hasText: 'left' }).getByTestId('box-editor').click()
  for (let i = 0; i < 6; i++) await page.keyboard.press('Enter')
  await page.waitForTimeout(200)
  expect((await right.boundingBox())!.y).toBe(before)
})

test('the private flag toggles, is visible, and persists', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  const first = await launchApp(userData)
  await newBox(first.page, 100, 100, 'secret token')
  const box = first.page.getByTestId('box')
  await box.hover()
  await first.page.getByTestId('box-lock').click()
  await expect(box).toHaveClass(/is-private/)
  await expect(first.page.getByTestId('box-lock')).toHaveAttribute('aria-pressed', 'true')
  await first.page.waitForTimeout(300)
  await first.app.close()
  const second = await launchApp(userData)
  await expect(second.page.getByTestId('box')).toHaveClass(/is-private/)
  await second.app.close()
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm run e2e -- layout.spec.ts`
Expected: the two auto-push tests PASS (auto-push already exists from Task 8), and the private test FAILS (no `box-lock`). If an auto-push test fails, debug `reportHeight` with superpowers:systematic-debugging before going on.

- [ ] **Step 3: Add the lock toggle**

In `packages/editor/src/Box.tsx`, replace the `.slate-box-bar` element with:
```tsx
      <div className="slate-box-bar">
        <div className="slate-box-handle" data-testid="box-handle" onPointerDown={(e) => startGesture(e, 'move')} />
        <button
          type="button"
          className="slate-box-lock"
          data-testid="box-lock"
          aria-pressed={box.private}
          title={box.private ? 'Private: never shared with AI agents' : 'Mark private: hide from AI agents'}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => session.page.updateBox(box.id, { private: !box.private })}
        >
          <svg width="10" height="12" viewBox="0 0 10 12" aria-hidden="true">
            <rect x="1" y="5" width="8" height="6.5" rx="1" fill="currentColor" />
            <path d={box.private ? 'M2.5 5V3.5a2.5 2.5 0 0 1 5 0V5' : 'M2.5 5V3.5a2.5 2.5 0 0 1 5 0'} fill="none" stroke="currentColor" strokeWidth="1.3" />
          </svg>
        </button>
      </div>
```
and change the outer div's `className` to:
```tsx
className={box.private ? 'slate-box is-private' : 'slate-box'}
```

Append to `packages/editor/src/canvas.css`:
```css
.slate-box-lock { width: 22px; border: none; border-radius: 4px 4px 0 0; background: var(--panel-2); color: var(--muted); cursor: pointer; display: grid; place-items: center; padding: 0; }
.slate-box-lock[aria-pressed='true'] { color: #c9a227; }
.slate-box.is-private { border: 1px dashed #c9a227; background: repeating-linear-gradient(45deg, transparent 0 8px, rgb(201 162 39 / 0.07) 8px 16px); }
.slate-box.is-private .slate-box-bar { opacity: 1; }
```

- [ ] **Step 4: Run the tests**

Run: `npm run e2e -- layout.spec.ts canvas.spec.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(editor): per-box private flag with visible marker; auto-push e2e coverage"
```

---

### Task 12: Sidebar — notebooks, section groups, sections and pages

**Files:**
- Create: `packages/desktop/src/renderer/src/treeUtils.ts`, `packages/desktop/src/renderer/src/selection.ts`
- Create: `packages/desktop/src/renderer/src/sidebar/ContextMenu.tsx`, `InlineRename.tsx`, `dnd.ts`, `NotebookPicker.tsx`, `SectionList.tsx`, `PageList.tsx`
- Create: `packages/desktop/src/renderer/src/sidebar.css`
- Modify: `packages/desktop/src/renderer/src/App.tsx`, `packages/desktop/src/renderer/src/PageView.tsx`, `packages/desktop/src/renderer/src/main.tsx`
- Test: `packages/desktop/e2e/sidebar.spec.ts`

**Interfaces:**
- Consumes: `NotebookDoc`, `TreeItem`, `SECTION_COLORS` (Task 4); `Library`, `useMenuCommands`, `useServices` (Task 9).
- Produces:
  - `PageView({ nb, item }: { nb: NotebookDoc; item: TreeItem })`, with a title input (`page-title`).
  - Test ids: `notebook-picker`, `new-notebook`, `section-item`, `group-item`, `add-section`, `add-group`, `page-item`, `add-page`, `page-title`, `inline-rename`.

- [ ] **Step 1: Write the failing e2e tests**

`packages/desktop/e2e/sidebar.spec.ts`:
```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, launchApp, test } from './fixtures'

test('a new install has one notebook, section and page', async ({ page }) => {
  await expect(page.getByTestId('notebook-picker')).toContainText('My Notebook')
  await expect(page.getByTestId('section-item')).toHaveText(['Quick Notes'])
  await expect(page.getByTestId('page-item')).toHaveText(['Untitled page'])
})

test('sections and pages can be created, renamed and switched', async ({ page }) => {
  await page.getByTestId('add-section').click()
  await page.getByTestId('inline-rename').fill('Work')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('section-item')).toHaveText(['Quick Notes', 'Work'])
  await expect(page.getByTestId('page-item')).toHaveCount(1)

  await page.getByTestId('add-page').click()
  await page.getByTestId('page-title').fill('Second')
  await expect(page.getByTestId('page-item')).toHaveText(['Untitled page', 'Second'])

  await page.getByTestId('canvas').click({ position: { x: 100, y: 100 } })
  await page.keyboard.type('on second page')
  await page.getByTestId('page-item').filter({ hasText: 'Untitled page' }).click()
  await expect(page.getByTestId('box')).toHaveCount(0)
  await page.getByTestId('page-item').filter({ hasText: 'Second' }).click()
  await expect(page.getByTestId('box')).toContainText('on second page')
})

test('pages reorder by drag and delete with a confirming second click', async ({ page }) => {
  await page.getByTestId('add-page').click()
  await page.getByTestId('page-title').fill('B')
  await page.getByTestId('page-item').filter({ hasText: 'B' }).dragTo(page.getByTestId('page-item').first(), { targetPosition: { x: 10, y: 2 } })
  await expect(page.getByTestId('page-item')).toHaveText(['B', 'Untitled page'])

  await page.getByTestId('page-item').filter({ hasText: 'B' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await page.getByRole('menuitem', { name: /Click again/ }).click()
  await expect(page.getByTestId('page-item')).toHaveText(['Untitled page'])
})

test('pages can be indented as subpages', async ({ page }) => {
  await page.getByTestId('add-page').click()
  const sub = page.getByTestId('page-item').nth(1)
  await sub.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Make subpage' }).click()
  await expect(sub).toHaveAttribute('data-level', '1')
})

test('notebooks can be created and switched; structure persists', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  const first = await launchApp(userData)
  await first.page.getByTestId('notebook-picker').click()
  await first.page.getByTestId('new-notebook').click()
  await first.page.getByTestId('inline-rename').fill('Climbing')
  await first.page.keyboard.press('Enter')
  await expect(first.page.getByTestId('notebook-picker')).toContainText('Climbing')
  await first.page.getByTestId('add-section').click()
  await first.page.getByTestId('inline-rename').fill('Routes')
  await first.page.keyboard.press('Enter')
  await first.page.waitForTimeout(300)
  await first.app.close()

  const second = await launchApp(userData)
  await expect(second.page.getByTestId('notebook-picker')).toContainText('Climbing')
  await expect(second.page.getByTestId('section-item')).toHaveText(['Quick Notes', 'Routes'])
  await second.app.close()
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm run e2e -- sidebar.spec.ts`
Expected: FAIL — no `notebook-picker`.

- [ ] **Step 3: Tree utilities and selection persistence**

`packages/desktop/src/renderer/src/treeUtils.ts`:
```ts
import type { NodeKind, TreeItem } from '@slate/core'

export function findItem(items: TreeItem[], id: string | null): TreeItem | undefined {
  if (!id) return undefined
  for (const item of items) {
    if (item.id === id) return item
    const found = findItem(item.children, id)
    if (found) return found
  }
  return undefined
}

export function firstOfKind(items: TreeItem[], kind: NodeKind): TreeItem | undefined {
  for (const item of items) {
    if (item.kind === kind) return item
    const found = firstOfKind(item.children, kind)
    if (found) return found
  }
  return undefined
}

export const cls = (...names: Array<string | false | null | undefined>): string => names.filter(Boolean).join(' ')
```

`packages/desktop/src/renderer/src/selection.ts`:
```ts
export interface Selection {
  notebookId: string | null
  sectionId: string | null
  pageId: string | null
}

const KEY = 'slate:selection'
const EMPTY: Selection = { notebookId: null, sectionId: null, pageId: null }

/** Last opened notebook/section/page — a per-device convenience, so localStorage is fine. */
export function loadSelection(): Selection {
  try {
    return { ...EMPTY, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Selection>) }
  } catch {
    return EMPTY
  }
}

export function saveSelection(selection: Selection): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(selection))
  } catch {
    // Storage unavailable: selection just won't be remembered.
  }
}
```

- [ ] **Step 4: Shared sidebar pieces**

`packages/desktop/src/renderer/src/sidebar/ContextMenu.tsx`:
```tsx
import { useEffect, useRef, useState } from 'react'

export type MenuItem =
  | { label: string; onSelect: () => void; confirm?: boolean }
  | { swatches: readonly string[]; onPick: (color: string) => void }

export interface MenuState {
  x: number
  y: number
  items: MenuItem[]
}

/** In-app context menu. Destructive items need a second click instead of a blocking dialog. */
export function ContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [armed, setArmed] = useState<string | null>(null)
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', down)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('mousedown', down)
      window.removeEventListener('keydown', key)
    }
  }, [onClose])
  return (
    <div ref={ref} className="context-menu" style={{ left: menu.x, top: menu.y }} role="menu">
      {menu.items.map((item, i) =>
        'swatches' in item ? (
          <div key={i} className="swatches">
            {item.swatches.map((c) => (
              <button
                key={c}
                type="button"
                className="swatch"
                style={{ background: c }}
                aria-label={`Colour ${c}`}
                onClick={() => {
                  item.onPick(c)
                  onClose()
                }}
              />
            ))}
          </div>
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={item.confirm ? 'danger' : undefined}
            onClick={() => {
              if (item.confirm && armed !== item.label) return setArmed(item.label)
              item.onSelect()
              onClose()
            }}
          >
            {item.confirm && armed === item.label ? `Click again to ${item.label.toLowerCase()}` : item.label}
          </button>
        ),
      )}
    </div>
  )
}
```

`packages/desktop/src/renderer/src/sidebar/InlineRename.tsx`:
```tsx
import { useState } from 'react'

interface Props {
  value: string
  onCommit: (value: string) => void
  onCancel: () => void
}

export function InlineRename({ value, onCommit, onCancel }: Props) {
  const [text, setText] = useState(value)
  const commit = () => onCommit(text.trim() || value)
  return (
    <input
      className="inline-rename"
      data-testid="inline-rename"
      autoFocus
      spellCheck={false}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => e.target.select()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') onCancel()
      }}
      onBlur={commit}
      onClick={(e) => e.stopPropagation()}
    />
  )
}
```

`packages/desktop/src/renderer/src/sidebar/dnd.ts`:
```ts
import type { DragEvent } from 'react'
import type { NotebookDoc, TreeItem } from '@slate/core'

export const DRAG_MIME = 'application/x-slate-node'
export type DropZone = 'before' | 'after' | 'inside'

export function dropZone(e: DragEvent<HTMLElement>, allowInside: boolean): DropZone {
  const rect = e.currentTarget.getBoundingClientRect()
  const f = (e.clientY - rect.top) / rect.height
  if (allowInside && f > 0.25 && f < 0.75) return 'inside'
  return f < 0.5 ? 'before' : 'after'
}

export function applyDrop(nb: NotebookDoc, draggedId: string, target: TreeItem, zone: DropZone): void {
  if (draggedId === target.id) return
  try {
    if (zone === 'inside') nb.moveInto(draggedId, target.id)
    else if (zone === 'before') nb.moveBefore(draggedId, target.id)
    else nb.moveAfter(draggedId, target.id)
  } catch {
    // Invalid placement (e.g. a page dropped beside a section, a group into itself): leave the tree unchanged.
  }
}
```

- [ ] **Step 5: NotebookPicker, SectionList, PageList**

`packages/desktop/src/renderer/src/sidebar/NotebookPicker.tsx`:
```tsx
import { useState } from 'react'
import type { Library, NotebookEntry } from '../library'
import { cls } from '../treeUtils'
import { InlineRename } from './InlineRename'

interface Props {
  library: Library
  current: NotebookEntry
  onSelect: (notebookId: string) => void
}

export function NotebookPicker({ library, current, onSelect }: Props) {
  const [open, setOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [armedDelete, setArmedDelete] = useState(false)
  const close = () => {
    setOpen(false)
    setArmedDelete(false)
  }
  return (
    <div className="notebook-picker">
      {renaming ? (
        <InlineRename
          value={current.doc.name}
          onCommit={(name) => {
            current.doc.rename(name)
            setRenaming(false)
          }}
          onCancel={() => setRenaming(false)}
        />
      ) : (
        <button type="button" className="notebook-current" data-testid="notebook-picker" onClick={() => setOpen((o) => !o)}>
          <span className="label">{current.doc.name}</span>
          <span className="chevron">▾</span>
        </button>
      )}
      {open && (
        <div className="notebook-menu" role="menu">
          {library.notebooks().map((n) => (
            <button
              key={n.id}
              type="button"
              role="menuitem"
              className={cls(n.id === current.id && 'selected')}
              onClick={() => {
                onSelect(n.id)
                close()
              }}
            >
              {n.doc.name}
            </button>
          ))}
          <hr />
          <button
            type="button"
            role="menuitem"
            data-testid="new-notebook"
            onClick={() => {
              onSelect(library.createNotebook('New notebook').id)
              close()
              setRenaming(true)
            }}
          >
            New notebook
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              close()
              setRenaming(true)
            }}
          >
            Rename notebook
          </button>
          <button
            type="button"
            role="menuitem"
            className="danger"
            onClick={() => {
              if (!armedDelete) return setArmedDelete(true)
              void library.deleteNotebook(current.id)
              close()
            }}
          >
            {armedDelete ? 'Click again to delete notebook' : 'Delete notebook'}
          </button>
        </div>
      )}
    </div>
  )
}
```

`packages/desktop/src/renderer/src/sidebar/SectionList.tsx`:
```tsx
import { useState, type MouseEvent, type ReactNode } from 'react'
import { SECTION_COLORS, type NotebookDoc, type TreeItem } from '@slate/core'
import { cls } from '../treeUtils'
import { ContextMenu, type MenuItem, type MenuState } from './ContextMenu'
import { applyDrop, DRAG_MIME, dropZone, type DropZone } from './dnd'
import { InlineRename } from './InlineRename'

interface Props {
  nb: NotebookDoc
  items: TreeItem[]
  selectedSectionId: string | null
  onSelect: (sectionId: string) => void
  onDeleted: (pageIds: string[]) => void
}

export function SectionList({ nb, items, selectedSectionId, onSelect, onDeleted }: Props) {
  const [renaming, setRenaming] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [hint, setHint] = useState<{ id: string; zone: DropZone } | null>(null)

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })

  const addSection = (parent?: string) => {
    const id = nb.addSection('New section', parent)
    nb.addPage(id)
    onSelect(id)
    setRenaming(id)
  }

  const openMenu = (e: MouseEvent, item: TreeItem) => {
    e.preventDefault()
    const entries: MenuItem[] = [{ label: 'Rename', onSelect: () => setRenaming(item.id) }]
    if (item.kind === 'section') entries.push({ swatches: SECTION_COLORS, onPick: (c) => nb.setColor(item.id, c) })
    if (item.kind === 'sectionGroup') entries.push({ label: 'New section in group', onSelect: () => addSection(item.id) })
    entries.push({ label: 'Delete', confirm: true, onSelect: () => onDeleted(nb.delete(item.id)) })
    setMenu({ x: e.clientX, y: e.clientY, items: entries })
  }

  const renderItem = (item: TreeItem, depth: number): ReactNode => {
    if (item.kind === 'page') return null
    const isGroup = item.kind === 'sectionGroup'
    const open = !collapsed.has(item.id)
    return (
      <li key={item.id}>
        <div
          className={cls('tree-row', item.id === selectedSectionId && 'selected', hint?.id === item.id && `drop-${hint.zone}`)}
          data-testid={isGroup ? 'group-item' : 'section-item'}
          style={{ paddingLeft: 8 + depth * 14 }}
          draggable
          onDragStart={(e) => e.dataTransfer.setData(DRAG_MIME, item.id)}
          onDragOver={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setHint({ id: item.id, zone: dropZone(e, isGroup) })
          }}
          onDragLeave={() => setHint(null)}
          onDrop={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setHint(null)
            const dragged = e.dataTransfer.getData(DRAG_MIME)
            if (!dragged) return
            const zone = nb.get(dragged)?.kind === 'page' ? 'inside' : dropZone(e, isGroup)
            applyDrop(nb, dragged, item, zone)
          }}
          onClick={() => (isGroup ? toggle(item.id) : onSelect(item.id))}
          onDoubleClick={() => setRenaming(item.id)}
          onContextMenu={(e) => openMenu(e, item)}
        >
          {isGroup ? <span className="chevron">{open ? '▾' : '▸'}</span> : <span className="color-bar" style={{ background: item.color ?? SECTION_COLORS[0] }} />}
          {renaming === item.id ? (
            <InlineRename
              value={item.title}
              onCommit={(title) => {
                nb.setTitle(item.id, title)
                setRenaming(null)
              }}
              onCancel={() => setRenaming(null)}
            />
          ) : (
            <span className="label">{item.title}</span>
          )}
        </div>
        {isGroup && open && <ul>{item.children.map((c) => renderItem(c, depth + 1))}</ul>}
      </li>
    )
  }

  return (
    <div className="sidebar-col">
      <ul
        className="tree"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          // Dropped on empty space: move the section/group to the end of the notebook root.
          const dragged = e.dataTransfer.getData(DRAG_MIME)
          if (dragged && nb.get(dragged)?.kind !== 'page') {
            try {
              nb.moveInto(dragged, undefined)
            } catch {
              // not movable to root
            }
          }
        }}
      >
        {items.map((i) => renderItem(i, 0))}
      </ul>
      <div className="sidebar-actions">
        <button type="button" data-testid="add-section" onClick={() => addSection()}>
          Add section
        </button>
        <button type="button" className="secondary" data-testid="add-group" onClick={() => setRenaming(nb.addSectionGroup('New group'))}>
          Add group
        </button>
      </div>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  )
}
```

`packages/desktop/src/renderer/src/sidebar/PageList.tsx`:
```tsx
import { useState, type MouseEvent } from 'react'
import type { NotebookDoc, TreeItem } from '@slate/core'
import { cls } from '../treeUtils'
import { ContextMenu, type MenuState } from './ContextMenu'
import { applyDrop, DRAG_MIME, dropZone, type DropZone } from './dnd'
import { InlineRename } from './InlineRename'

interface Props {
  nb: NotebookDoc
  section: TreeItem | undefined
  selectedPageId: string | null
  onSelect: (pageTreeId: string) => void
  onDeleted: (pageIds: string[]) => void
}

export function PageList({ nb, section, selectedPageId, onSelect, onDeleted }: Props) {
  const [renaming, setRenaming] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [hint, setHint] = useState<{ id: string; zone: DropZone } | null>(null)
  const pages = section?.children.filter((c) => c.kind === 'page') ?? []

  const openMenu = (e: MouseEvent, page: TreeItem) => {
    e.preventDefault()
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Rename', onSelect: () => setRenaming(page.id) },
        { label: 'Make subpage', onSelect: () => nb.setLevel(page.id, page.level + 1) },
        { label: 'Promote subpage', onSelect: () => nb.setLevel(page.id, page.level - 1) },
        { label: 'Delete', confirm: true, onSelect: () => onDeleted(nb.delete(page.id)) },
      ],
    })
  }

  return (
    <div className="sidebar-col">
      <ul className="tree">
        {pages.map((page) => (
          <li key={page.id}>
            <div
              className={cls('tree-row', 'page-row', page.id === selectedPageId && 'selected', hint?.id === page.id && `drop-${hint.zone}`)}
              data-testid="page-item"
              data-level={page.level}
              style={{ paddingLeft: 12 + page.level * 16 }}
              draggable
              onDragStart={(e) => e.dataTransfer.setData(DRAG_MIME, page.id)}
              onDragOver={(e) => {
                e.preventDefault()
                setHint({ id: page.id, zone: dropZone(e, false) })
              }}
              onDragLeave={() => setHint(null)}
              onDrop={(e) => {
                e.preventDefault()
                setHint(null)
                const dragged = e.dataTransfer.getData(DRAG_MIME)
                if (dragged) applyDrop(nb, dragged, page, dropZone(e, false))
              }}
              onClick={() => onSelect(page.id)}
              onDoubleClick={() => setRenaming(page.id)}
              onContextMenu={(e) => openMenu(e, page)}
            >
              {renaming === page.id ? (
                <InlineRename
                  value={page.title}
                  onCommit={(title) => {
                    nb.setTitle(page.id, title)
                    setRenaming(null)
                  }}
                  onCancel={() => setRenaming(null)}
                />
              ) : (
                <span className="label">{page.title || 'Untitled page'}</span>
              )}
            </div>
          </li>
        ))}
      </ul>
      {section && (
        <div className="sidebar-actions">
          <button type="button" data-testid="add-page" onClick={() => onSelect(nb.addPage(section.id).id)}>
            Add page
          </button>
        </div>
      )}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  )
}
```

- [ ] **Step 6: PageView with a title, and App with the workspace**

Replace `packages/desktop/src/renderer/src/PageView.tsx` with:
```tsx
import { useEffect, useRef, useState } from 'react'
import type { NotebookDoc, TreeItem } from '@slate/core'
import { Canvas, PageSession } from '@slate/editor'
import { currentSession } from './currentSession'

export function PageView({ nb, item }: { nb: NotebookDoc; item: TreeItem }) {
  const pageId = item.pageId!
  const [session, setSession] = useState<PageSession | null>(null)
  const [title, setTitle] = useState(item.title)
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    // Follow renames from the sidebar, but never fight the user while they type here.
    if (document.activeElement !== titleRef.current) setTitle(item.title)
  }, [item.title])

  useEffect(() => {
    let opened: PageSession | null = null
    let cancelled = false
    void PageSession.open(pageId, window.slate.docs).then((s) => {
      if (cancelled) return s.close()
      opened = s
      currentSession.set(s)
      setSession(s)
    })
    return () => {
      cancelled = true
      if (opened) {
        currentSession.clear(opened)
        opened.close()
      }
    }
  }, [pageId])

  return (
    <div className="page-view">
      <input
        ref={titleRef}
        className="page-title"
        data-testid="page-title"
        placeholder="Untitled page"
        spellCheck={false}
        value={title}
        onChange={(e) => {
          setTitle(e.target.value)
          nb.setTitle(item.id, e.target.value)
        }}
      />
      {session && <Canvas session={session} />}
    </div>
  )
}
```

Replace `packages/desktop/src/renderer/src/App.tsx` with:
```tsx
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { activeEditor, EditorServicesContext, type EditorServices } from '@slate/editor'
import { DEFAULT_SETTINGS, type Settings } from '../../shared/api'
import { currentSession } from './currentSession'
import { Library } from './library'
import { PageView } from './PageView'
import { loadSelection, saveSelection, type Selection } from './selection'
import { NotebookPicker } from './sidebar/NotebookPicker'
import { PageList } from './sidebar/PageList'
import { SectionList } from './sidebar/SectionList'
import { findItem, firstOfKind } from './treeUtils'

export function useMenuCommands(setSettings: (s: Settings) => void): void {
  useEffect(
    () =>
      window.slate.onMenu((command) => {
        const el = document.activeElement
        const inField = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
        switch (command.cmd) {
          case 'undo':
            if (inField) document.execCommand('undo')
            else currentSession.get()?.undo()
            break
          case 'redo':
            if (inField) document.execCommand('redo')
            else currentSession.get()?.redo()
            break
          case 'paste-plain':
            void window.slate.clipboardText().then((text) => {
              const editor = activeEditor.get()
              if (inField) document.execCommand('insertText', false, text)
              else if (editor?.isFocused) editor.view.pasteText(text)
            })
            break
          case 'settings-changed':
            setSettings(command.settings)
            break
        }
      }),
    [setSettings],
  )
}

export function useServices(settings: Settings): EditorServices {
  return useMemo(
    () => ({
      putBlob: (bytes, mime) => window.slate.blobs.put(bytes, mime),
      copyImage: (url) => window.slate.blobs.copyImage(url),
      readClipboardText: () => window.slate.clipboardText(),
      markdownShortcuts: settings.markdownShortcuts,
    }),
    [settings.markdownShortcuts],
  )
}

export function App() {
  const [library, setLibrary] = useState<Library | null>(null)
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  useEffect(() => {
    void Library.load(window.slate).then(setLibrary)
    void window.slate.settings.get().then(setSettings)
  }, [])
  useMenuCommands(setSettings)
  const services = useServices(settings)
  if (!library) return <div className="app-loading">Loading…</div>
  return (
    <EditorServicesContext.Provider value={services}>
      <Workspace library={library} />
    </EditorServicesContext.Provider>
  )
}

function Workspace({ library }: { library: Library }) {
  useSyncExternalStore(library.subscribe, library.getVersion)
  const [selection, setSelection] = useState<Selection>(loadSelection)
  const notebooks = library.notebooks()
  const entry = notebooks.find((n) => n.id === selection.notebookId) ?? notebooks[0]
  const items = entry.doc.items()
  const sectionCandidate = findItem(items, selection.sectionId)
  const section = sectionCandidate?.kind === 'section' ? sectionCandidate : firstOfKind(items, 'section')
  const pages = section?.children.filter((c) => c.kind === 'page') ?? []
  const page = pages.find((p) => p.id === selection.pageId) ?? pages[0]

  useEffect(() => {
    saveSelection({ notebookId: entry.id, sectionId: section?.id ?? null, pageId: page?.id ?? null })
  }, [entry.id, section?.id, page?.id])

  const removeDocs = (pageIds: string[]) => void library.removePageDocs(pageIds)

  return (
    <div className="app">
      <aside className="sidebar">
        <NotebookPicker library={library} current={entry} onSelect={(id) => setSelection({ notebookId: id, sectionId: null, pageId: null })} />
        <div className="sidebar-cols">
          <SectionList
            nb={entry.doc}
            items={items}
            selectedSectionId={section?.id ?? null}
            onSelect={(id) => setSelection({ notebookId: entry.id, sectionId: id, pageId: null })}
            onDeleted={removeDocs}
          />
          <PageList
            nb={entry.doc}
            section={section}
            selectedPageId={page?.id ?? null}
            onSelect={(id) => setSelection({ notebookId: entry.id, sectionId: section?.id ?? null, pageId: id })}
            onDeleted={removeDocs}
          />
        </div>
      </aside>
      <main className="app-main">
        {page?.pageId ? <PageView key={page.pageId} nb={entry.doc} item={page} /> : <div className="empty">No page selected</div>}
      </main>
    </div>
  )
}
```

In `packages/desktop/src/renderer/src/main.tsx`, add below `import './app.css'`:
```tsx
import './sidebar.css'
```

`packages/desktop/src/renderer/src/sidebar.css`:
```css
.sidebar { display: flex; flex-direction: column; width: 520px; min-height: 0; background: var(--panel); border-right: 1px solid var(--border); }
.notebook-picker { position: relative; padding: 10px 12px; border-bottom: 1px solid var(--border); }
.notebook-current { display: flex; align-items: center; gap: 6px; width: 100%; background: none; border: none; color: var(--text); font: inherit; font-weight: 600; font-size: 15px; cursor: pointer; text-align: left; }
.notebook-current .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.notebook-menu, .context-menu { position: absolute; z-index: 20; min-width: 220px; padding: 4px; background: var(--panel-2); border: 1px solid var(--border); border-radius: 6px; box-shadow: 0 6px 24px rgb(0 0 0 / 0.35); display: flex; flex-direction: column; }
.notebook-menu { top: 100%; left: 12px; }
.context-menu { position: fixed; }
.notebook-menu button, .context-menu button[role='menuitem'] { background: none; border: none; color: var(--text); font: inherit; text-align: left; padding: 6px 10px; border-radius: 4px; cursor: pointer; }
.notebook-menu button:hover, .context-menu button[role='menuitem']:hover { background: var(--hover); }
.notebook-menu button.selected { background: var(--selected); }
.notebook-menu hr { border: none; border-top: 1px solid var(--border); margin: 4px 0; width: 100%; }
.danger { color: var(--danger) !important; }
.swatches { display: flex; gap: 6px; padding: 6px 10px; }
.swatch { width: 18px; height: 18px; border-radius: 50%; border: 1px solid var(--border); cursor: pointer; padding: 0; }
.sidebar-cols { display: grid; grid-template-columns: 1fr 1fr; flex: 1; min-height: 0; }
.sidebar-col { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--border); }
.sidebar-col:last-child { border-right: none; }
.tree { list-style: none; margin: 0; padding: 4px 0; overflow-y: auto; flex: 1; }
.tree ul { list-style: none; margin: 0; padding: 0; }
.tree-row { display: flex; align-items: center; gap: 10px; height: 34px; padding-right: 8px; cursor: pointer; user-select: none; border-top: 2px solid transparent; border-bottom: 2px solid transparent; }
.tree-row:hover { background: var(--hover); }
.tree-row.selected { background: var(--selected); }
.tree-row.drop-before { border-top-color: var(--accent); }
.tree-row.drop-after { border-bottom-color: var(--accent); }
.tree-row.drop-inside { outline: 1px solid var(--accent); outline-offset: -1px; }
.tree-row .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.color-bar { width: 6px; height: 22px; border-radius: 3px; flex: none; }
.chevron { width: 12px; color: var(--muted); flex: none; }
.inline-rename { flex: 1; min-width: 0; font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--accent); border-radius: 3px; padding: 2px 4px; }
.sidebar-actions { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--border); }
.sidebar-actions button { background: none; border: none; color: var(--accent); font: inherit; font-weight: 600; cursor: pointer; padding: 4px 0; }
.sidebar-actions button.secondary { color: var(--muted); font-weight: 400; }
.page-title { margin: 18px 24px 8px; padding: 2px 0; font: inherit; font-size: 24px; font-weight: 600; color: var(--text); background: none; border: none; border-bottom: 1px solid var(--border); outline: none; max-width: 640px; }
```

- [ ] **Step 7: Run all e2e tests**

Run: `npm run e2e`
Expected: all PASS. Two earlier tests click at canvas coordinates that are now relative to a canvas below the title input. That still works because `click({ position })` is relative to the canvas element. If `dragTo` doesn't trigger HTML5 drag events, swap it for the manual sequence: `hover()` the source → `page.mouse.down()` → `hover()` the target at `{ position: { x: 10, y: 2 } }` → `page.mouse.up()`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(desktop): notebook/section/page sidebar with groups, colours, subpages and drag reorder"
```

---

### Task 13: Formatting toolbar and the Markdown Shortcuts setting

**Files:**
- Create: `packages/desktop/src/renderer/src/Toolbar.tsx`, `packages/desktop/src/renderer/src/toolbar.css`
- Modify: `packages/desktop/src/renderer/src/App.tsx`, `packages/desktop/src/renderer/src/main.tsx`
- Test: `packages/desktop/e2e/formatting.spec.ts`

**Interfaces:**
- Consumes: `activeEditor` (Task 9); TipTap v3 commands `toggleBold`, `toggleItalic`, `toggleUnderline`, `toggleStrike`, `toggleCode`, `toggleHeading`, `toggleBulletList`, `toggleOrderedList`, `toggleCodeBlock`, `insertTable`, `addRowAfter`, `addColumnAfter`, `deleteRow`, `deleteColumn`, `deleteTable`, `setColor`, `toggleHighlight`, `setFontFamily`, `unsetFontFamily`, `setFontSize`, `unsetFontSize`, `unsetAllMarks`.
- Produces: test ids `tb-bold`, `tb-italic`, `tb-underline`, `tb-strike`, `tb-code`, `tb-h1`, `tb-h2`, `tb-h3`, `tb-bullet`, `tb-ordered`, `tb-codeblock`, `tb-table`, `tb-font`, `tb-size`, `tb-color`, `tb-highlight`, `tb-clear`; a menu item with id `markdown-shortcuts`.

- [ ] **Step 1: Write the failing e2e tests**

`packages/desktop/e2e/formatting.spec.ts`:
```ts
import type { Page } from '@playwright/test'
import { expect, MOD, test } from './fixtures'

async function typeInNewBox(page: Page, text: string, x = 120, y = 120) {
  await page.getByTestId('canvas').click({ position: { x, y } })
  await expect(page.getByTestId('box-editor').last()).toBeFocused()
  await page.keyboard.type(text)
}

test('toolbar applies marks, headings, lists, tables and fonts', async ({ page }) => {
  await typeInNewBox(page, 'format me')
  const editor = page.getByTestId('box-editor')
  await page.keyboard.press(`${MOD}+a`)
  await page.getByTestId('tb-bold').click()
  await expect(editor.locator('strong')).toHaveText('format me')
  await page.getByTestId('tb-font').selectOption('monospace')
  await expect(editor.locator('span[style*="font-family"]')).toHaveCount(1)
  await page.getByTestId('tb-h1').click()
  await expect(editor.locator('h1')).toHaveText('format me')
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.getByTestId('tb-ordered').click()
  await page.keyboard.type('item')
  await expect(editor.locator('ol > li')).toHaveText('item')
  await page.getByTestId('tb-table').click()
  await expect(editor.locator('table td')).toHaveCount(9)
})

test('typing markdown-like text does not auto-format by default', async ({ page }) => {
  await typeInNewBox(page, '1. not a list')
  const editor = page.getByTestId('box-editor')
  await expect(editor.locator('ol')).toHaveCount(0)
  await expect(editor).toHaveText('1. not a list')
})

test('Markdown Shortcuts setting turns on input rules', async ({ app, page }) => {
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('markdown-shortcuts')!.click())
  await typeInNewBox(page, '1. now a list', 120, 300)
  await expect(page.getByTestId('box-editor').last().locator('ol > li')).toHaveText('now a list')
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm run e2e -- formatting.spec.ts`
Expected: test 1 FAILS (no toolbar). Test 2 PASSES (input rules are already off). Test 3 may PASS already, since the menu and settings plumbing came in Task 6. That's fine; it's a guard.

- [ ] **Step 3: Toolbar**

`packages/desktop/src/renderer/src/Toolbar.tsx`:
```tsx
import { useEffect, useReducer, useSyncExternalStore, type ReactNode } from 'react'
import type { ChainedCommands, Editor } from '@tiptap/core'
import { activeEditor } from '@slate/editor'

const FONTS = [
  { label: 'Default font', value: '' },
  { label: 'Sans', value: 'system-ui, sans-serif' },
  { label: 'Serif', value: 'Georgia, serif' },
  { label: 'Mono', value: 'monospace' },
]
const SIZES = ['', '12px', '14px', '16px', '18px', '24px', '32px']

function useActiveEditor(): Editor | null {
  const editor = useSyncExternalStore(activeEditor.subscribe, activeEditor.get)
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    if (!editor) return
    editor.on('transaction', rerender)
    return () => {
      editor.off('transaction', rerender)
    }
  }, [editor])
  return editor && !editor.isDestroyed ? editor : null
}

export function Toolbar() {
  const editor = useActiveEditor()
  const run = (fn: (chain: ChainedCommands) => ChainedCommands) => () => {
    if (editor) fn(editor.chain().focus()).run()
  }
  const button = (id: string, label: ReactNode, title: string, active: boolean, onClick: () => void) => (
    <button
      type="button"
      data-testid={`tb-${id}`}
      title={title}
      aria-pressed={active}
      disabled={!editor}
      className={active ? 'active' : undefined}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {label}
    </button>
  )
  const is = (name: string, attrs?: Record<string, unknown>) => editor?.isActive(name, attrs) ?? false
  const textStyle = (editor?.getAttributes('textStyle') ?? {}) as { fontFamily?: string; fontSize?: string; color?: string }

  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting">
      {button('bold', <b>B</b>, 'Bold (Mod+B)', is('bold'), run((c) => c.toggleBold()))}
      {button('italic', <i>I</i>, 'Italic (Mod+I)', is('italic'), run((c) => c.toggleItalic()))}
      {button('underline', <u>U</u>, 'Underline (Mod+U)', is('underline'), run((c) => c.toggleUnderline()))}
      {button('strike', <s>S</s>, 'Strikethrough', is('strike'), run((c) => c.toggleStrike()))}
      {button('code', '</>', 'Inline code (Mod+E)', is('code'), run((c) => c.toggleCode()))}
      <span className="sep" />
      {([1, 2, 3] as const).map((level) => (
        <span key={level}>{button(`h${level}`, `H${level}`, `Heading ${level}`, is('heading', { level }), run((c) => c.toggleHeading({ level })))}</span>
      ))}
      <span className="sep" />
      {button('bullet', '•', 'Bulleted list (Mod+Shift+8)', is('bulletList'), run((c) => c.toggleBulletList()))}
      {button('ordered', '1.', 'Numbered list (Mod+Shift+7)', is('orderedList'), run((c) => c.toggleOrderedList()))}
      {button('codeblock', '{ }', 'Code block (Mod+Alt+C)', is('codeBlock'), run((c) => c.toggleCodeBlock()))}
      {button('table', '▦', 'Insert table', false, run((c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: false })))}
      {is('table') && (
        <>
          {button('row', '+row', 'Add row below', false, run((c) => c.addRowAfter()))}
          {button('col', '+col', 'Add column right', false, run((c) => c.addColumnAfter()))}
          {button('delrow', '−row', 'Delete row', false, run((c) => c.deleteRow()))}
          {button('delcol', '−col', 'Delete column', false, run((c) => c.deleteColumn()))}
          {button('deltable', '✕▦', 'Delete table', false, run((c) => c.deleteTable()))}
        </>
      )}
      <span className="sep" />
      <select
        data-testid="tb-font"
        disabled={!editor}
        value={FONTS.find((f) => f.value === textStyle.fontFamily)?.value ?? ''}
        onChange={(e) => run((c) => (e.target.value ? c.setFontFamily(e.target.value) : c.unsetFontFamily()))()}
      >
        {FONTS.map((f) => (
          <option key={f.label} value={f.value}>
            {f.label}
          </option>
        ))}
      </select>
      <select
        data-testid="tb-size"
        disabled={!editor}
        value={textStyle.fontSize ?? ''}
        onChange={(e) => run((c) => (e.target.value ? c.setFontSize(e.target.value) : c.unsetFontSize()))()}
      >
        {SIZES.map((s) => (
          <option key={s} value={s}>
            {s || 'Size'}
          </option>
        ))}
      </select>
      <label className="color-input" title="Text colour">
        A
        <input data-testid="tb-color" type="color" disabled={!editor} value={textStyle.color ?? '#e6e6e6'} onChange={(e) => run((c) => c.setColor(e.target.value))()} />
      </label>
      <label className="color-input" title="Highlight">
        ▮
        <input data-testid="tb-highlight" type="color" disabled={!editor} defaultValue="#f2c12e" onChange={(e) => run((c) => c.toggleHighlight({ color: e.target.value }))()} />
      </label>
      {button('clear', '⌫', 'Clear formatting', false, run((c) => c.unsetAllMarks().clearNodes()))}
    </div>
  )
}
```

`packages/desktop/src/renderer/src/toolbar.css`:
```css
.toolbar { display: flex; align-items: center; gap: 2px; flex-wrap: wrap; padding: 6px 12px; border-bottom: 1px solid var(--border); background: var(--panel); }
.toolbar button { min-width: 28px; height: 28px; padding: 0 6px; background: none; border: 1px solid transparent; border-radius: 4px; color: var(--text); font: inherit; cursor: pointer; }
.toolbar button:hover:not(:disabled) { background: var(--hover); }
.toolbar button.active { background: var(--selected); border-color: var(--border); }
.toolbar button:disabled, .toolbar select:disabled { opacity: 0.4; cursor: default; }
.toolbar select { height: 28px; background: var(--panel-2); color: var(--text); border: 1px solid var(--border); border-radius: 4px; font: inherit; margin: 0 2px; }
.toolbar .sep { width: 1px; height: 18px; background: var(--border); margin: 0 6px; }
.color-input { position: relative; display: inline-grid; place-items: center; width: 28px; height: 28px; border-radius: 4px; cursor: pointer; font-weight: 600; }
.color-input:hover { background: var(--hover); }
.color-input input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
```

- [ ] **Step 4: Mount the toolbar**

In `packages/desktop/src/renderer/src/main.tsx`, add below the other CSS imports:
```tsx
import './toolbar.css'
```

In `packages/desktop/src/renderer/src/App.tsx`, add the import:
```tsx
import { Toolbar } from './Toolbar'
```
and change the `<main className="app-main">` block to:
```tsx
      <main className="app-main">
        <Toolbar />
        {page?.pageId ? <PageView key={page.pageId} nb={entry.doc} item={page} /> : <div className="empty">No page selected</div>}
      </main>
```

- [ ] **Step 5: Run the tests**

Run: `npm run e2e && npm run typecheck`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(desktop): formatting toolbar and opt-in Markdown Shortcuts setting"
```

---

### Task 14: Performance benchmark (200-box page)

**Files:**
- Create: `packages/desktop/src/renderer/src/testHooks.ts`
- Modify: `packages/desktop/src/renderer/src/main.tsx`, `packages/desktop/src/renderer/src/PageView.tsx`
- Test: `packages/desktop/e2e/perf.spec.ts`

**Interfaces:**
- Consumes: `currentSession` (Task 9), `PageSession.createBoxWithContent` (Task 8), `window.slate.isE2E` (Task 6).
- Produces: in e2e mode only, `window.slateTest = { seedBoxes(n: number): void; lastPageOpenMs(): number | null }`.

- [ ] **Step 1: Write the benchmark test**

`packages/desktop/e2e/perf.spec.ts`:
```ts
import { expect, test } from './fixtures'

type TestWindow = Window & { slateTest: { seedBoxes(n: number): void; lastPageOpenMs(): number | null }; __keyTimes: number[] }

test('a 200-box page opens in under 100 ms and typing stays under 16 ms per key', async ({ page }) => {
  await expect(page.getByTestId('canvas')).toBeVisible()
  await page.evaluate(() => (window as unknown as TestWindow).slateTest.seedBoxes(200))
  await expect(page.getByTestId('box')).toHaveCount(200)

  await page.getByTestId('add-page').click()
  await expect(page.getByTestId('box')).toHaveCount(0)
  await page.getByTestId('page-item').first().click()
  await expect(page.getByTestId('box')).toHaveCount(200)
  const openMs = await page.evaluate(() => (window as unknown as TestWindow).slateTest.lastPageOpenMs())
  console.log(`page open: ${openMs?.toFixed(1)} ms`)
  expect(openMs).not.toBeNull()
  expect(openMs!).toBeLessThan(100)

  await page.getByTestId('box-editor').first().click()
  await page.evaluate(() => {
    const w = window as unknown as TestWindow
    w.__keyTimes = []
    window.addEventListener(
      'keydown',
      () => {
        const t0 = performance.now()
        setTimeout(() => w.__keyTimes.push(performance.now() - t0), 0)
      },
      { capture: true },
    )
  })
  await page.keyboard.type('the quick brown fox jumps over the lazy dog 0123456789', { delay: 30 })
  const times = await page.evaluate(() => (window as unknown as TestWindow).__keyTimes)
  const sorted = [...times].sort((a, b) => a - b)
  const p95 = sorted[Math.floor(sorted.length * 0.95)]
  console.log(`keystroke p95: ${p95.toFixed(1)} ms over ${times.length} keys`)
  expect(p95).toBeLessThan(16)
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run e2e -- perf.spec.ts`
Expected: FAIL — `window.slateTest` is undefined.

- [ ] **Step 3: Measure page-open time in PageView**

In `packages/desktop/src/renderer/src/PageView.tsx`:
- add `useLayoutEffect` to the `react` import;
- add an exported module-level holder above the component:
```tsx
export const pageOpenTiming = { startedAt: 0, lastMs: null as number | null }
```
- as the first line of the `[pageId]` effect, add:
```tsx
    pageOpenTiming.startedAt = performance.now()
```
- after that effect, add:
```tsx
  // Time from page selection to the canvas being committed to the DOM (static boxes rendered).
  useLayoutEffect(() => {
    if (session) pageOpenTiming.lastMs = performance.now() - pageOpenTiming.startedAt
  }, [session])
```

- [ ] **Step 4: Test hooks (e2e only)**

`packages/desktop/src/renderer/src/testHooks.ts`:
```ts
import type { PMJSON } from '@slate/core'
import { currentSession } from './currentSession'
import { pageOpenTiming } from './PageView'

const p = (text: string): PMJSON => ({ type: 'paragraph', content: [{ type: 'text', text }] })

/** Installed only when SLATE_E2E=1: lets e2e tests seed large pages and read timings. */
export function installTestHooks(): void {
  ;(window as unknown as { slateTest: unknown }).slateTest = {
    seedBoxes(n: number): void {
      const session = currentSession.get()
      if (!session) throw new Error('No page open')
      for (let i = 0; i < n; i++) {
        session.createBoxWithContent(40 + (i % 2) * 520, 40 + Math.floor(i / 2) * 150, [
          p(`Box ${i}: deploy notes`),
          p('kubectl rollout status deploy/api --timeout=120s'),
          {
            type: 'bulletList',
            content: [
              { type: 'listItem', content: [p('check logs')] },
              { type: 'listItem', content: [p('verify metrics')] },
            ],
          },
        ])
      }
    },
    lastPageOpenMs: (): number | null => pageOpenTiming.lastMs,
  }
}
```

In `packages/desktop/src/renderer/src/main.tsx`, add:
```tsx
import { installTestHooks } from './testHooks'

if (window.slate.isE2E) installTestHooks()
```
(the import goes with the other imports; the `if` goes before `createRoot(...)`).

- [ ] **Step 5: Run the benchmark**

Run: `npm run e2e -- perf.spec.ts`
Expected: PASS, with the two timings logged.

If either budget is missed, use superpowers:systematic-debugging and profile before changing code. Likely levers:
- Rendering `StaticBox` for every box on open is the main open-time cost. Cache `renderStaticHtml` output per box until its container changes.
- Keystroke cost: check that `Canvas` doesn't re-render all 200 `Box` components per keystroke. If it does, wrap `Box` in `React.memo` and make `onFocus` stable (`useCallback` keyed by id).

Record the measured numbers in the commit message body.

- [ ] **Step 6: Run the full suite**

Run: `npm test && npm run test:main && npm run e2e && npm run typecheck`
Expected: everything PASSES.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "test: 200-box performance benchmark for page open and keystroke latency"
```

---

## Done criteria for Phase 1

- `npm run dev` opens Slate showing the notebook dropdown, the section and page columns, the toolbar, and a page canvas.
- You can create and move boxes. A growing box pushes boxes below it down.
- Copying a numbered list into a terminal or Sublime gives `1. / 2. / 3.` with no stray characters.
- Pasting from a website keeps structure but not its fonts or colours.
- Marking a box private shows a hatched border.
- Everything survives a restart.
- All unit, main-process and e2e tests pass, and the performance benchmark meets the spec's budgets.
