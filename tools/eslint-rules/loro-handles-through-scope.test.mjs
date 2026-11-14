// @ts-check
import { describe, expect, it } from 'vitest'
import { CUSTOM } from './plugin.mjs'
import loroHandlesThroughScope from './loro-handles-through-scope.mjs'
import { allowlist, matchesAny } from './paths.mjs'
import { FIXTURE, ruleTester } from './ruleTester.mjs'

const IMPORTS =
  "import { LoroDoc, LoroList, LoroMap, LoroText, type LoroTree, type LoroTreeNode } from 'loro-crdt'\n" +
  "import { contentToJSON, PageDoc, withHandles, type Handles } from '@slate/core'\n" +
  'declare const doc: LoroDoc, m: LoroMap, list: LoroList, tree: LoroTree, node: LoroTreeNode, page: PageDoc, id: string, update: Uint8Array\n' +
  'export const used = [LoroDoc, LoroList, LoroMap, LoroText, contentToJSON, PageDoc, withHandles]\n'
const typed = (/** @type {string} */ code) => ({ filename: FIXTURE, code: IMPORTS + code })
/** @param {...('handle' | 'fork' | 'keep')} ids */
const errors = (...ids) => ({ errors: ids.map((messageId) => ({ messageId })) })
/** The fixture file standing in for one the allowlist names. */
const handOut = (/** @type {string[]} */ ...names) => ({ options: [{ handOut: { 'tools/eslint-rules/fixtures/file.ts': names } }] })

ruleTester({ typed: true }).run('slate/loro-handles-through-scope', /** @type {any} */ (loroHandlesThroughScope), {
  valid: [
    // Core's own shape (page.ts): each read inside own(, also one expected to return a number.
    typed("export const x = withHandles((h) => Number(h.own(h.own(doc.getMap('boxes')).get('x')) ?? 0))"),
    typed("export const on = withHandles((h) => h.own(h.own(doc.getMap('meta')).get('needsLayout')) === true)"),
    typed("withHandles((h) => {\n  const box = h.own(m.setContainer(id, h.own(new LoroMap())))\n  box.set('x', 1)\n  h.own(h.own(box.setContainer('children', h.own(new LoroList()))).insertContainer(0, h.own(new LoroText()))).insert(0, 'a')\n})"),
    // A helper given the scope owns into it (PageDoc.boxes, boxMap), through `?.`, `!` and `as`.
    typed(
      "function boxes(h: Handles): LoroMap {\n  return h.own(doc.getMap('boxes'))\n}\nfunction boxMap(key: string, h: Handles): LoroMap | undefined {\n  const value = h.own(boxes(h).get(key))\n  return value instanceof LoroMap ? value : undefined\n}\n" +
        "export const contentId = withHandles((h) => (h.own(boxMap(id, h)?.get('content')) as LoroMap).id)\nexport const size = withHandles((h) => h.own(tree.getNodeByID(`0@1`)!).index())",
    ),
    // A tree walk (tree.ts): the node list, each child list, each node's data.
    typed('function visit(n: LoroTreeNode, h: Handles): number {\n  let count = h.own(n.data).size\n  for (const child of h.own(n.children()) ?? []) count += visit(child, h)\n  return count\n}\nexport const total = withHandles((h) => h.own(tree.roots()).reduce((sum, n) => sum + visit(n, h), 0))'),
    // FX-37's fix as the scope writes it: the fork is freed when the scope ends, also when import throws.
    typed('export const touched = withHandles((h) => {\n  const fork = h.own(doc.fork())\n  fork.import(update)\n  return fork.frontiers().length\n})'),
    // `own` under another name is still Handles' own.
    typed("export const n = withHandles((h) => {\n  const { own } = h\n  return own(doc.getMap('boxes')).size\n})"),
    // Data, not handles: core's data readers, Loro's JSON exports, sizes and keys, a plain JS Map, JSON.parse.
    typed("export const json = page.boxContent(id)\nexport const boxes = page.listBoxes()\nexport const all = doc.toJSON()\nexport const n = doc.frontiers().length\nexport const ids = m.keys().sort()\nexport const plain = m.toJSON()"),
    typed("declare const text: string\nconst seen = new Map<string, number>()\nexport const a = seen.get('a')\nexport const b: unknown = JSON.parse(text)\nexport const texts = new Map<string, LoroText>()"),
    typed('export const isMap = (value: unknown): boolean => value instanceof LoroMap\nexport const made = new PageDoc(new LoroDoc())'),
    // A function the allowlist names hands its handle out (PageDoc.contentMap).
    {
      ...typed("export function contentMap(key: string): LoroMap | undefined {\n  return withHandles((h) => {\n    const content = h.own(h.own(doc.getMap('boxes')).get(key))\n    return content instanceof LoroMap ? h.keep(content) : undefined\n  })\n}"),
      ...handOut('contentMap'),
    },
  ],
  invalid: [
    // FX-33: MCP `search` read every page through agentBoxes, which took a content handle a box and freed none.
    {
      ...typed('export function agentBoxes(): unknown[] {\n  return page.listBoxes().map((box) => {\n    const content = page.contentMap(box.id)\n    return content ? contentToJSON(content) : null\n  })\n}'),
      ...errors('handle'),
    },
    // FX-35: a compaction that looks into the doc it decoded keeps it, whatever it frees afterwards.
    {
      ...typed("export function compact(parts: Uint8Array[]): Uint8Array {\n  const decoded = new LoroDoc()\n  try {\n    decoded.importBatch(parts)\n    if (decoded.getMap('boxes').size === 0) return new Uint8Array()\n    return decoded.export({ mode: 'snapshot' })\n  } finally {\n    decoded.free()\n  }\n}"),
      ...errors('handle'),
    },
    // FX-37: boxesTouched forked the page and never freed the fork; resolve took the content handle to write to.
    { ...typed('export function boxesTouched(): number {\n  const fork = doc.fork()\n  fork.import(update)\n  return fork.frontiers().length\n}'), ...errors('fork') },
    { ...typed('export const at = doc.forkAt(doc.frontiers()).frontiers()'), ...errors('fork') },
    { ...typed('export function resolve(): void {\n  const root = page.contentMap(id)\n  if (root) root.clear()\n}'), ...errors('handle') },
    // The reads themselves: a root container, a child, a list's items, a tree's nodes and their relatives.
    { ...typed("export const size = doc.getMap('boxes').size"), ...errors('handle') },
    { ...typed("export const x = m.get('x')\nexport const items = list.toArray()\nexport const pairs = m.entries()"), ...errors('handle', 'handle', 'handle') },
    { ...typed('export const n = tree.roots().length + (node.children()?.length ?? 0) + (node.parent() ? 1 : 0)'), ...errors('handle', 'handle', 'handle') },
    { ...typed('export const d = node.data.size\nexport const { data } = node'), ...errors('handle', 'handle') },
    { ...typed("export const made = withHandles((h) => h.own(m.setContainer('content', new LoroMap())).size)"), ...errors('handle') },
    { ...typed('export const found = doc.getContainerById(m.id) !== undefined'), ...errors('handle') },
    // A typed map still reads whatever a peer put under the key.
    { ...typed("declare const sized: LoroMap<{ x: number }>\nexport const x = sized.get('x')"), ...errors('handle') },
    // FX-36's blind spots: an alias, a computed member, a read on another line than its own(.
    { ...typed("const read = doc.getMap.bind(doc)\nexport const size = read('boxes').size"), ...errors('handle') },
    { ...typed("export const size = doc['getMap']('boxes').size\nexport const x = m['get']('x')"), ...errors('handle', 'handle') },
    { ...typed("export const size = withHandles((h) => {\n  const boxes = doc.getMap('boxes')\n  return h.own(boxes).size\n})"), ...errors('handle') },
    // An `own` that is not Handles' frees nothing: the read is unowned, and so is what the look-alike returns.
    { ...typed("const h = { own<T>(value: T): T {\n  return value\n} }\nexport const size = h.own(doc.getMap('boxes')).size"), ...errors('handle', 'handle') },
    // Handing a handle out is for the functions the allowlist names: keep(, and a scope that returns one.
    { ...typed("export const content = (): LoroMap => withHandles((h) => h.keep(h.own(doc.getMap('boxes'))))"), ...errors('keep', 'keep') },
    { ...typed("export const freed = (): LoroMap => withHandles((h) => h.own(doc.getMap('boxes')))"), ...errors('keep') },
    {
      ...typed("export function other(): LoroMap {\n  return withHandles((h) => h.keep(h.own(doc.getMap('boxes'))))\n}"),
      ...handOut('contentMap'),
      ...errors('keep', 'keep'),
    },
  ],
})

