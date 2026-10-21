# Slate Phase 2 — AI Access (MCP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Claude Code and other agents read, search and (where granted) write the user's notes through a local MCP server. Everything is deny-by-default, permissions are per notebook, section group, section or page, private boxes never leave the machine's UI, and every agent call goes to an audit log the user can see.

**Architecture:**
- **Pure core (`@slate/core`)** holds the security-critical rules:
  - effective access (nearest explicit grant, deny by default);
  - the agent view of a page (private boxes replaced before serialization);
  - Markdown in and out.
- **`@slate/mcp`** is a pure package: tool functions over a `DocSource` interface, and an `McpServer` factory, tested in memory.
- **`@slate/desktop`** adds:
  - a stdio CLI (`out/main/mcp.js`, started through `bin/slate-mcp` with Electron's Node, so `better-sqlite3`'s Electron build loads) that reads and writes the same SQLite file as the app;
  - a watcher in the app that imports writes made by other processes live;
  - the permissions UI and the AI Activity panel.

**Tech Stack:** `@modelcontextprotocol/sdk` 1.32 (`McpServer.registerTool`, `StdioServerTransport`, `InMemoryTransport`), `zod` 4, plus the Phase 1 stack (Loro 1.16, better-sqlite3 13, Electron 45, Vitest 5, Playwright 1.64).

Spec: `docs/superpowers/specs/2026-10-21-slate-design.md` §7 (Phase 2 = §10 item 2). Repo rules: `CLAUDE.md`.

## Global Constraints

- **Deny by default.** No grant anywhere means the agent sees nothing. A grant on a container applies to everything inside it, and the nearest explicit grant wins.
- **Private boxes are a security boundary.** A private box's content is never read into anything an agent receives: no Markdown, no search hit, no snippet, no JSON. The agent sees `[private box omitted]` in its place. Filtering happens in `@slate/core` before serialization, with dedicated tests.
- **Uniform denial.** Unknown ids and ids the agent may not access get the same error text, `not found or not permitted`, so an agent cannot probe for what exists.
- **Read tools:** `list_tree`, `read_page`, `search`. **Write tools:** `append_to_page`, `create_page`, which need `readwrite` on the target (`create_page`: on the section).
- **Audit everything.** Every tool call writes one audit row `{ ts, tool, target, outcome: 'ok' | 'denied' | 'not-found' }`, visible in View → AI Activity…
- **Local only.** stdio transport, no network listener. The CLI writes nothing to stdout except MCP protocol messages; logs go to stderr.
- **App name and data folder:** `Slate`, with userData at:
  - macOS: `~/Library/Application Support/Slate`
  - Linux: `$XDG_CONFIG_HOME/Slate` (default `~/.config/Slate`)
  - Windows: `%APPDATA%/Slate`

  `SLATE_USER_DATA` overrides it, for tests. Phase 1 data in the old `@slate/desktop` folder is moved once.
- **Commits:** Conventional Commits, no AI attribution, never push. E2E windows stay hidden (`SLATE_E2E=1`). Everything in `CLAUDE.md` applies.

---

## File Structure

```
packages/core/src/
  tree.ts            (modify) Access, setAccess/accessOf/effectiveAccess/findPage, TreeItem.access
  content.ts         (new)    writeContent (moved from editor), contentToJSON
  markdown.ts        (new)    toMarkdown(PMJSON[]), markdownToBlocks(md)
  agentView.ts       (new)    agentBoxes, agentPageMarkdown, PRIVATE_PLACEHOLDER, placeBelow
packages/editor/src/content.ts   (modify) re-export writeContent from core
packages/mcp/                    (new package @slate/mcp)
  src/source.ts      DocSource, NotebookRef, AuditEntry
  src/tools.ts       listTree, readPage, search, appendToPage, createPage, NOT_PERMITTED
  src/server.ts      createSlateMcpServer(source)
  test/tools.test.ts, test/server.test.ts, test/memorySource.ts
packages/desktop/
  src/main/store.ts          (modify) audit table, updatesSince, maxUpdateId, dataVersion, compact flag, busy_timeout
  src/main/paths.ts          (new)    APP_NAME, defaultUserDataDir, migrateLegacyUserData
  src/main/externalWatch.ts  (new)    poll data_version, emit other processes' updates
  src/main/index.ts          (modify) app name, userData, watcher
  src/mcp/cli.ts             (new)    stdio MCP server over DocStore
  src/shared/api.ts, src/shared/ipc.ts, src/preload/index.ts, src/main/ipc.ts, src/main/menu.ts (modify)
  src/renderer/src/sidebar/accessMenu.ts (new), AiActivity.tsx (new), ai.css (new)
  src/renderer/src/sidebar/{SectionList,PageList,NotebookPicker}.tsx, App.tsx, library.ts, main.tsx (modify)
  electron.vite.config.ts, package.json (modify)
  e2e/mcp.spec.ts, e2e/ai-access.spec.ts, e2e/agent-flow.spec.ts, e2e/mcpClient.ts (new)
packages/editor/src/PageSession.ts (modify) importExternal
bin/slate-mcp                      (new) launcher for Claude Code
```

---

### Task 1: Access control in NotebookDoc

**Files:** Modify `packages/core/src/tree.ts`. Test: `packages/core/test/access.test.ts`.

**Interfaces:**
- Produces:
  - `type Access = 'read' | 'readwrite'`
  - `const NOTEBOOK_SCOPE = 'notebook'`
  - `NotebookDoc.setAccess(target: TreeID | typeof NOTEBOOK_SCOPE, access: Access | null): void`
  - `NotebookDoc.accessOf(target): Access | null` (the explicit grant only)
  - `NotebookDoc.effectiveAccess(id: TreeID): Access | null`
  - `NotebookDoc.findPage(pageId: string): TreeItem | undefined`
  - `TreeItem.access: Access | null` (the explicit grant on that node)

- [ ] **Step 1: Write the failing tests** — `packages/core/test/access.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { NOTEBOOK_SCOPE, NotebookDoc } from '../src/tree'

function sample() {
  const nb = NotebookDoc.create('N')
  const group = nb.addSectionGroup('G')
  const inGroup = nb.addSection('In group', group)
  const loose = nb.addSection('Loose')
  const p1 = nb.addPage(inGroup, 'P1')
  const p2 = nb.addPage(loose, 'P2')
  return { nb, group, inGroup, loose, p1, p2 }
}

describe('NotebookDoc access', () => {
  it('denies everything by default', () => {
    const { nb, inGroup, p1 } = sample()
    expect(nb.effectiveAccess(inGroup)).toBeNull()
    expect(nb.effectiveAccess(p1.id)).toBeNull()
  })

  it('applies a notebook-wide grant to every node', () => {
    const { nb, p1, p2 } = sample()
    nb.setAccess(NOTEBOOK_SCOPE, 'read')
    expect(nb.effectiveAccess(p1.id)).toBe('read')
    expect(nb.effectiveAccess(p2.id)).toBe('read')
  })

  it('applies a container grant to its descendants only', () => {
    const { nb, group, p1, p2 } = sample()
    nb.setAccess(group, 'readwrite')
    expect(nb.effectiveAccess(p1.id)).toBe('readwrite')
    expect(nb.effectiveAccess(p2.id)).toBeNull()
  })

  it('lets the nearest explicit grant win', () => {
    const { nb, inGroup, p1 } = sample()
    nb.setAccess(NOTEBOOK_SCOPE, 'readwrite')
    nb.setAccess(inGroup, 'read')
    expect(nb.effectiveAccess(p1.id)).toBe('read')
  })

  it('revokes a grant with null and exposes explicit grants on items', () => {
    const { nb, loose, p2 } = sample()
    nb.setAccess(loose, 'read')
    expect(nb.get(loose)!.access).toBe('read')
    expect(nb.get(p2.id)!.access).toBeNull()
    nb.setAccess(loose, null)
    expect(nb.effectiveAccess(p2.id)).toBeNull()
    expect(nb.accessOf(loose)).toBeNull()
  })

  it('finds pages by page id and returns null access for unknown ids', () => {
    const { nb, p2 } = sample()
    expect(nb.findPage(p2.pageId)!.id).toBe(p2.id)
    expect(nb.findPage('nope')).toBeUndefined()
    expect(nb.effectiveAccess('0@0' as never)).toBeNull()
  })

  it('persists grants through updates', () => {
    const { nb, loose } = sample()
    nb.setAccess(loose, 'readwrite')
    const copy = NotebookDoc.fromUpdates([nb.doc.export({ mode: 'snapshot' })])
    expect(copy.accessOf(loose)).toBe('readwrite')
  })
})
```

- [ ] **Step 2: Run them to see them fail.** `npx vitest run packages/core/test/access.test.ts` — expect FAIL (`setAccess is not a function`).

- [ ] **Step 3: Implement.** In `packages/core/src/tree.ts`:
  - add the exports;
  - add `access: Access | null` to `TreeItem`;
  - make `toItem` take the access map.

```ts
export type Access = 'read' | 'readwrite'
/** Key for a grant that covers the whole notebook. */
export const NOTEBOOK_SCOPE = 'notebook'

function readAccess(value: unknown): Access | null {
  return value === 'read' || value === 'readwrite' ? value : null
}
```

Change `toItem` to:

```ts
function toItem(n: LoroTreeNode, access: LoroMap): TreeItem {
  const d = n.data
  return {
    id: n.id,
    kind: d.get('kind') as NodeKind,
    title: String(d.get('title') ?? ''),
    color: (d.get('color') as string | undefined) ?? null,
    level: Number(d.get('level') ?? 0),
    pageId: (d.get('pageId') as string | undefined) ?? null,
    access: readAccess(access.get(n.id)),
    children: (n.children() ?? []).map((c) => toItem(c, access)),
  }
}
```

(import `LoroMap` as a type from `loro-crdt`). Then update the two callers to `toItem(n, this.accessMap)`, and add these to the class:

