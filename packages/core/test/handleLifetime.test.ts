// FX-36: core frees every Loro handle it reads, so `doc.free()` gives the document back at once.
//
// Loro frees nothing of a document while a handle read from it is alive, and a handle nobody freed goes only when
// Loro's FinalizationRegistry runs, in a task of its own. A caller that loops without awaiting therefore kept every
// document it read (FX-30, FX-33, FX-35). Three checks hold core to the rule, each with its own blind spot:
//   1. balance: every method and function that touches a document is run with Loro's handles counted, and none may
//      be alive afterwards. Sees nested reads; blind to a branch its case does not take.
//   2. bytes: documents are read and freed in one task and Loro's heap must not grow. The end-to-end proof; coarse.
//   3. source: every call that returns a handle sits inside `own(`. Sees every branch; blind to an alias, a computed
//      member, a read on another line than its `own(`, and anything outside packages/core/src.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as loro from 'loro-crdt'
import { LoroCounter, LoroDoc, LoroList, LoroMap, LoroMovableList, LoroText, LoroTree, LoroTreeNode } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import * as agentViewModule from '../src/agentView'
import * as contentModule from '../src/content'
import * as replaceModule from '../src/replace'
import { agentBoxes, agentPageMarkdown, placeBelow } from '../src/agentView'
import { contentToJSON, writeContent } from '../src/content'
import { withHandles } from '../src/handles'
import { PageDoc } from '../src/page'
import type { PMJSON } from '../src/plaintext'
import { applyReplace, planReplace, rehearseReplace, replaceInPage, type PlannedEdit } from '../src/replace'
import { NotebookDoc, type TreeItem } from '../src/tree'

// --- Loro's handles, counted -----------------------------------------------------------------------------------

type HandleClass = { __wrap(ptr: number): object; prototype: { free(): void } }
/** Every class Loro hands out that keeps its document alive. A fork is one too: a document nobody freed. */
const HANDLE_CLASSES = [LoroMap, LoroList, LoroMovableList, LoroText, LoroTree, LoroTreeNode, LoroCounter, LoroDoc] as unknown as HandleClass[]
/** Handles Loro returned that nobody has freed. `__wrap` is where wasm-bindgen makes every returned object. */
const live = new Set<object>()
for (const cls of HANDLE_CLASSES) {
  const wrap = cls.__wrap
  cls.__wrap = (ptr) => {
    const handle = wrap.call(cls, ptr)
    live.add(handle)
    return handle
  }
  const free = cls.prototype.free
  cls.prototype.free = function (this: object) {
    live.delete(this)
    free.call(this)
  }
}

/** Runs `op` and returns its result with the handles it read and left alive. */
function leftAlive<T>(op: () => T): { result: T; alive: number } {
  live.clear()
  const result = op()
  return { result, alive: live.size }
}

const heapBytes = (): number => (loro as unknown as { __wasm: { memory: { buffer: ArrayBuffer } } }).__wasm.memory.buffer.byteLength

// --- Fixtures --------------------------------------------------------------------------------------------------

const para = (text: string): PMJSON => ({ type: 'paragraph', content: [{ type: 'text', text }] })
const BLOCKS: PMJSON[] = [
  para(`needle ${'lorem ipsum '.repeat(20)}`),
  { type: 'paragraph', content: [{ type: 'text', text: 'plain ' }, { type: 'text', text: 'needle bold', marks: [{ type: 'bold' }] }] },
  { type: 'bulletList', content: [{ type: 'listItem', content: [para('needle in a list')] }] },
]
const PLAIN = { matchCase: false, wholeWord: false, regex: false }

/** Eight boxes of text, marks and a list; the first is private. */
const PAGE_BYTES = ((): Uint8Array => {
  const page = new PageDoc()
  for (let b = 0; b < 8; b++) page.addBox({ x: 0, y: b * 40, width: 300, content: BLOCKS })
  page.updateBox(page.stackOrder()[0]!, { private: true })
  return page.doc.export({ mode: 'snapshot' })
})()