describe('slate/loro-handles-through-scope: where it runs', () => {
  const entry = CUSTOM.find((c) => c.name === 'loro-handles-through-scope')
  const runs = (/** @type {string} */ file) => entry !== undefined && matchesAny(file, entry.files) && !matchesAny(file, entry.ignores) && !matchesAny(file, entry.allow)

  it('covers core and everything the main process loads, with no file let off', () => {
    expect(entry?.allow ?? []).toEqual([])
    for (const file of [
      'packages/core/src/page.ts',
      'packages/core/src/handles.ts',
      'packages/desktop/src/main/store.ts',
      'packages/desktop/src/main/sync/syncService.ts',
      'packages/sync/src/conflicts.ts',
      'packages/mcp/src/tools.ts',
      'packages/importer/src/x.ts',
    ]) {
      expect(runs(file), file).toBe(true)
    }
  })

  it('leaves tests alone, and the window process, which holds handles for as long as a box is open', () => {
    for (const file of ['packages/core/test/page.test.ts', 'packages/desktop/src/main/store.test.ts', 'packages/editor/src/PageSession.ts', 'packages/desktop/src/renderer/src/App.tsx']) {
      expect(runs(file), file).toBe(false)
    }
  })

  it('lets only contentMap and planReplace hand a handle out', () => {
    const names = Object.fromEntries(Object.entries(allowlist('loro-handles')).map(([file, value]) => [file, typeof value === 'string' ? [] : value.names]))
    expect(names).toEqual({ 'packages/core/src/page.ts': ['contentMap'], 'packages/core/src/replace.ts': ['planReplace'] })
  })
})