```ts
  private get accessMap(): LoroMap {
    return this.doc.getMap('access')
  }

  accessOf(target: TreeID | typeof NOTEBOOK_SCOPE): Access | null {
    return readAccess(this.accessMap.get(target))
  }

  setAccess(target: TreeID | typeof NOTEBOOK_SCOPE, access: Access | null): void {
    if (access) this.accessMap.set(target, access)
    else this.accessMap.delete(target)
    this.doc.commit()
  }

  /** Deny by default: the nearest explicit grant on the node, its ancestors, then the notebook. */
  effectiveAccess(id: TreeID): Access | null {
    const start = this.node(id)
    if (!start) return null
    for (let n: LoroTreeNode | undefined = start; n; n = n.parent()) {
      const access = this.accessOf(n.id)
      if (access) return access
    }
    return this.accessOf(NOTEBOOK_SCOPE)
  }

  findPage(pageId: string): TreeItem | undefined {
    const walk = (items: TreeItem[]): TreeItem | undefined => {
      for (const item of items) {
        if (item.pageId === pageId) return item
        const found = walk(item.children)
        if (found) return found
      }
      return undefined
    }
    return walk(this.items())
  }
```

- [ ] **Step 4: Run** `npx vitest run packages/core && npm run typecheck`. The existing tree tests compare `items()` across peers, so they still pass, because `access` is `null` on both. Expect all PASS.

- [ ] **Step 5: Commit** — `git commit -am "feat(core): deny-by-default AI access grants on notebook nodes"`

---

### Task 2: Agent view and Markdown output (the private-box boundary)

**Files:** Create `packages/core/src/content.ts`, `packages/core/src/markdown.ts`, `packages/core/src/agentView.ts`. Modify `packages/core/src/index.ts`. Tests: `packages/core/test/markdown.test.ts`, `packages/core/test/agentView.test.ts`.

**Interfaces:**
- Consumes: `PageDoc`, `BoxState`, `PMJSON` (Phase 1).
- Produces:
  - `writeContent(root: LoroMap, blocks: PMJSON[]): void` (moved here from `@slate/editor`; same behaviour)
  - `contentToJSON(root: LoroMap): PMJSON | null`
  - `toMarkdown(nodes: PMJSON[]): string`
  - `interface AgentBox { id: string; x: number; y: number; private: boolean; markdown: string | null }`
  - `agentBoxes(page: PageDoc): AgentBox[]` (sorted top-to-bottom, then left-to-right)
  - `agentPageMarkdown(page: PageDoc): string`
  - `PRIVATE_PLACEHOLDER = '[private box omitted]'`

The Loro layout (shared with loro-prosemirror, whose constants are `nodeName`, `attributes` and `children`):
- a node is a `LoroMap { nodeName: string, attributes: LoroMap, children: LoroList }`;
- `children` holds node maps or `LoroText`;
- `LoroText.toDelta()` gives `{ insert, attributes? }`, and each attribute key is a mark name whose value is the mark's attrs (an object) or a non-object marker.

- [ ] **Step 1: Write the failing tests.**

`packages/core/test/markdown.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { toMarkdown } from '../src/markdown'
import type { PMJSON } from '../src/plaintext'

const t = (text: string, marks?: PMJSON['marks']): PMJSON => ({ type: 'text', text, ...(marks ? { marks } : {}) })
const p = (...content: PMJSON[]): PMJSON => ({ type: 'paragraph', content })
const li = (...content: PMJSON[]): PMJSON => ({ type: 'listItem', content })

describe('toMarkdown', () => {
  it('renders headings, paragraphs and inline marks', () => {
    const doc = [
      { type: 'heading', attrs: { level: 2 }, content: [t('Deploy')] },
      p(t('run '), t('kubectl', [{ type: 'code' }]), t(' and '), t('check', [{ type: 'bold' }]), t(' '), t('logs', [{ type: 'italic' }])),
      p(t('docs', [{ type: 'link', attrs: { href: 'https://x.dev' } }]), t(' '), t('old', [{ type: 'strike' }])),
    ]
    expect(toMarkdown(doc)).toBe('## Deploy\n\nrun `kubectl` and **check** _logs_\n\n[docs](https://x.dev) ~~old~~')
  })

  it('renders nested lists with real numbers', () => {
    const doc = [{ type: 'orderedList', attrs: { start: 3 }, content: [li(p(t('a')), { type: 'bulletList', content: [li(p(t('b')))] }), li(p(t('c')))] }]
    expect(toMarkdown(doc)).toBe('3. a\n   - b\n4. c')
  })

  it('fences code blocks with their language', () => {
    expect(toMarkdown([{ type: 'codeBlock', attrs: { language: 'sh' }, content: [t('ls -la')] }])).toBe('```sh\nls -la\n```')
  })

  it('renders tables as GFM with the first row as header', () => {
    const cell = (s: string): PMJSON => ({ type: 'tableCell', content: [p(t(s))] })
    const table = { type: 'table', content: [{ type: 'tableRow', content: [cell('k'), cell('v')] }, { type: 'tableRow', content: [cell('a'), cell('1')] }] }
    expect(toMarkdown([table])).toBe('| k | v |\n| --- | --- |\n| a | 1 |')
  })

  it('renders images and rules', () => {
    expect(toMarkdown([{ type: 'image', attrs: { src: 'slate-blob://blob/x.png' } }, { type: 'horizontalRule' }])).toBe('![](slate-blob://blob/x.png)\n\n---')
  })
})
```

`packages/core/test/agentView.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { LoroList, LoroMap, LoroText } from 'loro-crdt'
import { agentBoxes, agentPageMarkdown, PRIVATE_PLACEHOLDER } from '../src/agentView'
import { contentToJSON, writeContent } from '../src/content'
import { PageDoc } from '../src/page'

function pageWith(boxes: Array<{ y: number; x?: number; text: string; private?: boolean }>): PageDoc {
  const page = new PageDoc()
  for (const b of boxes) {
    const id = page.addBox({ x: b.x ?? 0, y: b.y, width: 300 })
    writeContent(page.contentMap(id)!, [{ type: 'paragraph', content: [{ type: 'text', text: b.text }] }])
    page.doc.commit()
    if (b.private) page.updateBox(id, { private: true })
  }
  return page
}

describe('agent view', () => {
  it('orders boxes top-to-bottom and renders Markdown', () => {
    const page = pageWith([{ y: 300, text: 'second' }, { y: 10, text: 'first' }])
    expect(agentBoxes(page).map((b) => b.markdown)).toEqual(['first', 'second'])
    expect(agentPageMarkdown(page)).toBe('first\n\n---\n\nsecond')
  })

  it('never exposes a private box (security boundary)', () => {
    const page = pageWith([{ y: 0, text: 'public note' }, { y: 100, text: 'hunter2 secret token', private: true }])
    const boxes = agentBoxes(page)
    expect(boxes[1]).toMatchObject({ private: true, markdown: null })
    expect(JSON.stringify(boxes)).not.toContain('hunter2')
    const md = agentPageMarkdown(page)
    expect(md).toContain('public note')
    expect(md).toContain(PRIVATE_PLACEHOLDER)
    expect(md).not.toContain('hunter2')
  })

  it('reads marks stored on Loro text', () => {
    const page = new PageDoc()
    const id = page.addBox({ x: 0, y: 0, width: 300 })
    writeContent(page.contentMap(id)!, [{ type: 'paragraph', content: [{ type: 'text', text: 'plain bold' }] }])
    page.doc.configTextStyle({ bold: { expand: 'after' } })
    const para = (page.contentMap(id)!.get('children') as LoroList).get(0) as LoroMap
    const text = (para.get('children') as LoroList).get(0) as LoroText
    text.mark({ start: 6, end: 10 }, 'bold', true)
    page.doc.commit()
    expect(agentPageMarkdown(page)).toBe('plain **bold**')
  })

  it('returns null content for an empty box', () => {
    const page = new PageDoc()
    const id = page.addBox({ x: 0, y: 0, width: 100 })
    expect(contentToJSON(page.contentMap(id)!)).toBeNull()
  })
})
```

- [ ] **Step 2: Run them to see them fail** (missing modules).

- [ ] **Step 3: Implement.**

`packages/core/src/content.ts` (move the body of `packages/editor/src/content.ts` here, using literal keys):

```ts
import { LoroList, LoroMap, LoroText, type Value } from 'loro-crdt'
import type { PMJSON } from './plaintext'

// The layout loro-prosemirror uses (its NODE_NAME_KEY, ATTRIBUTES_KEY, CHILDREN_KEY). Core reads
// and writes it without ProseMirror, so agents and the CLI need no editor code.
const NODE_NAME = 'nodeName'
const ATTRIBUTES = 'attributes'
const CHILDREN = 'children'

function writeNode(map: LoroMap, node: PMJSON): void {
  map.set(NODE_NAME, node.type)
  const attrs = map.setContainer(ATTRIBUTES, new LoroMap())
  for (const [key, value] of Object.entries(node.attrs ?? {})) if (value !== undefined) attrs.set(key, value as Value)
  const children = map.setContainer(CHILDREN, new LoroList())
  for (const child of node.content ?? []) {
    if (child.type === 'text') children.insertContainer(children.length, new LoroText()).insert(0, child.text ?? '')
    else writeNode(children.insertContainer(children.length, new LoroMap()), child)
  }
}

/** Writes block content into an empty box content container. Marks are not written. Caller commits. */
export function writeContent(root: LoroMap, blocks: PMJSON[]): void {
  writeNode(root, { type: 'doc', content: blocks })
}

function textToJSON(text: LoroText): PMJSON[] {
  return text.toDelta().flatMap((op) => {
    if (typeof op.insert !== 'string' || op.insert === '') return []
    const marks = Object.entries(op.attributes ?? {})
      .filter(([, v]) => v !== null && v !== undefined && v !== false)
      .map(([type, v]) => (typeof v === 'object' ? { type, attrs: v as Record<string, unknown> } : { type }))
    return [{ type: 'text', text: op.insert, ...(marks.length > 0 ? { marks } : {}) }]
  })
}

function nodeToJSON(map: LoroMap): PMJSON {
  const attrsMap = map.get(ATTRIBUTES)
  const attrs = attrsMap instanceof LoroMap ? (attrsMap.toJSON() as Record<string, unknown>) : {}
  const children = map.get(CHILDREN)
  const content: PMJSON[] = []
  if (children instanceof LoroList) {
    for (const child of children.toArray()) {
      if (child instanceof LoroText) content.push(...textToJSON(child))
      else if (child instanceof LoroMap) content.push(nodeToJSON(child))
    }
  }
  return { type: String(map.get(NODE_NAME)), ...(Object.keys(attrs).length > 0 ? { attrs } : {}), ...(content.length > 0 ? { content } : {}) }
}

/** ProseMirror-shaped JSON of a box's content, or null for an empty box. */
export function contentToJSON(root: LoroMap): PMJSON | null {
  return root.size === 0 ? null : nodeToJSON(root)
}
```