/** A group holding a section of twelve pages, the section shared, opened on one device. */
const NOTEBOOK_BYTES = ((): Uint8Array => {
  const nb = NotebookDoc.create('Notes')
  const section = nb.addSection('Section', nb.addSectionGroup('Group'))
  for (let i = 0; i < 12; i++) nb.addPage(section, `Page ${i}`)
  nb.setAccess(section, 'read')
  nb.markOpen('device', 1)
  return nb.doc.export({ mode: 'snapshot' })
})()

interface PageFx {
  page: PageDoc
  /** Box ids from back to front; the first is the private one. */
  ids: string[]
}
function pageFx(): PageFx {
  const page = PageDoc.fromUpdates([PAGE_BYTES])
  return { page, ids: page.stackOrder() }
}

interface NotebookFx {
  nb: NotebookDoc
  group: TreeItem
  section: TreeItem
  pages: TreeItem[]
}
function notebookFx(): NotebookFx {
  const nb = NotebookDoc.fromUpdates([NOTEBOOK_BYTES])
  const group = nb.items()[0]!
  const section = group.children[0]!
  return { nb, group, section, pages: section.children }
}

/** What a case sets up before the counted call, and the call. `keeps` is how many handles its result may hold. */
interface Case<Fx> {
  arrange: (fx: Fx) => () => unknown
  keeps?: (result: unknown) => number
}
const of = <Fx>(arrange: (fx: Fx) => () => unknown): Case<Fx> => ({ arrange })

function expectBalanced<Fx>(c: Case<Fx>, fx: Fx): void {
  const op = c.arrange(fx)
  const { result, alive } = leftAlive(op)
  expect(alive, 'handles read from the document and still alive').toBe(c.keeps ? c.keeps(result) : 0)
}

// --- 1. Balance ------------------------------------------------------------------------------------------------

const PAGE_CASES: Record<string, Case<PageFx>> = {
  addBox: of(({ page }) => () => page.addBox({ x: 1, y: 2, width: 3, content: BLOCKS })),
  copyBox: of(({ page, ids }) => () => page.copyBox(ids[1]!)),
  addBoxCopies: of(({ page, ids }) => {
    const copies = [page.copyBox(ids[1]!)!, { x: 0, y: 0, width: 10, private: true, content: [] }]
    return () => page.addBoxCopies(copies)
  }),
  getBox: of(({ page, ids }) => () => page.getBox(ids[1]!)),
  listBoxes: of(({ page }) => () => page.listBoxes()),
  // The one method that hands a handle out: the caller binds to it or writes into it, and frees it.
  contentMap: { arrange: ({ page, ids }) => () => page.contentMap(ids[1]!), keeps: () => 1 },
  boxContent: of(({ page, ids }) => () => page.boxContent(ids[1]!)),
  updateBox: of(({ page, ids }) => () => page.updateBox(ids[1]!, { x: 5, height: null })),
  updateBoxes: of(({ page, ids }) => () => page.updateBoxes(new Map([[ids[1]!, { y: 9 }], [ids[2]!, { private: true }]]))),
  stackOrder: of(({ page }) => () => page.stackOrder()),
  bringToFront: of(({ page, ids }) => () => page.bringToFront(ids[0]!)),
  moveBoxes: of(({ page, ids }) => () => page.moveBoxes(new Map([[ids[1]!, 500], ['no-such-box', 1]]))),
  needsLayout: of(({ page }) => () => page.needsLayout()),
  setNeedsLayout: of(({ page }) => () => page.setNeedsLayout(true)),
  deleteBoxes: of(({ page, ids }) => () => page.deleteBoxes([ids[1]!, ids[2]!])),
  deleteBox: of(({ page, ids }) => () => page.deleteBox(ids[3]!)),
}
/** Reached only through the methods above. */
const PAGE_PRIVATE = ['boxes', 'boxMap', 'maxZ']

