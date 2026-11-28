// Erase history (GDPR-04) against the real DocStore and search index: the bytes of deleted text
// leave the database file and its WAL, and the page reads, and keeps being edited, as before.
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PageDoc, type PMJSON } from '@slate/core'
import { SearchIndex } from '../search/searchIndex'
import { DocStore } from '../store'
import { eraseDocHistory } from './erase'

const MARKER = 'OKAPI-ERASED-51d2'
const PAGE = 'page:0b7e1c52-5f0c-4c1e-9a43-7d1f2b9e6a10'
const para = (text: string): PMJSON => ({ type: 'paragraph', content: [{ type: 'text', text }] })

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'slate-erase-store-'))
  dirs.push(dir)
  const file = join(dir, 'slate.db')
  const store = new DocStore(file, { compact: false })
  const search = new SearchIndex(store, { debounceMs: 60_000 })
  const changed = (docId: string) => {
    search.docChanged(docId)
    search.flush()
  }
  return { file, store, search, changed }
}

/** Each change is its own row, as a page's saves are. */
function edit(store: DocStore, page: PageDoc, change: (p: PageDoc) => void): void {
  const from = page.doc.oplogVersion()
  change(page)
  page.doc.commit()
  store.append(PAGE, page.doc.export({ mode: 'update', from }))
}

const inFile = (file: string, text: string) => [file, `${file}-wal`].some((f) => existsSync(f) && readFileSync(f).includes(text))

const texts = (page: PageDoc) =>
  page
    .listBoxes()
    .sort((a, b) => a.y - b.y)
    .map((b) => JSON.stringify(page.boxContent(b.id)))
    .join('\n')

describe('erase history on the real DocStore (GDPR-04)', () => {
  it('removes deleted text from slate.db and its WAL; the page reads its current text, and an edit after the erase survives a reload', () => {
    const { file, store, search, changed } = setup()
    const page = new PageDoc()
    let kept = ''
    edit(store, page, (p) => (kept = p.addBox({ x: 0, y: 0, width: 300, content: [para('keep this')] })))
    let doomed = ''
    edit(store, page, (p) => (doomed = p.addBox({ x: 0, y: 200, width: 300, content: [para(`secret ${MARKER}`)] })))
    changed(PAGE)
    edit(store, page, (p) => p.updateBox(kept, { x: 10 }))
    edit(store, page, (p) => p.deleteBox(doomed))
    changed(PAGE)
    // The deleted text is still in the history: the check below can see it.
    expect(inFile(file, MARKER)).toBe(true)

    eraseDocHistory(store, PAGE, false, changed, () => null)

    expect(inFile(file, MARKER)).toBe(false)
    const loaded = PageDoc.fromUpdates(store.load(PAGE))
    expect(texts(loaded)).toBe(texts(page))
    expect(texts(loaded)).toContain('keep this')
    expect(loaded.getBox(kept)?.x).toBe(10)
    expect(store.searchRows(null, 'keep this').map((r) => r.boxId)).toEqual([kept])
    expect(store.searchRows(null, MARKER)).toEqual([])

    // The open editor's doc keeps editing; its update lands on the shallow snapshot.
    edit(store, page, (p) => p.addBox({ x: 0, y: 400, width: 300, content: [para('written after')] }))
    // A doc loaded from the erased store edits too.
    edit(store, loaded, (p) => p.updateBox(kept, { width: 320 }))
    search.close()
    store.close()

    const reopened = new DocStore(file, { compact: false })
    const back = PageDoc.fromUpdates(reopened.load(PAGE))
    expect(texts(back)).toContain('written after')
    expect(texts(back)).toContain('keep this')
    expect(back.getBox(kept)?.width).toBe(320)
    expect(back.listBoxes()).toHaveLength(2)
    // Compaction folds the snapshot and the later rows into one that reads the same.
    reopened.compact(PAGE)
    expect(reopened.load(PAGE)).toHaveLength(1)
    expect(texts(PageDoc.fromUpdates(reopened.load(PAGE)))).toBe(texts(back))
    reopened.close()
    expect(inFile(file, MARKER)).toBe(false)
  })
})