`packages/core/src/markdown.ts`:

```ts
import type { PMJSON } from './plaintext'

const clean = (s: string) => s.replace(/\u00A0/g, ' ').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').replace(/\r\n?/g, '\n')

function markText(node: PMJSON): string {
  let text = clean(node.text ?? '')
  const marks = node.marks ?? []
  const has = (type: string) => marks.some((m) => m.type === type)
  if (has('code')) text = `\`${text}\``
  if (has('bold')) text = `**${text}**`
  if (has('italic')) text = `_${text}_`
  if (has('strike')) text = `~~${text}~~`
  const link = marks.find((m) => m.type === 'link')
  if (link && typeof link.attrs?.href === 'string') text = `[${text}](${link.attrs.href})`
  return text
}

function inline(nodes: PMJSON[] = []): string {
  return nodes.map((n) => (n.type === 'text' ? markText(n) : n.type === 'hardBreak' ? '  \n' : inline(n.content))).join('')
}

function listLines(list: PMJSON, indent: string, marker: (i: number) => string): string[] {
  const out: string[] = []
  ;(list.content ?? []).forEach((item, i) => {
    const m = marker(i)
    const pad = indent + ' '.repeat(m.length)
    const [first, ...rest] = item.content ?? []
    out.push(indent + m + (first && first.type !== 'bulletList' && first.type !== 'orderedList' ? inline(first.content) : ''))
    for (const child of rest) out.push(...blockLines(child, pad))
  })
  return out
}

function blockLines(node: PMJSON, indent: string): string[] {
  switch (node.type) {
    case 'paragraph':
      return inline(node.content).split('\n').map((l) => indent + l)
    case 'heading':
      return [indent + '#'.repeat(Number(node.attrs?.level ?? 1)) + ' ' + inline(node.content)]
    case 'bulletList':
      return listLines(node, indent, () => '- ')
    case 'orderedList': {
      const start = typeof node.attrs?.start === 'number' ? node.attrs.start : 1
      return listLines(node, indent, (i) => `${start + i}. `)
    }
    case 'codeBlock': {
      const lang = typeof node.attrs?.language === 'string' && node.attrs.language !== 'plaintext' ? node.attrs.language : ''
      const code = (node.content ?? []).map((n) => (n.text ?? '').replace(/\r\n?/g, '\n')).join('')
      return [indent + '```' + lang, ...code.split('\n').map((l) => indent + l), indent + '```']
    }
    case 'blockquote':
      return (node.content ?? []).flatMap((c) => blockLines(c, '')).map((l) => `${indent}> ${l}`)
    case 'horizontalRule':
      return [indent + '---']
    case 'image':
      return [`${indent}![](${String(node.attrs?.src ?? '')})`]
    case 'table': {
      const rows = (node.content ?? []).map((row) => (row.content ?? []).map((cell) => (cell.content ?? []).map((c) => inline(c.content)).join(' ').replace(/\|/g, '\\|')))
      if (rows.length === 0) return []
      const line = (cells: string[]) => `${indent}| ${cells.join(' | ')} |`
      return [line(rows[0]), line(rows[0].map(() => '---')), ...rows.slice(1).map(line)]
    }
    default:
      return (node.content ?? []).flatMap((c) => blockLines(c, indent))
  }
}

/** Markdown for agents: GFM-flavoured, blocks separated by a blank line, real list numbers. */
export function toMarkdown(nodes: PMJSON[]): string {
  const blocks = nodes.flatMap((n) => (n.type === 'doc' ? n.content ?? [] : [n]))
  return blocks.map((b) => blockLines(b, '').join('\n')).filter((b) => b !== '').join('\n\n')
}
```

`packages/core/src/agentView.ts`:

```ts
import { contentToJSON } from './content'
import { toMarkdown } from './markdown'
import type { PageDoc } from './page'

export const PRIVATE_PLACEHOLDER = '[private box omitted]'

export interface AgentBox {
  id: string
  x: number
  y: number
  private: boolean
  /** Null for a private box: its content is never read, so it cannot leak. */
  markdown: string | null
}

/** The only way agent-facing code reads a page. Private boxes are filtered before any content is read. */
export function agentBoxes(page: PageDoc): AgentBox[] {
  return page
    .listBoxes()
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((box) => {
      if (box.private) return { id: box.id, x: box.x, y: box.y, private: true, markdown: null }
      const json = contentToJSON(page.contentMap(box.id)!)
      return { id: box.id, x: box.x, y: box.y, private: false, markdown: json ? toMarkdown([json]) : '' }
    })
}

export function agentPageMarkdown(page: PageDoc): string {
  return agentBoxes(page)
    .map((b) => (b.private ? PRIVATE_PLACEHOLDER : b.markdown))
    .filter((md) => md !== '')
    .join('\n\n---\n\n')
}
```

Append to `packages/core/src/index.ts`:

```ts
export * from './content'
export * from './markdown'
export * from './agentView'
```

Replace `packages/editor/src/content.ts` with `export { writeContent } from '@slate/core'` (the editor's `content.test.ts` keeps proving the layout against loro-prosemirror's `createNodeFromLoroObj`).

If `text.mark(...)`, `configTextStyle` or `toDelta()` behave differently in loro-crdt 1.16, read `node_modules/loro-crdt/nodejs/loro_wasm.d.ts` and adjust the test's setup only. The assertion `'plain **bold**'` stays.

- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expect all PASS, including the editor's existing `content.test.ts`.

- [ ] **Step 5: Commit** — `git commit -am "feat(core): agent view of pages with private boxes filtered, and Markdown output"`

---

### Task 3: Markdown input and placing agent boxes

**Files:** Modify `packages/core/src/markdown.ts`, `packages/core/src/agentView.ts`. Tests: extend `packages/core/test/markdown.test.ts` and `packages/core/test/agentView.test.ts`.

**Interfaces:**
- Produces:
  - `markdownToBlocks(md: string): PMJSON[]` (paragraphs, `#`–`###` headings, `- `/`* ` bullets, `1. ` numbered, fenced code with language; one level, no inline marks)
  - `placeBelow(page: PageDoc): { x: number; y: number }`

- [ ] **Step 1: Failing tests.** Append to `markdown.test.ts`:

```ts
import { markdownToBlocks } from '../src/markdown'

describe('markdownToBlocks', () => {
  it('parses headings, paragraphs, lists and fenced code', () => {
    const md = '# Title\n\nfirst line\nsecond line\n\n- a\n- b\n\n2. x\n3. y\n\n```sh\nls -la\n  echo hi\n```'
    expect(markdownToBlocks(md)).toEqual([
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'first line' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'second line' }] },
      { type: 'bulletList', content: ['a', 'b'].map((s) => ({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: s }] }] })) },
      { type: 'orderedList', attrs: { start: 2 }, content: ['x', 'y'].map((s) => ({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: s }] }] })) },
      { type: 'codeBlock', attrs: { language: 'sh' }, content: [{ type: 'text', text: 'ls -la\n  echo hi' }] },
    ])
  })

  it('returns an empty paragraph list for blank input', () => {
    expect(markdownToBlocks('  \n\n')).toEqual([])
  })
})
```

Append to `agentView.test.ts`:

```ts
import { placeBelow } from '../src/agentView'

describe('placeBelow', () => {
  it('puts the first box near the top left of an empty page', () => {
    expect(placeBelow(new PageDoc())).toEqual({ x: 40, y: 40 })
  })

  it('puts a new box below the lowest box, estimating its height from its lines', () => {
    const page = pageWith([{ y: 100, text: 'one' }, { y: 400, text: 'last' }])
    const { y } = placeBelow(page)
    expect(y).toBeGreaterThan(400 + 24)
  })
})
```

- [ ] **Step 2: Run them to see them fail.**

- [ ] **Step 3: Implement.** Append to `markdown.ts`:

```ts
const text = (s: string): PMJSON[] => (s === '' ? [] : [{ type: 'text', text: s }])
const item = (s: string): PMJSON => ({ type: 'listItem', content: [{ type: 'paragraph', content: text(s) }] })

/** Markdown from an agent into blocks (no inline marks: agents' text is stored as typed). */
export function markdownToBlocks(md: string): PMJSON[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  const blocks: PMJSON[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = /^```(\S*)\s*$/.exec(line)
    if (fence) {
      const code: string[] = []
      for (i++; i < lines.length && !/^```\s*$/.test(lines[i]); i++) code.push(lines[i])
      blocks.push({ type: 'codeBlock', attrs: { language: fence[1] || 'plaintext' }, content: text(code.join('\n')) })
      continue
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) {
      blocks.push({ type: 'heading', attrs: { level: heading[1].length }, content: text(heading[2]) })
      continue
    }
    if (/^[-*]\s+/.test(line)) {
      const items: PMJSON[] = []
      for (; i < lines.length && /^[-*]\s+/.test(lines[i]); i++) items.push(item(lines[i].replace(/^[-*]\s+/, '')))
      i--
      blocks.push({ type: 'bulletList', content: items })
      continue
    }
    const numbered = /^(\d+)\.\s+/.exec(line)
    if (numbered) {
      const items: PMJSON[] = []
      for (; i < lines.length && /^\d+\.\s+/.test(lines[i]); i++) items.push(item(lines[i].replace(/^\d+\.\s+/, '')))
      i--
      blocks.push({ type: 'orderedList', attrs: { start: Number(numbered[1]) }, content: items })
      continue
    }
    if (line.trim() !== '') blocks.push({ type: 'paragraph', content: text(line) })
  }
  return blocks
}
```

Append to `agentView.ts`:

```ts
import { toPlainText } from './plaintext'

const LINE_PX = 24
const GAP_PX = 40

/** Where an agent's new box goes: left edge, below the lowest box (height estimated from its lines). */
export function placeBelow(page: PageDoc): { x: number; y: number } {
  let bottom = 0
  for (const box of page.listBoxes()) {
    const json = box.private ? null : contentToJSON(page.contentMap(box.id)!)
    const lines = json ? Math.max(1, toPlainText([json]).split('\n').length) : 2
    bottom = Math.max(bottom, box.y + lines * LINE_PX + 16)
  }
  return { x: GAP_PX, y: bottom + GAP_PX }
}
```

(`placeBelow` reads a private box's line count only to avoid overlapping it, never its text. Private boxes get a fixed estimate, so nothing is read from them at all.)

- [ ] **Step 4: Run** `npm test && npm run typecheck` — PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(core): Markdown input for agents and placement of agent boxes"`

---

### Task 4: Storage for agents — audit log, cross-process updates, data folder

**Files:**
- Modify `packages/desktop/src/main/store.ts`, `packages/desktop/src/main/index.ts`.
- Create `packages/desktop/src/main/paths.ts`.
- Tests: extend `packages/desktop/src/main/store.test.ts`; create `packages/desktop/src/main/paths.test.ts`.

**Interfaces:**
- Produces (`DocStore`):
  - `constructor(file: string, options?: { compact?: boolean })` (`compact` defaults to true; the CLI passes false, so only the app ever compacts)
  - `appendAudit(entry: { tool: string; target: string; outcome: string }): void`
  - `listAudit(limit?: number): AuditRow[]` (newest first), with `interface AuditRow { id: number; ts: number; tool: string; target: string; outcome: string }` exported from `store.ts`
  - `updatesSince(id: number): Array<{ id: number; docId: string; data: Uint8Array }>`
  - `maxUpdateId(): number`
  - `dataVersion(): number`
- Produces (`paths.ts`): `APP_NAME = 'Slate'`, `defaultUserDataDir(platform?, env?, home?): string`, `migrateLegacyUserData(newDir: string): boolean`.

- [ ] **Step 1: Failing tests.** Append to `store.test.ts` (inside the existing `describe`; reuse `tempDb()`):

```ts
  it('records and lists audit rows newest first', () => {
    const store = new DocStore(tempDb())
    store.appendAudit({ tool: 'read_page', target: 'p1', outcome: 'ok' })
    store.appendAudit({ tool: 'search', target: 'q', outcome: 'denied' })
    const rows = store.listAudit()
    expect(rows.map((r) => r.tool)).toEqual(['search', 'read_page'])
    expect(rows[0].ts).toBeGreaterThan(0)
    store.close()
  })

  it('sees updates written by another connection to the same file', () => {
    const file = tempDb()
    const app = new DocStore(file)
    const cli = new DocStore(file, { compact: false })
    const since = app.maxUpdateId()
    const before = app.dataVersion()
    cli.append('page:x', new Uint8Array([7]))
    expect(app.dataVersion()).not.toBe(before)
    expect(app.updatesSince(since).map((u) => [u.docId, Array.from(u.data)])).toEqual([['page:x', [7]]])
    app.close()
    cli.close()
  })

  it('never compacts when compact is false', () => {
    const store = new DocStore(tempDb(), { compact: false })
    for (let i = 0; i < 520; i++) store.append('page:n', new Uint8Array([i % 256]))
    expect(store.load('page:n')).toHaveLength(520)
    store.close()
  })
```

`paths.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultUserDataDir, migrateLegacyUserData } from './paths'

describe('defaultUserDataDir', () => {
  it('follows each platform convention and honours SLATE_USER_DATA', () => {
    expect(defaultUserDataDir('darwin', {}, '/Users/u')).toBe('/Users/u/Library/Application Support/Slate')
    expect(defaultUserDataDir('linux', {}, '/home/u')).toBe('/home/u/.config/Slate')
    expect(defaultUserDataDir('linux', { XDG_CONFIG_HOME: '/x' }, '/home/u')).toBe('/x/Slate')
    expect(defaultUserDataDir('win32', { APPDATA: 'C:\\A' }, 'C:\\U')).toBe(join('C:\\A', 'Slate'))
    expect(defaultUserDataDir('darwin', { SLATE_USER_DATA: '/tmp/t' }, '/Users/u')).toBe('/tmp/t')
  })
})

describe('migrateLegacyUserData', () => {
  it('moves the Phase 1 @slate/desktop folder once', () => {
    const parent = mkdtempSync(join(tmpdir(), 'slate-paths-'))
    mkdirSync(join(parent, '@slate', 'desktop'), { recursive: true })
    writeFileSync(join(parent, '@slate', 'desktop', 'slate.db'), 'x')
    expect(migrateLegacyUserData(join(parent, 'Slate'))).toBe(true)
    expect(existsSync(join(parent, 'Slate', 'slate.db'))).toBe(true)
    expect(migrateLegacyUserData(join(parent, 'Slate'))).toBe(false)
  })
})
```

- [ ] **Step 2: Run** `npm run test:main` — FAIL.

- [ ] **Step 3: Implement.** In `store.ts`:
  - add `export interface AuditRow { id: number; ts: number; tool: string; target: string; outcome: string }`;
  - add to the schema `CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, tool TEXT NOT NULL, target TEXT NOT NULL, outcome TEXT NOT NULL);`;
  - add `this.db.pragma('busy_timeout = 3000')` (the app and the CLI write the same file);
  - make the constructor `constructor(file: string, private readonly options: { compact?: boolean } = {})`;
  - change `append` so it compacts only when `this.options.compact !== false`;
  - add:

```ts
  appendAudit(entry: { tool: string; target: string; outcome: string }): void {
    this.db.prepare('INSERT INTO audit (ts, tool, target, outcome) VALUES (?, ?, ?, ?)').run(Date.now(), entry.tool, entry.target, entry.outcome)
  }

  listAudit(limit = 200): AuditRow[] {
    return this.db.prepare('SELECT id, ts, tool, target, outcome FROM audit ORDER BY id DESC LIMIT ?').all(limit) as AuditRow[]
  }

  updatesSince(id: number): Array<{ id: number; docId: string; data: Uint8Array }> {
    const rows = this.db.prepare('SELECT id, doc_id, data FROM updates WHERE id > ? ORDER BY id').all(id) as Array<{ id: number; doc_id: string; data: Buffer }>
    return rows.map((r) => ({ id: r.id, docId: r.doc_id, data: new Uint8Array(r.data) }))
  }

  maxUpdateId(): number {
    return (this.db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM updates').get() as { m: number }).m
  }

  /** Changes whenever ANOTHER connection commits to this database file. */
  dataVersion(): number {
    return this.db.pragma('data_version', { simple: true }) as number
  }
```

`paths.ts`:

```ts
import { existsSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const APP_NAME = 'Slate'

/** The app and the MCP CLI must agree on this folder: it holds slate.db. */
export function defaultUserDataDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  if (env.SLATE_USER_DATA) return env.SLATE_USER_DATA
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', APP_NAME)
  if (platform === 'win32') return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), APP_NAME)
  return join(env.XDG_CONFIG_HOME ?? join(home, '.config'), APP_NAME)
}

/** Phase 1 builds stored data under the package name; move it once into the Slate folder. */
export function migrateLegacyUserData(newDir: string): boolean {
  const legacy = join(dirname(newDir), '@slate', 'desktop')
  if (existsSync(join(newDir, 'slate.db')) || !existsSync(join(legacy, 'slate.db'))) return false
  if (existsSync(newDir)) return false
  renameSync(legacy, newDir)
  return true
}
```

In `main/index.ts`, replace the `SLATE_USER_DATA` line with:

```ts
app.setName(APP_NAME)
const userData = defaultUserDataDir()
if (!process.env.SLATE_USER_DATA) migrateLegacyUserData(userData)
app.setPath('userData', userData)
```

(import `APP_NAME`, `defaultUserDataDir` and `migrateLegacyUserData` from `./paths`).

- [ ] **Step 4: Run** `npm run test:main && npm run typecheck && npm run e2e -- smoke.spec.ts` — PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(desktop): audit log, cross-process update feed and the Slate data folder"`

---

### Task 5: `@slate/mcp` — tools and server

**Files:** Create `packages/mcp/{package.json,vitest.config.ts}`, `src/{index,source,tools,server}.ts`, `test/{memorySource,tools.test,server.test}.ts`.

**Interfaces:**
- Consumes: `NotebookDoc` (with access), `PageDoc`, `agentBoxes`, `agentPageMarkdown`, `markdownToBlocks`, `placeBelow`, `writeContent`, `NOTEBOOK_SCOPE`, `Access`, `TreeItem` from `@slate/core`.
- Produces:
  - `interface NotebookRef { id: string; doc: NotebookDoc }`
  - `type AuditOutcome = 'ok' | 'denied' | 'not-found'`
  - `interface AuditEntry { tool: string; target: string; outcome: AuditOutcome }`
  - `interface DocSource { notebooks(): Promise<NotebookRef[]>; loadPage(pageId: string): Promise<PageDoc>; save(docId: string, update: Uint8Array): Promise<void>; audit(entry: AuditEntry): Promise<void> }`
  - `const NOT_PERMITTED = 'not found or not permitted'`
  - `listTree(src)`, `readPage(src, pageId)`, `search(src, query)`, `appendToPage(src, pageId, markdown)`, `createPage(src, notebookId, sectionId, title, markdown?)`
  - `createSlateMcpServer(src: DocSource): McpServer`

- [ ] **Step 1: Package files.**

`packages/mcp/package.json`:

```json
{
  "name": "@slate/mcp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": "./src/index.ts",
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.32.1",
    "@slate/core": "*",
    "loro-crdt": "^1.16.4",
    "zod": "^4.6.7"
  }
}
```

`packages/mcp/vitest.config.ts`:

```ts
import { defineProject } from 'vitest/config'

export default defineProject({ test: { name: 'mcp', environment: 'node', include: ['test/**/*.test.ts'] } })
```

`packages/mcp/src/index.ts`:

```ts
export * from './source'
export * from './tools'
export * from './server'
```

Run `npm install`.

- [ ] **Step 2: Write the in-memory source and the failing tests.**

`packages/mcp/test/memorySource.ts`:

```ts
import { NotebookDoc, PageDoc, writeContent } from '@slate/core'
import type { AuditEntry, DocSource } from '../src/source'

/** An in-memory DocSource with the same doc-id conventions as the desktop store. */
export function memorySource() {
  const docs = new Map<string, Uint8Array[]>()
  const audits: AuditEntry[] = []
  const save = (docId: string, update: Uint8Array) => {
    docs.set(docId, [...(docs.get(docId) ?? []), update])
  }
  const source: DocSource = {
    notebooks: async () =>
      [...docs.keys()].filter((k) => k.startsWith('notebook:')).map((k) => ({ id: k.slice('notebook:'.length), doc: NotebookDoc.fromUpdates(docs.get(k)!) })),
    loadPage: async (pageId) => PageDoc.fromUpdates(docs.get(`page:${pageId}`) ?? []),
    save: async (docId, update) => save(docId, update),
    audit: async (entry) => {
      audits.push(entry)
    },
  }
  /** Seeds one notebook "Work" with section "Ops" holding page "Deploy" (one public, one private box). */
  function seed() {
    const nb = NotebookDoc.create('Work')
    const ops = nb.addSection('Ops')
    const other = nb.addSection('Personal')
    const deploy = nb.addPage(ops, 'Deploy')
    const diary = nb.addPage(other, 'Diary')
    save('notebook:nb1', nb.doc.export({ mode: 'snapshot' }))
    const page = new PageDoc()
    const pub = page.addBox({ x: 0, y: 0, width: 300 })
    writeContent(page.contentMap(pub)!, [{ type: 'paragraph', content: [{ type: 'text', text: 'kubectl rollout status' }] }])
    const priv = page.addBox({ x: 0, y: 200, width: 300 })
    writeContent(page.contentMap(priv)!, [{ type: 'paragraph', content: [{ type: 'text', text: 'API_KEY=hunter2' }] }])
    page.doc.commit()
    page.updateBox(priv, { private: true })
    save(`page:${deploy.pageId}`, page.doc.export({ mode: 'snapshot' }))
    const diaryPage = new PageDoc()
    const d = diaryPage.addBox({ x: 0, y: 0, width: 300 })
    writeContent(diaryPage.contentMap(d)!, [{ type: 'paragraph', content: [{ type: 'text', text: 'kubectl dreams' }] }])
    diaryPage.doc.commit()
    save(`page:${diary.pageId}`, diaryPage.doc.export({ mode: 'snapshot' }))
    /** Grants in tests go through a saved update, as the app would make them. */
    const grant = (target: string, access: 'read' | 'readwrite' | null) => {
      const current = NotebookDoc.fromUpdates(docs.get('notebook:nb1')!)
      const from = current.doc.oplogVersion()
      current.setAccess(target as never, access)
      save('notebook:nb1', current.doc.export({ mode: 'update', from }))
    }
    return { ops, other, deploy, diary, grant }
  }
  return { source, docs, audits, seed }
}
```

`packages/mcp/test/tools.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { PageDoc, agentPageMarkdown } from '@slate/core'
import { appendToPage, createPage, listTree, NOT_PERMITTED, readPage, search } from '../src/tools'
import { memorySource } from './memorySource'

describe('MCP tools', () => {
  it('shows nothing without a grant, and audits the denial', async () => {
    const { source, audits, seed } = memorySource()
    const { deploy } = seed()
    expect(await listTree(source)).toEqual([])
    await expect(readPage(source, deploy.pageId)).rejects.toThrow(NOT_PERMITTED)
    expect(audits.at(-1)).toEqual({ tool: 'read_page', target: deploy.pageId, outcome: 'denied' })
  })

  it('gives the same error for unknown and forbidden pages', async () => {
    const { source, audits } = memorySource()
    await expect(readPage(source, 'does-not-exist')).rejects.toThrow(NOT_PERMITTED)
    expect(audits.at(-1)!.outcome).toBe('not-found')
  })

  it('lists only granted branches, with their access level', async () => {
    const { source, seed } = memorySource()
    const { ops, deploy, grant } = seed()
    grant(ops, 'read')
    const tree = await listTree(source)
    expect(tree).toHaveLength(1)
    expect(tree[0]).toMatchObject({ notebookId: 'nb1', name: 'Work' })
    expect(tree[0].items).toEqual([{ id: ops, kind: 'section', title: 'Ops', access: 'read', children: [{ id: deploy.id, kind: 'page', title: 'Deploy', pageId: deploy.pageId, access: 'read', children: [] }] }])
  })

  it('reads a granted page with private boxes omitted', async () => {
    const { source, seed } = memorySource()
    const { ops, deploy, grant } = seed()
    grant(ops, 'read')
    const md = await readPage(source, deploy.pageId)
    expect(md).toContain('kubectl rollout status')
    expect(md).toContain('[private box omitted]')
    expect(md).not.toContain('hunter2')
  })

  it('searches only granted, non-private content', async () => {
    const { source, seed } = memorySource()
    const { ops, deploy, grant } = seed()
    grant(ops, 'read')
    const hits = await search(source, 'KUBECTL')
    expect(hits.map((h) => h.pageId)).toEqual([deploy.pageId])
    expect(await search(source, 'hunter2')).toEqual([])
    expect(await search(source, 'dreams')).toEqual([])
  })

  it('appends only with readwrite, below the existing boxes', async () => {
    const { source, docs, seed } = memorySource()
    const { ops, deploy, grant } = seed()
    grant(ops, 'read')
    await expect(appendToPage(source, deploy.pageId, 'nope')).rejects.toThrow(NOT_PERMITTED)
    grant(ops, 'readwrite')
    await appendToPage(source, deploy.pageId, '# Agent note\n\n- step one')
    const page = PageDoc.fromUpdates(docs.get(`page:${deploy.pageId}`)!)
    expect(page.listBoxes()).toHaveLength(3)
    const md = agentPageMarkdown(page)
    expect(md.indexOf('# Agent note')).toBeGreaterThan(md.indexOf('kubectl rollout status'))
    expect(md).toContain('- step one')
  })

  it('creates a page in a readwrite section only', async () => {
    const { source, seed } = memorySource()
    const { ops, other, grant } = seed()
    grant(ops, 'readwrite')
    await expect(createPage(source, 'nb1', other, 'X')).rejects.toThrow(NOT_PERMITTED)
    const { pageId } = await createPage(source, 'nb1', ops, 'Runbook', 'step 1')
    expect(await readPage(source, pageId)).toBe('step 1')
    const tree = await listTree(source)
    expect(JSON.stringify(tree)).toContain('Runbook')
  })
})
```

`packages/mcp/test/server.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createSlateMcpServer } from '../src/server'
import { memorySource } from './memorySource'

async function connect() {
  const mem = memorySource()
  const server = createSlateMcpServer(mem.source)
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(clientSide)
  return { client, ...mem }
}

const textOf = (r: { content?: unknown }) => ((r.content as Array<{ type: string; text: string }>)[0]?.text ?? '')

describe('Slate MCP server', () => {
  it('exposes exactly the five tools', async () => {
    const { client } = await connect()
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['append_to_page', 'create_page', 'list_tree', 'read_page', 'search'])
  })

  it('returns tool errors as isError results, not protocol errors', async () => {
    const { client } = await connect()
    const r = await client.callTool({ name: 'read_page', arguments: { pageId: 'missing' } })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toBe('not found or not permitted')
  })

  it('reads a granted page end to end', async () => {
    const { client, seed } = await connect()
    const { ops, deploy, grant } = seed()
    grant(ops, 'read')
    const r = await client.callTool({ name: 'read_page', arguments: { pageId: deploy.pageId } })
    expect(textOf(r)).toContain('kubectl rollout status')
    expect(textOf(r)).not.toContain('hunter2')
  })
})
```

Run `npx vitest run packages/mcp` — FAIL (missing modules).

- [ ] **Step 3: Implement.**

`packages/mcp/src/source.ts`:

```ts
import type { NotebookDoc, PageDoc } from '@slate/core'

export interface NotebookRef {
  id: string
  doc: NotebookDoc
}

export type AuditOutcome = 'ok' | 'denied' | 'not-found'

export interface AuditEntry {
  tool: string
  target: string
  outcome: AuditOutcome
}

/** Where tools read and write. Doc ids: `notebook:<id>`, `page:<pageId>` (as in the desktop store). */
export interface DocSource {
  notebooks(): Promise<NotebookRef[]>
  loadPage(pageId: string): Promise<PageDoc>
  save(docId: string, update: Uint8Array): Promise<void>
  audit(entry: AuditEntry): Promise<void>
}
```

`packages/mcp/src/tools.ts`:

```ts
import {
  agentBoxes,
  agentPageMarkdown,
  markdownToBlocks,
  PageDoc,
  placeBelow,
  writeContent,
  type Access,
  type NotebookDoc,
  type TreeItem,
} from '@slate/core'
import type { AuditOutcome, DocSource, NotebookRef } from './source'

/** One message for unknown and forbidden ids alike, so an agent cannot probe what exists. */
export const NOT_PERMITTED = 'not found or not permitted'

class NotPermitted extends Error {
  constructor(readonly outcome: AuditOutcome) {
    super(NOT_PERMITTED)
  }
}

export interface AgentTreeItem {
  id: string
  kind: TreeItem['kind']
  title: string
  pageId?: string
  access: Access | null
  children: AgentTreeItem[]
}

export interface AgentNotebook {
  notebookId: string
  name: string
  items: AgentTreeItem[]
}

async function audited<T>(src: DocSource, tool: string, target: string, run: () => Promise<T>): Promise<T> {
  try {
    const result = await run()
    await src.audit({ tool, target, outcome: 'ok' })
    return result
  } catch (error) {
    if (error instanceof NotPermitted) await src.audit({ tool, target, outcome: error.outcome })
    throw error
  }
}

/** Keeps a node if the agent can access it or something inside it. */
function visible(nb: NotebookDoc, item: TreeItem): AgentTreeItem | null {
  const children = item.children.map((c) => visible(nb, c)).filter((c): c is AgentTreeItem => c !== null)
  const access = nb.effectiveAccess(item.id)
  if (!access && children.length === 0) return null
  return { id: item.id, kind: item.kind, title: item.title, ...(item.pageId ? { pageId: item.pageId } : {}), access, children }
}

async function findPage(src: DocSource, pageId: string, need: Access): Promise<{ ref: NotebookRef; item: TreeItem }> {
  for (const ref of await src.notebooks()) {
    const item = ref.doc.findPage(pageId)
    if (!item) continue
    const access = ref.doc.effectiveAccess(item.id)
    if (!access || (need === 'readwrite' && access !== 'readwrite')) throw new NotPermitted('denied')
    return { ref, item }
  }
  throw new NotPermitted('not-found')
}

export function listTree(src: DocSource): Promise<AgentNotebook[]> {
  return audited(src, 'list_tree', '*', async () =>
    (await src.notebooks())
      .map((ref) => ({ notebookId: ref.id, name: ref.doc.name, items: ref.doc.items().map((i) => visible(ref.doc, i)).filter((i): i is AgentTreeItem => i !== null) }))
      .filter((nb) => nb.items.length > 0),
  )
}

export function readPage(src: DocSource, pageId: string): Promise<string> {
  return audited(src, 'read_page', pageId, async () => {
    await findPage(src, pageId, 'read')
    return agentPageMarkdown(await src.loadPage(pageId))
  })
}

export interface SearchHit {
  notebookId: string
  pageId: string
  title: string
  snippet: string
}

export function search(src: DocSource, query: string): Promise<SearchHit[]> {
  return audited(src, 'search', query, async () => {
    const needle = query.toLowerCase()
    const hits: SearchHit[] = []
    for (const ref of await src.notebooks()) {
      const pages: TreeItem[] = []
      const walk = (items: TreeItem[]) => items.forEach((i) => (i.kind === 'page' ? pages.push(i) : walk(i.children)))
      walk(ref.doc.items())
      for (const item of pages) {
        if (!item.pageId || !ref.doc.effectiveAccess(item.id)) continue
        for (const box of agentBoxes(await src.loadPage(item.pageId))) {
          if (box.markdown === null) continue
          const at = box.markdown.toLowerCase().indexOf(needle)
          if (at < 0) continue
          hits.push({ notebookId: ref.id, pageId: item.pageId, title: item.title, snippet: box.markdown.slice(Math.max(0, at - 60), at + needle.length + 60) })
          break
        }
      }
    }
    return hits
  })
}

export function appendToPage(src: DocSource, pageId: string, markdown: string): Promise<{ boxId: string }> {
  return audited(src, 'append_to_page', pageId, async () => {
    await findPage(src, pageId, 'readwrite')
    const page = await src.loadPage(pageId)
    const from = page.doc.oplogVersion()
    const { x, y } = placeBelow(page)
    const boxId = page.addBox({ x, y, width: 480 })
    writeContent(page.contentMap(boxId)!, markdownToBlocks(markdown))
    page.doc.commit()
    await src.save(`page:${pageId}`, page.doc.export({ mode: 'update', from }))
    return { boxId }
  })
}

export function createPage(src: DocSource, notebookId: string, sectionId: string, title: string, markdown?: string): Promise<{ pageId: string }> {
  return audited(src, 'create_page', `${notebookId}/${sectionId}`, async () => {
    const ref = (await src.notebooks()).find((n) => n.id === notebookId)
    const section = ref?.doc.get(sectionId as never)
    if (!ref || !section || section.kind !== 'section') throw new NotPermitted('not-found')
    if (ref.doc.effectiveAccess(section.id) !== 'readwrite') throw new NotPermitted('denied')
    const from = ref.doc.doc.oplogVersion()
    const { pageId } = ref.doc.addPage(section.id, title)
    await src.save(`notebook:${notebookId}`, ref.doc.doc.export({ mode: 'update', from }))
    const page = new PageDoc()
    if (markdown && markdown.trim() !== '') {
      const boxId = page.addBox({ x: 40, y: 40, width: 480 })
      writeContent(page.contentMap(boxId)!, markdownToBlocks(markdown))
      page.doc.commit()
    }
    await src.save(`page:${pageId}`, page.doc.export({ mode: 'snapshot' }))
    return { pageId }
  })
}
```

`packages/mcp/src/server.ts`:

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { DocSource } from './source'
import { appendToPage, createPage, listTree, readPage, search } from './tools'

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

async function respond(run: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const value = await run()
    return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] }
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }
  }
}

