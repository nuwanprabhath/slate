import { afterEach, describe, expect, it, vi } from 'vitest'
import { contentToJSON, PageDoc, writeContent, type PMJSON } from '@slate/core'
import { PageSession, pageDocId, type DocPersistence } from '@slate/editor'
import { closePageSession, dropPageSessions, KEPT_PAGES, openPageSession, previewInNotes, replaceInNotes, type NotesReplace } from './notesReplace'

const plain = { matchCase: false, wholeWord: false, regex: false }
const para = (t: string): PMJSON => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })

function store(): DocPersistence & { data: Map<string, Uint8Array[]> } {
  const data = new Map<string, Uint8Array[]>()
  return {
    data,
    load: async (id) => [...(data.get(id) ?? [])],
    append: async (id, update) => void data.set(id, [...(data.get(id) ?? []), update]),
  }
}

let pageCounter = 0
/** A fresh page id per call: the kept sessions are module state shared by every test. */
const newPageId = (name: string) => `${name}-${++pageCounter}`

/** Writes a page with one box per block list straight into the store, as another device or an import would. */
function seedBlocks(persistence: ReturnType<typeof store>, pageId: string, ...boxes: PMJSON[][]): string[] {
  const page = new PageDoc()
  const ids = boxes.map((blocks, i) => {
    const id = page.addBox({ x: 0, y: i * 100, width: 400 })
    writeContent(page.contentMap(id)!, blocks, page.doc)
    page.doc.commit()
    return id
  })
  persistence.data.set(pageDocId(pageId), [page.doc.export({ mode: 'snapshot' })])
  return ids
}
const seed = (persistence: ReturnType<typeof store>, pageId: string, ...texts: string[]) => seedBlocks(persistence, pageId, ...texts.map((t) => [para(t)]))

async function storedTexts(persistence: DocPersistence, pageId: string): Promise<string[]> {
  const page = PageDoc.fromUpdates(await persistence.load(pageDocId(pageId)))
  return page
    .listBoxes()
    .sort((a, b) => a.y - b.y)
    .map((b) => (contentToJSON(page.contentMap(b.id)!)!.content ?? []).map((p) => (p.content ?? []).map((c) => c.text ?? '').join('')).join('|'))
}

const tick = () => new Promise((r) => setTimeout(r, 0))
const pick = (boxId: string, occurrence: number, matched = 'cat') => ({ boxId, occurrence, matched })
const request = (pages: NotesReplace['pages'], over: Partial<NotesReplace> = {}): NotesReplace => ({ query: 'cat', opts: plain, replacement: 'dog', preserveCase: false, pages, ...over })
const deps = (persistence: DocPersistence, exists: (pageId: string) => boolean = () => true) => ({ persistence, exists })

afterEach(() => vi.restoreAllMocks())