const NOTEBOOK_CASES: Record<string, Case<NotebookFx>> = {
  name: of(({ nb }) => () => nb.name),
  openOn: of(({ nb }) => () => nb.openOn()),
  markOpen: of(({ nb }) => () => nb.markOpen('other', 2)),
  rename: of(({ nb }) => () => nb.rename('Renamed')),
  items: of(({ nb }) => () => nb.items()),
  get: of(({ nb, section }) => () => nb.get(section.id)),
  addSectionGroup: of(({ nb, group }) => () => nb.addSectionGroup('Inner', group.id)),
  addSection: of(({ nb, group }) => () => nb.addSection('More', group.id)),
  addPage: of(({ nb, section }) => () => nb.addPage(section.id, 'New')),
  setTitle: of(({ nb, pages }) => () => nb.setTitle(pages[0]!.id, 'Titled')),
  setColor: of(({ nb, section }) => () => nb.setColor(section.id, '#000000')),
  setLevel: of(({ nb, pages }) => () => nb.setLevel(pages[1]!.id, 2)),
  moveBefore: of(({ nb, pages }) => () => nb.moveBefore(pages[5]!.id, pages[0]!.id)),
  moveAfter: of(({ nb, pages }) => () => nb.moveAfter(pages[0]!.id, pages[5]!.id)),
  moveInto: of(({ nb, section }) => () => nb.moveInto(section.id, undefined)),
  delete: of(({ nb, section }) => () => nb.delete(section.id)),
  pageIdsUnder: of(({ nb, group }) => () => nb.pageIdsUnder(group.id)),
  allPageIds: of(({ nb }) => () => nb.allPageIds()),
  accessOf: of(({ nb, section }) => () => nb.accessOf(section.id)),
  setAccess: of(({ nb, pages }) => () => nb.setAccess(pages[0]!.id, 'readwrite')),
  effectiveAccess: of(({ nb, pages }) => () => nb.effectiveAccess(pages[0]!.id)),
  findPage: of(({ nb, pages }) => () => nb.findPage(pages[11]!.pageId!)),
}
/** Reached only through the methods above. */
const NOTEBOOK_PRIVATE = ['tree', 'accessMap', 'node', 'requireNode', 'kindOf', 'assertPlacement', 'create', 'setData']

const plan = (page: PageDoc): PlannedEdit[] => planReplace(page, 'needle', PLAIN, 'thread', { preserveCase: false })

/** The functions of content.ts, replace.ts and agentView.ts that are handed a document or a container. */
const FUNCTION_CASES: Record<string, Case<PageFx>> = {
  writeContent: of(({ page }) => {
    const root = page.contentMap(page.addBox({ x: 0, y: 0, width: 1 }))!
    return () => writeContent(root, BLOCKS, page.doc)
  }),
  contentToJSON: of(({ page, ids }) => {
    const root = page.contentMap(ids[1]!)!
    return () => contentToJSON(root)
  }),
  // An edit carries the text it will write to: one handle for each text an edit names, and no other.
  planReplace: { arrange: ({ page }) => () => plan(page), keeps: (edits) => new Set((edits as PlannedEdit[]).map((e) => e.text)).size },
  applyReplace: of(({ page }) => {
    const edits = plan(page)
    return () => applyReplace(edits)
  }),
  rehearseReplace: of(({ page }) => {
    const edits = plan(page)
    return () => rehearseReplace(page.doc, edits, { bold: { expand: 'after' } })
  }),
  replaceInPage: of(({ page }) => () => replaceInPage(page, 'needle', PLAIN, 'thread', { preserveCase: false })),
  agentBoxes: of(({ page }) => () => agentBoxes(page)),
  agentPageMarkdown: of(({ page }) => () => agentPageMarkdown(page)),
  placeBelow: of(({ page }) => () => placeBelow(page)),
}
/** Exported functions that are handed neither a document nor a container. */
const FUNCTIONS_WITHOUT_A_DOCUMENT = ['agentMarkdown', 'expandReplacement', 'preserveCaseOf']

const methodsOf = (prototype: object): string[] => Object.getOwnPropertyNames(prototype).filter((name) => name !== 'constructor').sort()
const functionsOf = (module: Record<string, unknown>): string[] => Object.keys(module).filter((name) => typeof module[name] === 'function')