export function createSlateMcpServer(src: DocSource): McpServer {
  const server = new McpServer({ name: 'slate', version: '0.1.0' })
  server.registerTool(
    'list_tree',
    { description: 'List the notebooks, sections and pages the user has shared with AI agents, with each item\'s access ("read" or "readwrite"). Use the pageId values with read_page.' },
    () => respond(() => listTree(src)),
  )
  server.registerTool(
    'read_page',
    { description: 'Read a shared page as Markdown. Boxes are separated by "---". Private boxes appear as "[private box omitted]".', inputSchema: { pageId: z.string() } },
    ({ pageId }) => respond(() => readPage(src, pageId)),
  )
  server.registerTool(
    'search',
    { description: 'Case-insensitive text search across shared pages. Returns page ids, titles and snippets.', inputSchema: { query: z.string().min(1) } },
    ({ query }) => respond(() => search(src, query)),
  )
  server.registerTool(
    'append_to_page',
    { description: 'Add a new box with Markdown content below the existing boxes of a page shared with read & write access.', inputSchema: { pageId: z.string(), markdown: z.string() } },
    ({ pageId, markdown }) => respond(() => appendToPage(src, pageId, markdown)),
  )
  server.registerTool(
    'create_page',
    {
      description: 'Create a page in a section shared with read & write access. notebookId and sectionId come from list_tree.',
      inputSchema: { notebookId: z.string(), sectionId: z.string(), title: z.string().min(1), markdown: z.string().optional() },
    },
    ({ notebookId, sectionId, title, markdown }) => respond(() => createPage(src, notebookId, sectionId, title, markdown)),
  )
  return server
}
```

- [ ] **Step 4: Run** `npx vitest run packages/mcp && npm test && npm run typecheck`. Expect all PASS. If `registerTool`'s callback types reject the `respond` result under zod 4, read `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts` (`ToolCallback`, `CallToolResult`) and fix the types. Keep the behaviour.

- [ ] **Step 5: Commit** — `git commit -am "feat(mcp): deny-by-default MCP tools over a DocSource, with audit"`

---

### Task 6: The `slate-mcp` CLI

**Files:**
- Create `packages/desktop/src/mcp/cli.ts`, `bin/slate-mcp`, `packages/desktop/e2e/mcpClient.ts`, `packages/desktop/e2e/mcp.spec.ts`.
- Modify `packages/desktop/electron.vite.config.ts`, `packages/desktop/package.json`, `CLAUDE.md`, `README.md`.

**Interfaces:**
- Consumes: `createSlateMcpServer`, `DocSource` (`@slate/mcp`); `DocStore` with `{ compact: false }`, `appendAudit`, `defaultUserDataDir` (Task 4); `NotebookDoc`, `PageDoc` (core).
- Produces: `out/main/mcp.js` (built), `bin/slate-mcp`, and the e2e helper `connectMcp(userData: string): Promise<{ client: Client; close(): Promise<void> }>` in `e2e/mcpClient.ts`.

- [ ] **Step 1: Failing e2e.** `packages/desktop/e2e/mcpClient.ts`:

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { join } from 'node:path'

const BIN = join(__dirname, '..', '..', '..', 'bin', 'slate-mcp')

/** Starts bin/slate-mcp exactly as Claude Code would, against a test data folder. */
export async function connectMcp(userData: string): Promise<{ client: Client; close(): Promise<void> }> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && k !== 'ELECTRON_RUN_AS_NODE')) as Record<string, string>
  const transport = new StdioClientTransport({ command: BIN, env: { ...env, SLATE_USER_DATA: userData }, stderr: 'pipe' })
  const client = new Client({ name: 'slate-e2e', version: '0.0.0' })
  await client.connect(transport)
  return { client, close: () => client.close() }
}

export const textOf = (r: { content?: unknown }) => ((r.content as Array<{ type: string; text: string }>)[0]?.text ?? '')
```