describe('replaceInNotes', () => {
  it('replaces the picked matches across three pages, one on screen and two closed', async () => {
    const persistence = store()
    const [A, B, C] = [newPageId('A'), newPageId('B'), newPageId('C')]
    const [a1] = seed(persistence, A, 'cat on screen')
    const [b1, b2] = seed(persistence, B, 'cat and cat', 'Cat')
    const [c1] = seed(persistence, C, 'a cat')
    const onScreen = await openPageSession(A, persistence)

    const result = await replaceInNotes(
      // The second "cat" in B's first box is unticked.
      request([{ pageId: A, picks: [pick(a1!, 0)] }, { pageId: B, picks: [pick(b1!, 0), pick(b2!, 0, 'Cat')] }, { pageId: C, picks: [pick(c1!, 0)] }], { preserveCase: true }),
      deps(persistence),
    )
    await tick()
    expect(result).toEqual({ replaced: 4, pages: 3, skipped: 0, failed: 0 })
    expect(await storedTexts(persistence, A)).toEqual(['dog on screen'])
    expect(await storedTexts(persistence, B)).toEqual(['dog and cat', 'Dog'])
    expect(await storedTexts(persistence, C)).toEqual(['a dog'])

    // The page on screen took it as one undo step of its own session.
    onScreen.undo()
    await tick()
    expect(await storedTexts(persistence, A)).toEqual(['cat on screen'])
    closePageSession(onScreen)
  })

  it('keeps a closed page’s replace as one undo step for when it is opened, after edits from elsewhere', async () => {
    const persistence = store()
    const B = newPageId('B')
    const [b1] = seed(persistence, B, 'cat cat')
    await replaceInNotes(request([{ pageId: B, picks: [pick(b1!, 0), pick(b1!, 1)] }]), deps(persistence))
    await tick()
    // Another device's edit arrives in the store while the page is closed.
    const other = PageDoc.fromUpdates(await persistence.load(pageDocId(B)))
    const extra = other.addBox({ x: 0, y: 300, width: 400 })
    writeContent(other.contentMap(extra)!, [para('remote')], other.doc)
    other.doc.commit()
    await persistence.append(pageDocId(B), other.doc.export({ mode: 'update' }))

    const opened = await openPageSession(B, persistence)
    expect(opened.getBoxes()).toHaveLength(2)
    expect(opened.undo()).toBe(true)
    await tick()
    expect(await storedTexts(persistence, B)).toEqual(['cat cat', 'remote'])
    expect(opened.undoManager.canUndo()).toBe(false)
    closePageSession(opened)
    // Taken once: the next open is a fresh session.
    const again = await openPageSession(B, persistence)
    expect(again).not.toBe(opened)
    closePageSession(again)
  })

  it('a second replace on a kept page stacks on the same session', async () => {
    const persistence = store()
    const B = newPageId('B')
    const [b1] = seed(persistence, B, 'cat')
    await replaceInNotes(request([{ pageId: B, picks: [pick(b1!, 0)] }]), deps(persistence))
    await replaceInNotes(request([{ pageId: B, picks: [pick(b1!, 0, 'dog')] }], { query: 'dog', replacement: 'emu' }), deps(persistence))
    const opened = await openPageSession(B, persistence)
    opened.undo()
    await tick()
    expect(await storedTexts(persistence, B)).toEqual(['dog'])
    opened.undo()
    await tick()
    expect(await storedTexts(persistence, B)).toEqual(['cat'])
    closePageSession(opened)
  })

  it('opens nothing it did not change', async () => {
    const persistence = store()
    const B = newPageId('B')
    seed(persistence, B, 'nothing here')
    const result = await replaceInNotes(request([{ pageId: B, picks: [pick('gone', 0)] }, { pageId: newPageId('empty'), picks: [] }]), deps(persistence))
    expect(result).toEqual({ replaced: 0, pages: 0, skipped: 1, failed: 0 })
    const opened = await openPageSession(B, persistence)
    expect(opened.undoManager.canUndo()).toBe(false)
    closePageSession(opened)
  })

  it('shares one session with a page opened while the replace loads it, so no edit is made twice', async () => {
    const persistence = store()
    const P = newPageId('P')
    const [p1] = seed(persistence, P, 'the cat sat')
    const [, opened] = await Promise.all([replaceInNotes(request([{ pageId: P, picks: [pick(p1!, 0)] }]), deps(persistence)), openPageSession(P, persistence)])
    expect(opened.page.contentMap(p1!) && contentToJSON(opened.page.contentMap(p1!)!)!.content![0]!.content![0]!.text).toBe('the dog sat')
    // The user, seeing "dog", has nothing left to replace; a second replace finds no "cat".
    expect(opened.replace('cat', plain, 'dog', {})).toBe(0)
    await tick()
    expect(await storedTexts(persistence, P)).toEqual(['the dog sat'])
    closePageSession(opened)
  })

  it(`keeps at most ${String(KEPT_PAGES)} pages' sessions, dropping the oldest`, async () => {
    const persistence = store()
    const pages = Array.from({ length: KEPT_PAGES + 1 }, () => newPageId('L'))
    for (const pageId of pages) {
      const [box] = seed(persistence, pageId, 'cat')
      await replaceInNotes(request([{ pageId, picks: [pick(box!, 0)] }]), deps(persistence))
    }
    const oldest = await openPageSession(pages[0]!, persistence)
    expect(oldest.undoManager.canUndo()).toBe(false)
    expect(await storedTexts(persistence, pages[0]!)).toEqual(['dog'])
    closePageSession(oldest)
    const newest = await openPageSession(pages[KEPT_PAGES]!, persistence)
    expect(newest.undoManager.canUndo()).toBe(true)
    closePageSession(newest)
  })

  it('drops a deleted page’s kept session, and never writes to a page deleted since the search', async () => {
    const persistence = store()
    const D = newPageId('D')
    const [d1] = seed(persistence, D, 'cat')
    await replaceInNotes(request([{ pageId: D, picks: [pick(d1!, 0)] }]), deps(persistence))
    dropPageSessions([D])
    const reopened = await openPageSession(D, persistence)
    expect(reopened.undoManager.canUndo()).toBe(false)
    closePageSession(reopened)

    persistence.data.delete(pageDocId(D))
    const gone = newPageId('gone')
    const result = await replaceInNotes(
      request([
        { pageId: D, picks: [pick(d1!, 0, 'dog')] },
        { pageId: gone, picks: [pick('x', 0)] },
      ], { query: 'dog', replacement: 'emu' }),
      deps(persistence, (pageId) => pageId !== D),
    )
    await tick()
    expect(result).toEqual({ replaced: 0, pages: 0, skipped: 2, failed: 0 })
    expect(persistence.data.has(pageDocId(D))).toBe(false)
    expect(persistence.data.has(pageDocId(gone))).toBe(false)
  })

  it('goes on to the other pages when one page fails, and keeps that page’s earlier undo step', async () => {
    const persistence = store()
    const [F, G] = [newPageId('F'), newPageId('G')]
    const [f1] = seed(persistence, F, 'cat cat')
    const [g1] = seed(persistence, G, 'cat')
    await replaceInNotes(request([{ pageId: F, picks: [pick(f1!, 0)] }]), deps(persistence))
    const real = PageSession.prototype.replace
    vi.spyOn(PageSession.prototype, 'replace').mockImplementation(function (this: PageSession, ...args) {
      if (this.pageId === F) throw new Error('replace failed')
      return real.apply(this, args)
    })
    const result = await replaceInNotes(request([{ pageId: F, picks: [pick(f1!, 0)] }, { pageId: G, picks: [pick(g1!, 0)] }]), deps(persistence))
    vi.restoreAllMocks()
    expect(result).toEqual({ replaced: 1, pages: 1, skipped: 0, failed: 1 })
    expect(await storedTexts(persistence, G)).toEqual(['dog'])
    const opened = await openPageSession(F, persistence)
    expect(opened.undo()).toBe(true)
    await tick()
    expect(await storedTexts(persistence, F)).toEqual(['cat cat'])
    closePageSession(opened)
  })

  it('numbers matches as the search index does and skips a pick whose text no longer matches', async () => {
    const persistence = store()
    const P = newPageId('P')
    // The index has no row for a paragraph holding only a hard break; neither does the replace's numbering.
    const [p1] = seedBlocks(persistence, P, [{ type: 'paragraph', content: [{ type: 'hardBreak' }] }, para('a-b c')])
    const result = await replaceInNotes(
      request([{ pageId: P, picks: [pick(p1!, 0, '-'), pick(p1!, 1, '#')] }], { query: '\\W', opts: { matchCase: true, wholeWord: false, regex: true }, replacement: '+' }),
      deps(persistence),
    )
    await tick()
    expect(result).toEqual({ replaced: 1, pages: 1, skipped: 1, failed: 0 })
    expect(await storedTexts(persistence, P)).toEqual(['|a+b c'])
  })

  it('replaces a regex match spanning a code block line break, which its snippet shows as a space', async () => {
    const persistence = store()
    const P = newPageId('P')
    const [p1] = seedBlocks(persistence, P, [{ type: 'codeBlock', content: [{ type: 'text', text: 'let a\nb = 1' }] }])
    const result = await replaceInNotes(
      request([{ pageId: P, picks: [pick(p1!, 0, 'a b')] }], { query: 'a\\sb', opts: { matchCase: true, wholeWord: false, regex: true }, replacement: 'ab' }),
      deps(persistence),
    )
    await tick()
    expect(result).toEqual({ replaced: 1, pages: 1, skipped: 0, failed: 0 })
    expect(await storedTexts(persistence, P)).toEqual(['let ab = 1'])
  })
})

describe('previewInNotes', () => {
  it('works out each replacement on the whole block, not a cut snippet', async () => {
    const persistence = store()
    const P = newPageId('P')
    // The lookbehind needs the block's start, 50 characters before the match: a snippet has lost it.
    const [p1] = seed(persistence, P, `q${'-'.repeat(50)}ab`)
    const texts = await previewInNotes(
      request([{ pageId: P, picks: [pick(p1!, 0, 'ab')] }], { query: '(?<=^q.{50})(a)(b)', opts: { matchCase: true, wholeWord: false, regex: true }, replacement: '$2$1' }),
      persistence,
    )
    expect(texts.get(`${P}\n${p1!}\n0`)).toBe('ba')
  })
})