describe('the counter sees what Loro hands out', () => {
  it('counts a handle when it is read and forgets it when it is freed', () => {
    const doc = new LoroDoc()
    const read = leftAlive(() => doc.getMap('boxes').setContainer('a', new LoroMap()))
    expect(read.alive).toBe(2)
    for (const handle of [...live]) (handle as { free(): void }).free()
    expect(live.size).toBe(0)
  })

  it('has work to count in the fixtures: text, marks, a list, a private box, a nested tree', () => {
    const { page, ids } = pageFx()
    expect(page.getBox(ids[0]!)?.private).toBe(true)
    expect(plan(page).length).toBe(24)
    const { section, pages } = notebookFx()
    expect(section.access).toBe('read')
    expect(pages).toHaveLength(12)
  })
})

describe('every way core touches a document leaves no handle alive (FX-36)', () => {
  it('has a case for every PageDoc and NotebookDoc method, and for every function of the files that read Loro', () => {
    expect([...Object.keys(PAGE_CASES), ...PAGE_PRIVATE].sort()).toEqual(methodsOf(PageDoc.prototype))
    expect([...Object.keys(NOTEBOOK_CASES), ...NOTEBOOK_PRIVATE].sort()).toEqual(methodsOf(NotebookDoc.prototype))
    const functions = [contentModule, replaceModule, agentViewModule].flatMap(functionsOf)
    expect([...Object.keys(FUNCTION_CASES), ...FUNCTIONS_WITHOUT_A_DOCUMENT].sort()).toEqual(functions.sort())
  })

  it.each(Object.entries(PAGE_CASES))('PageDoc.%s', (_name, c) => expectBalanced(c, pageFx()))

  it.each(Object.entries(NOTEBOOK_CASES))('NotebookDoc.%s', (_name, c) => expectBalanced(c, notebookFx()))

  it.each(Object.entries(FUNCTION_CASES))('%s', (_name, c) => expectBalanced(c, pageFx()))

  it('opening a document reads none: the constructors and fromUpdates', () => {
    expect(leftAlive(() => PageDoc.fromUpdates([PAGE_BYTES])).alive).toBe(0)
    expect(leftAlive(() => NotebookDoc.fromUpdates([NOTEBOOK_BYTES])).alive).toBe(0)
    expect(leftAlive(() => NotebookDoc.create('New')).alive).toBe(0)
    expect(leftAlive(() => new NotebookDoc()).alive).toBe(0)
  })

  it('a call that throws part-way frees what it had read', () => {
    const { nb, pages } = notebookFx()
    expect(leftAlive(() => expect(() => nb.moveInto(pages[0]!.id, undefined)).toThrow('cannot be placed')).alive).toBe(0)
    const { page } = pageFx()
    const only = (_box: string, occurrence: number): boolean => {
      if (occurrence === 2) throw new Error('stop')
      return true
    }
    expect(leftAlive(() => expect(() => planReplace(page, 'needle', PLAIN, 'x', { preserveCase: false, only })).toThrow('stop')).alive).toBe(0)
  })
})

describe('a handle scope', () => {
  const handle = (name: string, freed: string[]): { free(): void } => ({ free: () => void freed.push(name) })

  it('returns what the function returns and frees what it owned, last read first, each once', () => {
    const freed: string[] = []
    const a = handle('a', freed)
    const result = withHandles((h) => {
      h.own(a)
      h.own([handle('b', freed), 7, handle('c', freed)])
      h.own(a)
      expect(h.own(5)).toBe(5)
      expect(h.own(undefined)).toBeUndefined()
      expect(freed).toEqual([])
      return 'done'
    })
    expect(result).toBe('done')
    expect(freed).toEqual(['c', 'b', 'a'])
  })

  it('leaves a kept handle to the caller when it returns, and frees it too when it throws', () => {
    const freed: string[] = []
    withHandles((h) => h.keep(h.own(handle('kept', freed))))
    expect(freed).toEqual([])
    expect(() =>
      withHandles((h) => {
        h.keep(h.own(handle('kept', freed)))
        h.own(handle('other', freed))
        throw new Error('part-way')
      }),
    ).toThrow('part-way')
    expect(freed).toEqual(['other', 'kept'])
  })

  it('refuses an async function, and a scope used after it ended', async () => {
    const freed: string[] = []
    expect(() => withHandles((h) => Promise.resolve(h.own(handle('early', freed))))).toThrow('cannot be async')
    expect(freed).toEqual(['early'])
    const late = withHandles((h) => () => h.own(handle('late', freed)))
    expect(late).toThrow('after it ended')
    await Promise.resolve()
  })

  it('gives a box content as data that matches its container, and null for a box that is not there', () => {
    const { page, ids } = pageFx()
    const root = page.contentMap(ids[1]!)!
    expect(page.boxContent(ids[1]!)).toEqual(contentToJSON(root))
    expect(page.boxContent(ids[1]!)?.content?.[0]).toEqual(BLOCKS[0])
    expect(page.boxContent(ids[1]!)?.content?.map((block) => block.type)).toEqual(['paragraph', 'paragraph', 'bulletList'])
    expect(page.boxContent('no-such-box')).toBeNull()
    // A kept handle still works after the scope that read it has ended.
    expect(root.size).toBeGreaterThan(0)
    root.free()
  })
})