`packages/desktop/e2e/mcp.spec.ts`:

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, launchApp, test } from './fixtures'
import { connectMcp, textOf } from './mcpClient'

test('slate-mcp starts over stdio and denies by default', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  const { app } = await launchApp(userData) // creates the default notebook
  await app.close()
  const { client, close } = await connectMcp(userData)
  const { tools } = await client.listTools()
  expect(tools.map((t) => t.name).sort()).toEqual(['append_to_page', 'create_page', 'list_tree', 'read_page', 'search'])
  expect(JSON.parse(textOf(await client.callTool({ name: 'list_tree', arguments: {} })))).toEqual([])
  const denied = await client.callTool({ name: 'read_page', arguments: { pageId: 'anything' } })
  expect(denied.isError).toBe(true)
  expect(textOf(denied)).toBe('not found or not permitted')
  await close()
})
```

Add `"@modelcontextprotocol/sdk": "^1.32.1"` to the desktop `devDependencies` (the e2e client). Run `npm install && npm run e2e -- mcp.spec.ts` — FAIL (no `bin/slate-mcp`).

- [ ] **Step 2: Bundle workspace packages into main.** In `packages/desktop/package.json`:
  - move `@slate/core` and `@slate/editor` from `dependencies` to `devDependencies`;
  - add `"@slate/mcp": "*"` to `devDependencies`.

  electron-vite externalises only `dependencies`, and these packages are TypeScript sources, so they must be bundled into `out/main`. The renderer bundles everything anyway.

In `electron.vite.config.ts`, give `main` two entries:

```ts
  main: {
    build: {
      rollupOptions: {
        input: { index: 'src/main/index.ts', mcp: 'src/mcp/cli.ts' },
      },
    },
  },
```

- [ ] **Step 3: The CLI.** `packages/desktop/src/mcp/cli.ts`:

```ts
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { NotebookDoc, PageDoc } from '@slate/core'
import { createSlateMcpServer, type DocSource } from '@slate/mcp'
import { defaultUserDataDir } from '../main/paths'
import { DocStore } from '../main/store'

// stdout carries MCP protocol messages only; anything for a human goes to stderr.
async function main(): Promise<void> {
  const dir = defaultUserDataDir()
  mkdirSync(dir, { recursive: true })
  // Never compacts: the app owns compaction and may hold the same documents open.
  const store = new DocStore(join(dir, 'slate.db'), { compact: false })
  const source: DocSource = {
    notebooks: async () =>
      store.list('notebook:').map((docId) => ({ id: docId.slice('notebook:'.length), doc: NotebookDoc.fromUpdates(store.load(docId)) })),
    loadPage: async (pageId) => PageDoc.fromUpdates(store.load(`page:${pageId}`)),
    save: async (docId, update) => store.append(docId, update),
    audit: async (entry) => store.appendAudit(entry),
  }
  await createSlateMcpServer(source).connect(new StdioServerTransport())
  process.stderr.write(`slate-mcp: serving ${dir}\n`)
}

main().catch((error: unknown) => {
  process.stderr.write(`slate-mcp: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exit(1)
})
```

`bin/slate-mcp` (executable, `chmod +x`):

```sh
#!/bin/sh
# Slate's MCP server for AI agents. Register it with Claude Code:
#   claude mcp add slate -- /absolute/path/to/slate/bin/slate-mcp
# It runs under Electron's Node so better-sqlite3's Electron build loads; build first (npm run build -w @slate/desktop).
DIR="$(cd "$(dirname "$0")/.." && pwd)"
ELECTRON="$(cd "$DIR" && node -e 'process.stdout.write(require("electron"))')"
ELECTRON_RUN_AS_NODE=1 exec "$ELECTRON" "$DIR/packages/desktop/out/main/mcp.js" "$@"
```

- [ ] **Step 4: Docs.**
  - `CLAUDE.md` Commands table: add a row "MCP server for agents | `bin/slate-mcp` (build first); register with `claude mcp add slate -- $PWD/bin/slate-mcp`".
  - `README.md`: add a short "AI access" section with the same command. Say that nothing is shared until you grant access in the sidebar (right-click → AI access).

- [ ] **Step 5: Run** `npm run e2e -- mcp.spec.ts smoke.spec.ts && npm run typecheck && npm test`. Expect PASS. Also check that `out/main/mcp.js` contains no `require("@slate/` (`grep -c 'require("@slate' packages/desktop/out/main/mcp.js` → 0).

- [ ] **Step 6: Commit** — `git commit -am "feat(desktop): slate-mcp stdio CLI over the app's database"`

---

### Task 7: Permissions UI and AI Activity panel

**Files:**
- Create `packages/desktop/src/renderer/src/sidebar/accessMenu.ts`, `packages/desktop/src/renderer/src/AiActivity.tsx`, `packages/desktop/src/renderer/src/ai.css`, `packages/desktop/e2e/ai-access.spec.ts`.
- Modify `src/shared/api.ts`, `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/ipc.ts`, `src/main/menu.ts`, `src/renderer/src/{App.tsx,main.tsx}`, `sidebar/{SectionList,PageList,NotebookPicker}.tsx`, `sidebar/ContextMenu.tsx`.

**Interfaces:**
- Consumes: `NotebookDoc.setAccess/accessOf`, `TreeItem.access`, `NOTEBOOK_SCOPE`, `Access` (Task 1); `DocStore.listAudit` (Task 4).
- Produces:
  - `SlateApi.audit.list(limit?: number): Promise<AuditEntryRow[]>`, where `AuditEntryRow` in `shared/api.ts` is `{ id: number; ts: number; tool: string; target: string; outcome: string }`
  - `MenuCommand` adds `{ cmd: 'show-ai-activity' }`
  - menu item id `ai-activity`
  - `accessItems(nb: NotebookDoc, target: TreeItem['id'] | typeof NOTEBOOK_SCOPE): MenuItem[]`
  - test ids `ai-badge`, `ai-activity`, `ai-activity-row`, `ai-activity-close`

- [ ] **Step 1: Failing e2e.** `packages/desktop/e2e/ai-access.spec.ts`:

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, launchApp, test } from './fixtures'

test('a section can be shared with AI, shows a badge, and stays shared after restart', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  const first = await launchApp(userData)
  const section = first.page.getByTestId('section-item').first()
  await expect(section.getByTestId('ai-badge')).toHaveCount(0)
  await section.click({ button: 'right' })
  await first.page.getByRole('menuitem', { name: /AI can read$/ }).click()
  await expect(section.getByTestId('ai-badge')).toHaveText('AI')
  await first.page.waitForTimeout(300)
  await first.app.close()
  const second = await launchApp(userData)
  await expect(second.page.getByTestId('section-item').first().getByTestId('ai-badge')).toBeVisible()
  await second.page.getByTestId('section-item').first().click({ button: 'right' })
  await expect(second.page.getByRole('menuitem', { name: /✓ AI can read$/ })).toBeVisible()
  await second.app.close()
})

test('the notebook itself can be shared from the notebook menu', async ({ page }) => {
  await page.getByTestId('notebook-picker').click()
  await page.getByRole('menuitem', { name: /AI can read & write$/ }).click()
  await expect(page.getByTestId('notebook-picker').getByTestId('ai-badge')).toBeVisible()
})

test('View → AI Activity opens the audit panel', async ({ app, page }) => {
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('ai-activity')!.click())
  await expect(page.getByTestId('ai-activity')).toContainText('No AI activity yet')
  await page.getByTestId('ai-activity-close').click()
  await expect(page.getByTestId('ai-activity')).toHaveCount(0)
})
```

Run `npm run e2e -- ai-access.spec.ts` — FAIL.

- [ ] **Step 2: Plumbing.**
  - `shared/api.ts`:
    - add `export interface AuditEntryRow { id: number; ts: number; tool: string; target: string; outcome: string }`;
    - add `| { cmd: 'show-ai-activity' }` to `MenuCommand`;
    - add `audit: { list(limit?: number): Promise<AuditEntryRow[]> }` to `SlateApi`.
  - `shared/ipc.ts`: add `auditList: 'audit:list'`.
  - `main/ipc.ts`: `ipcMain.handle(CH.auditList, (_e, limit?: number) => store.listAudit(limit ?? 200))`.
  - preload: `audit: { list: (limit) => ipcRenderer.invoke(CH.auditList, limit) }`.
  - `main/menu.ts`, View submenu, after Markdown Shortcuts: `{ id: 'ai-activity', label: 'AI Activity…', click: () => send({ cmd: 'show-ai-activity' }) }`.

- [ ] **Step 3: Access menu items and badges.** `sidebar/accessMenu.ts`:

```ts
import { NOTEBOOK_SCOPE, type Access, type NotebookDoc, type TreeItem } from '@slate/core'
import type { MenuItem } from './ContextMenu'

const OPTIONS: Array<{ access: Access | null; label: string }> = [
  { access: null, label: 'No AI access' },
  { access: 'read', label: 'AI can read' },
  { access: 'readwrite', label: 'AI can read & write' },
]

/** Context-menu entries that set the explicit AI grant on a node or on the whole notebook. */
export function accessItems(nb: NotebookDoc, target: TreeItem['id'] | typeof NOTEBOOK_SCOPE): MenuItem[] {
  const current = nb.accessOf(target)
  return OPTIONS.map((o) => ({ label: `${current === o.access ? '✓ ' : ''}${o.label}`, onSelect: () => nb.setAccess(target, o.access) }))
}

export function accessTitle(access: Access): string {
  return access === 'readwrite' ? 'Shared with AI agents: read & write' : 'Shared with AI agents: read only'
}
```

In `SectionList.openMenu` and `PageList.openMenu`, insert `...accessItems(nb, item.id)` (`page.id` in PageList) before the Delete entry. Render the badge after the label in both lists:

```tsx
{item.access && (
  <span className="ai-badge" data-testid="ai-badge" title={accessTitle(item.access)}>
    AI
  </span>
)}
```

In `NotebookPicker`:
- render the same badge inside the `notebook-current` button when `current.doc.accessOf(NOTEBOOK_SCOPE)` is set;
- add the three access entries to its menu as `role="menuitem"` buttons (after "Rename notebook") that call `current.doc.setAccess(NOTEBOOK_SCOPE, …)` and close the menu.

  Reuse `accessItems(current.doc, NOTEBOOK_SCOPE)` and map each item to a button.

- [ ] **Step 4: AI Activity panel.** `AiActivity.tsx`:

```tsx
import { useEffect, useState } from 'react'
import type { AuditEntryRow } from '../../shared/api'

const OUTCOME_TEXT: Record<string, string> = { ok: 'allowed', denied: 'denied', 'not-found': 'not found' }

export function AiActivity({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<AuditEntryRow[] | null>(null)
  useEffect(() => {
    void window.slate.audit.list(200).then(setRows)
  }, [])
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  return (
    <div className="ai-activity-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="ai-activity" data-testid="ai-activity" role="dialog" aria-label="AI Activity">
        <header>
          <h2>AI Activity</h2>
          <button type="button" data-testid="ai-activity-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        {rows === null ? null : rows.length === 0 ? (
          <p className="empty">No AI activity yet. Agents see nothing until you share a notebook, section or page (right-click → AI access).</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Tool</th>
                <th>Target</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} data-testid="ai-activity-row" className={r.outcome === 'ok' ? undefined : 'refused'}>
                  <td>{new Date(r.ts).toLocaleString()}</td>
                  <td>{r.tool}</td>
                  <td className="target">{r.target}</td>
                  <td>{OUTCOME_TEXT[r.outcome] ?? r.outcome}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
```

In `App.tsx`:
- `useMenuCommands` gets a second parameter `onShowAiActivity: () => void` and handles `case 'show-ai-activity': onShowAiActivity()`;
- `App` holds `const [aiActivity, setAiActivity] = useState(false)`, passes `() => setAiActivity(true)`, and renders `{aiActivity && <AiActivity onClose={() => setAiActivity(false)} />}` inside the provider.

`ai.css` (imported in `main.tsx`):

```css
.ai-badge { margin-left: auto; padding: 0 5px; border-radius: 3px; font-size: 10px; font-weight: 700; line-height: 16px; color: var(--accent); border: 1px solid var(--accent); flex: none; }
.notebook-current .ai-badge { margin-left: 6px; }
.ai-activity-backdrop { position: fixed; inset: 0; z-index: 30; background: rgb(0 0 0 / 0.45); display: grid; place-items: center; }
.ai-activity { width: min(820px, calc(100vw - 32px)); max-height: 80vh; overflow: auto; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 16px 20px; }
.ai-activity header { display: flex; align-items: center; justify-content: space-between; }
.ai-activity h2 { margin: 0; font-size: 16px; }
.ai-activity header button { background: none; border: none; color: var(--muted); font-size: 16px; cursor: pointer; }
.ai-activity table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 13px; }
.ai-activity th, .ai-activity td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); }
.ai-activity td.target { font-family: ui-monospace, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
.ai-activity tr.refused td { color: var(--danger); }
.ai-activity .empty { color: var(--muted); }
```

- [ ] **Step 5: Run** `npm run e2e -- ai-access.spec.ts sidebar.spec.ts && npm run typecheck`. Expect PASS. The sidebar spec's page-menu tests still pass: they click menu items by name, and the new items have distinct names.
- [ ] **Step 6: Commit** — `git commit -am "feat(desktop): per-node AI access menu, AI badges and the AI Activity panel"`

---

### Task 8: Live agent edits and the end-to-end agent flow

**Files:**
- Create `packages/desktop/src/main/externalWatch.ts`, `packages/desktop/src/main/externalWatch.test.ts`, `packages/desktop/e2e/agent-flow.spec.ts`.
- Modify `packages/desktop/src/main/index.ts`, `src/shared/{api,ipc}.ts`, `src/preload/index.ts`, `packages/editor/src/PageSession.ts`, `packages/editor/test/pageSession.test.ts`, `packages/desktop/src/renderer/src/{library.ts,App.tsx}`.

**Interfaces:**
- Consumes: `DocStore.dataVersion/updatesSince/maxUpdateId` (Task 4); `connectMcp` (Task 6); access UI (Task 7).
- Produces:
  - `interface ExternalBatch { docId: string; updates: Uint8Array[] }` (in `shared/api.ts`)
  - `createExternalWatch(store: DocStore, emit: (batches: ExternalBatch[]) => void): { check(): void; stop(): void }`, polling every 500 ms
  - `SlateApi.onExternalUpdates(handler: (batches: ExternalBatch[]) => void): () => void`
  - `PageSession.importExternal(updates: Uint8Array[]): void`
  - `Library.importExternal(notebookId: string, updates: Uint8Array[]): void`

- [ ] **Step 1: Failing unit tests.**

`externalWatch.test.ts` (runs under `npm run test:main`):

```ts
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExternalWatch } from './externalWatch'
import { DocStore } from './store'