// --- 2. Bytes --------------------------------------------------------------------------------------------------

const SETTLE = 500
const MEASURED = 2000
/**
 * Measured before FX-36, in one task: reading a page's boxes for an agent kept 214 kB of Loro's heap per page,
 * walking a notebook's tree 47 kB per notebook, and writing a one-box page 39 kB. After it, each reads 0. Loro's heap
 * grows 64 KiB at a time, so one step inside the 2,000 measured calls would read 33 B a call. 1 KiB is thirty times
 * over that and thirty-eight times under the smallest leak, and neither is a time.
 */
const KEPT_BYTES = 1024

/** Bytes of Loro's heap each call of `op` kept, with no turn of the event loop between calls. */
function keptPerCall(op: () => void, calls = MEASURED): number {
  for (let i = 0; i < SETTLE; i++) op()
  const settled = heapBytes()
  for (let i = 0; i < calls; i++) op()
  return (heapBytes() - settled) / calls
}

describe('doc.free() gives the document back at once, with no turn of the event loop (FX-36)', () => {
  it('reading a page for an agent keeps nothing of it', () => {
    const kept = keptPerCall(() => {
      const page = PageDoc.fromUpdates([PAGE_BYTES])
      expect(agentBoxes(page)).toHaveLength(8)
      page.doc.free()
    })
    expect(kept, "bytes of Loro's heap a page read kept").toBeLessThan(KEPT_BYTES)
  }, 120_000)

  it("walking a notebook's tree keeps nothing of it", () => {
    const { pages } = notebookFx()
    const kept = keptPerCall(() => {
      const nb = NotebookDoc.fromUpdates([NOTEBOOK_BYTES])
      expect(nb.allPageIds()).toHaveLength(12)
      expect(nb.effectiveAccess(pages[3]!.id)).toBe('read')
      expect(nb.name).toBe('Notes')
      nb.doc.free()
    })
    expect(kept, "bytes of Loro's heap a notebook walk kept").toBeLessThan(KEPT_BYTES)
  }, 120_000)

  it('writing a page keeps nothing of it', () => {
    const kept = keptPerCall(() => {
      const page = new PageDoc()
      page.addBox({ x: 0, y: 0, width: 300, content: BLOCKS })
      expect(replaceInPage(page, 'needle', PLAIN, 'thread', { preserveCase: false })).toBe(3)
      page.doc.commit()
      page.doc.free()
    })
    expect(kept, "bytes of Loro's heap a written page kept").toBeLessThan(KEPT_BYTES)
  }, 120_000)

  it('and the trap is still there: one handle left alive keeps its whole document', () => {
    live.clear()
    const kept = keptPerCall(() => {
      const doc = new LoroDoc()
      doc.import(PAGE_BYTES)
      doc.getMap('boxes')
      doc.free()
    }, 500)
    live.clear()
    // If this fails low, Loro frees a document under a live handle and the rule above can be relaxed.
    expect(kept, "bytes of Loro's heap one unfreed handle kept").toBeGreaterThan(8 * KEPT_BYTES)
  }, 120_000)
})