describe('createExternalWatch', () => {
  it('emits updates other processes write, grouped by document, and nothing otherwise', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'slate-watch-')), 'slate.db')
    const app = new DocStore(file)
    const cli = new DocStore(file, { compact: false })
    const seen: Array<Array<{ docId: string; updates: Uint8Array[] }>> = []
    const watch = createExternalWatch(app, (b) => seen.push(b))
    watch.check()
    expect(seen).toEqual([])
    cli.append('page:a', new Uint8Array([1]))
    cli.append('page:a', new Uint8Array([2]))
    cli.append('notebook:n', new Uint8Array([3]))
    watch.check()
    expect(seen).toHaveLength(1)
    expect(seen[0].map((b) => [b.docId, b.updates.map((u) => Array.from(u))])).toEqual([
      ['page:a', [[1], [2]]],
      ['notebook:n', [[3]]],
    ])
    watch.check()
    expect(seen).toHaveLength(1)
    watch.stop()
    app.close()
    cli.close()
  })
})
```

Append to `packages/editor/test/pageSession.test.ts`:

```ts
  it('imports updates written by another process (an agent) and shows the new box', async () => {
    const persistence = memoryPersistence()
    const session = await PageSession.open('p9', persistence)
    const other = PageDoc.fromUpdates(persistence.data.get(pageDocId('p9')) ?? [])
    const from = other.doc.oplogVersion()
    other.addBox({ x: 40, y: 400, width: 300 })
    session.importExternal([other.doc.export({ mode: 'update', from })])
    await tick()
    expect(session.getBoxes()).toHaveLength(1)
    session.close()
  })
```

(import `PageDoc` from `@slate/core` at the top of that test file).

Run `npm run test:main` and `npx vitest run packages/editor` — FAIL.

- [ ] **Step 2: Implement the watcher.** `externalWatch.ts`:

```ts
import type { ExternalBatch } from '../shared/api'
import type { DocStore } from './store'

const POLL_MS = 500

/**
 * Feeds the renderer the updates another process (the slate-mcp CLI) wrote to the database.
 * `PRAGMA data_version` changes only for other connections' commits, so this costs one cheap query
 * per tick while nothing happens. Rows the app itself wrote can be included; Loro imports are
 * idempotent, so re-importing them is harmless.
 */
export function createExternalWatch(store: DocStore, emit: (batches: ExternalBatch[]) => void): { check(): void; stop(): void } {
  let version = store.dataVersion()
  let lastId = store.maxUpdateId()
  const check = () => {
    const now = store.dataVersion()
    if (now === version) return
    version = now
    const rows = store.updatesSince(lastId)
    if (rows.length === 0) return
    lastId = rows[rows.length - 1].id
    const byDoc = new Map<string, Uint8Array[]>()
    for (const row of rows) byDoc.set(row.docId, [...(byDoc.get(row.docId) ?? []), row.data])
    emit([...byDoc].map(([docId, updates]) => ({ docId, updates })))
  }
  const timer = setInterval(check, POLL_MS)
  return { check, stop: () => clearInterval(timer) }
}
```

- `shared/api.ts`: add `export interface ExternalBatch { docId: string; updates: Uint8Array[] }` and `onExternalUpdates(handler: (batches: ExternalBatch[]) => void): () => void` to `SlateApi`.
- `shared/ipc.ts`: `externalUpdates: 'docs:external'`.
- preload: mirror `onMenu` for `CH.externalUpdates`.
- `main/index.ts`: after `registerIpc`, add
  `const watch = createExternalWatch(store, (batches) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send(CH.externalUpdates, batches)))`
  and call `watch.stop()` in `will-quit` before `store.close()`.

- [ ] **Step 3: Import in the renderer.**
  - `PageSession`: `importExternal(updates: Uint8Array[]): void { if (updates.length > 0) this.doc.importBatch(updates) }`. Imported changes arrive as `import` events: box editors update through loro-prosemirror, and box-level changes refresh the snapshot.
  - `Library`: `importExternal(notebookId: string, updates: Uint8Array[]): void`. Find the entry by id and call `entry.doc.doc.importBatch(updates)`. Ignore unknown notebooks; agents cannot create notebooks.
  - In `App`'s `Workspace` (it has `library`), add:

```tsx
  useEffect(
    () =>
      window.slate.onExternalUpdates((batches) => {
        for (const { docId, updates } of batches) {
          if (docId.startsWith('notebook:')) library.importExternal(docId.slice('notebook:'.length), updates)
          const session = currentSession.get()
          if (session && docId === `page:${session.pageId}`) session.importExternal(updates)
        }
      }),
    [library],
  )
```

- [ ] **Step 4: The end-to-end agent flow.** `agent-flow.spec.ts`:

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MOD, expect, launchApp, test } from './fixtures'
import { connectMcp, textOf } from './mcpClient'

test('an agent reads shared notes without private boxes, writes live into the open app, and is audited', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'slate-e2e-'))
  const { app, page } = await launchApp(userData)
  const focused = page.locator('[data-testid="box-editor"]:focus')

  await page.getByTestId('canvas').click({ position: { x: 60, y: 60 } })
  await expect(focused).toHaveText('')
  await page.keyboard.type('visible ')
  await page.keyboard.press(`${MOD}+b`)
  await page.keyboard.type('bold')
  await page.getByTestId('canvas').click({ position: { x: 60, y: 260 } })
  await expect(focused).toHaveText('')
  await page.keyboard.type('API_KEY=hunter2')
  const secret = page.getByTestId('box').filter({ hasText: 'hunter2' })
  await secret.hover()
  await secret.getByTestId('box-lock').click()

  await page.getByTestId('notebook-picker').click()
  await page.getByRole('menuitem', { name: /AI can read & write$/ }).click()
  await page.waitForTimeout(300)

  const { client, close } = await connectMcp(userData)
  const tree = JSON.parse(textOf(await client.callTool({ name: 'list_tree', arguments: {} })))
  const section = tree[0].items[0]
  const pageId: string = section.children[0].pageId

  const md = textOf(await client.callTool({ name: 'read_page', arguments: { pageId } }))
  expect(md).toContain('visible **bold**')
  expect(md).toContain('[private box omitted]')
  expect(md).not.toContain('hunter2')
  expect(JSON.parse(textOf(await client.callTool({ name: 'search', arguments: { query: 'hunter2' } })))).toEqual([])

  await client.callTool({ name: 'append_to_page', arguments: { pageId, markdown: 'note from the agent' } })
  await expect(page.getByTestId('box').filter({ hasText: 'note from the agent' })).toBeVisible({ timeout: 5000 })

  await client.callTool({ name: 'create_page', arguments: { notebookId: tree[0].notebookId, sectionId: section.id, title: 'Agent runbook', markdown: 'step 1' } })
  await expect(page.getByTestId('page-item').filter({ hasText: 'Agent runbook' })).toBeVisible({ timeout: 5000 })
  await close()

  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('ai-activity')!.click())
  const rows = page.getByTestId('ai-activity-row')
  await expect(rows.filter({ hasText: 'append_to_page' })).toHaveCount(1)
  await expect(rows.filter({ hasText: 'read_page' })).toHaveCount(1)
  await app.close()
})
```

- [ ] **Step 5: Run** `npm run test:main && npm test && npm run typecheck && npm run e2e`, the whole suite, twice. Expect all PASS.

  If `visible **bold**` fails because loro-prosemirror stores the bold mark under a different key or value than `contentToJSON` expects, look at the real delta first:
  - debug-log `LoroText.toDelta()` of that box from a scratch test;
  - fix `contentToJSON` in core;
  - add a core unit test reproducing the real delta.

  Never weaken the e2e assertion.

- [ ] **Step 6: Commit** — `git commit -am "feat: agent edits appear live in the open app; end-to-end AI access flow"`

---

## Done criteria for Phase 2

- Run `claude mcp add slate -- <repo>/bin/slate-mcp`. Before you share anything, an agent's `list_tree` returns `[]`.
- Right-click a section → AI can read: the badge appears, and the agent can list, read and search its pages.
- Private boxes come through as `[private box omitted]` and never match a search.
- With read & write access, `append_to_page` and `create_page` show up in the open app within about a second.
- View → AI Activity lists every call, including denials.
- All unit, mcp, main-process and e2e tests pass.