// --- 3. Source -------------------------------------------------------------------------------------------------

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

/** A file's lines with block comments and whole-line comments blanked, so line numbers hold. */
function codeLines(file: string): string[] {
  return readFileSync(join(SRC, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => (/^\s*\/\//.test(line) ? '' : line))
}

/**
 * Every call that can return a handle: a root container, a child, a list's or tree's items, a tree node's relatives
 * and data, a made container, a fork, and PageDoc's own `contentMap`. `.get(` is here although most reads return a
 * number or a string: a peer can put a container under any key, and then that read returns a handle. `this.get(` is
 * NotebookDoc's own `get`, which returns data.
 */
const READS =
  /\.(?:getMap|getList|getMovableList|getText|getTree|getCounter|getContainerById|getOrCreateContainer|setContainer|insertContainer|pushContainer|getAttached|getNodeByID|createNode|fork|contentMap)\(|(?<!\bthis)\.get\(|\.(?:toArray|roots|children|parent)\(\)|\.data\b|new Loro(?:Map|List|MovableList|Text|Tree|Counter)\(/g

/** Whether position `at` of the line is inside the parentheses of an `own(` on that line. */
function insideOwn(line: string, at: number): boolean {
  for (let from = line.indexOf('own('); from !== -1 && from < at; from = line.indexOf('own(', from + 1)) {
    let depth = 0
    let closed = false
    for (let i = from + 3; i < at && !closed; i++) {
      if (line[i] === '(') depth++
      else if (line[i] === ')') closed = --depth === 0
    }
    if (!closed) return true
  }
  return false
}

function unownedReads(file: string, lines: string[]): string[] {
  return lines.flatMap((line, i) => [...line.matchAll(READS)].filter((m) => !insideOwn(line, m.index)).map((m) => `${file}:${i + 1}: ${m[0]} in: ${line.trim()}`))
}

/** The files that import Loro or are handed a PageDoc or NotebookDoc. A new one needs balance cases above. */
const FILES_THAT_REACH_LORO = ['agentView.ts', 'content.ts', 'page.ts', 'replace.ts', 'tree.ts']

describe("core's source reads Loro only through a handle scope (FX-36)", () => {
  const files = readdirSync(SRC).filter((name) => name.endsWith('.ts') && name !== 'handles.ts')

  it('knows every file that reaches Loro', () => {
    const reaching = files.filter((file) => /from 'loro-crdt'|\b(?:PageDoc|NotebookDoc)\b/.test(codeLines(file).join('\n')))
    expect(reaching.sort()).toEqual(FILES_THAT_REACH_LORO)
  })

  it('passes every read that can return a handle through own(', () => {
    expect(files.flatMap((file) => unownedReads(file, codeLines(file)))).toEqual([])
  })

  it('lets a handle outlive its scope only where the caller is told it owns one', () => {
    const keeps = Object.fromEntries(files.map((file) => [file, codeLines(file).filter((line) => line.includes('keep(')).length] as const).filter(([, n]) => n > 0))
    // PageDoc.contentMap returns the container; planReplace's edits carry the texts they write to.
    expect(keeps).toEqual({ 'page.ts': 1, 'replace.ts': 1 })
  })

  it('finds an unowned read when there is one, and not an owned one', () => {
    const found = (line: string): string[] => unownedReads('x.ts', [line])
    expect(found("    return this.doc.getMap('meta').get('needsLayout') === true")).toHaveLength(2)
    expect(found('    const d = n.data')).toHaveLength(1)
    expect(found('    for (const child of children.toArray()) visit(child)')).toHaveLength(1)
    expect(found("    const box = this.boxes.setContainer(id, new LoroMap())")).toHaveLength(2)
    expect(found("    const a = h.own(x); const b = map.get('k')")).toHaveLength(1)
    expect(found("    return h.own(h.own(this.doc.getMap('meta')).get('needsLayout')) === true")).toEqual([])
    expect(found('    const box = h.own(boxes.setContainer(id, h.own(new LoroMap())))')).toEqual([])
    expect(found('    for (let n = start; n; n = h.own(n.parent())) visit(n)')).toEqual([])
  })
})
