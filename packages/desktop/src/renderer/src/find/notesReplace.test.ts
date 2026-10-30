import { describe, expect, it } from 'vitest'
import { contentToJSON, PageDoc, writeContent, type PMJSON } from '@slate/core'
import { PageSession, pageDocId, type DocPersistence } from '@slate/editor'
import { openPageSession, replaceInNotes } from './notesReplace'

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

/** Writes a page with one box per text straight into the store, as another device or an import would. */
function seed(persistence: ReturnType<typeof store>, pageId: string, ...texts: string[]): string[] {
  const page = new PageDoc()
  const ids = texts.map((t, i) => {
    const id = page.addBox({ x: 0, y: i * 100, width: 400 })
    writeContent(page.contentMap(id)!, [para(t)], page.doc)
    page.doc.commit()
    return id
  })
  persistence.data.set(pageDocId(pageId), [page.doc.export({ mode: 'snapshot' })])
  return ids
}

async function storedTexts(persistence: DocPersistence, pageId: string): Promise<string[]> {
  const page = PageDoc.fromUpdates(await persistence.load(pageDocId(pageId)))
  return page
    .listBoxes()
    .sort((a, b) => a.y - b.y)
    .map((b) => contentToJSON(page.contentMap(b.id)!)!.content![0]!.content![0]!.text!)
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('replaceInNotes', () => {
  it('replaces the picked matches across three pages, one on screen and two closed', async () => {
    const persistence = store()
    const [a1] = seed(persistence, 'A', 'cat on screen')
    const [b1, b2] = seed(persistence, 'B', 'cat and cat', 'Cat')
    const [c1] = seed(persistence, 'C', 'a cat')
    const onScreen = await PageSession.open('A', persistence)

    const result = await replaceInNotes(
      {
        query: 'cat',
        opts: plain,
        replacement: 'dog',
        preserveCase: true,
        pages: [
          { pageId: 'A', picks: [{ boxId: a1!, occurrence: 0 }] },
          // The second "cat" in B's first box is unticked.
          { pageId: 'B', picks: [{ boxId: b1!, occurrence: 0 }, { boxId: b2!, occurrence: 0 }] },
          { pageId: 'C', picks: [{ boxId: c1!, occurrence: 0 }] },
        ],
      },
      { persistence, onScreen: () => onScreen },
    )
    await tick()
    expect(result).toEqual({ replaced: 4, pages: 3 })
    expect(await storedTexts(persistence, 'A')).toEqual(['dog on screen'])
    expect(await storedTexts(persistence, 'B')).toEqual(['dog and cat', 'Dog'])
    expect(await storedTexts(persistence, 'C')).toEqual(['a dog'])

    // The page on screen took it as one undo step of its own session.
    onScreen.undo()
    await tick()
    expect(await storedTexts(persistence, 'A')).toEqual(['cat on screen'])
    onScreen.close()
  })

  it('keeps a closed page’s replace as one undo step for when it is opened, after edits from elsewhere', async () => {
    const persistence = store()
    const [b1] = seed(persistence, 'B2', 'cat cat')
    await replaceInNotes(
      { query: 'cat', opts: plain, replacement: 'dog', preserveCase: false, pages: [{ pageId: 'B2', picks: [{ boxId: b1!, occurrence: 0 }, { boxId: b1!, occurrence: 1 }] }] },
      { persistence, onScreen: () => null },
    )
    await tick()
    // Another device's edit arrives in the store while the page is closed.
    const other = PageDoc.fromUpdates(await persistence.load(pageDocId('B2')))
    const extra = other.addBox({ x: 0, y: 300, width: 400 })
    writeContent(other.contentMap(extra)!, [para('remote')], other.doc)
    other.doc.commit()
    await persistence.append(pageDocId('B2'), other.doc.export({ mode: 'update' }))

    const opened = await openPageSession('B2', persistence)
    expect(opened.getBoxes()).toHaveLength(2)
    expect(opened.undo()).toBe(true)
    await tick()
    expect(await storedTexts(persistence, 'B2')).toEqual(['cat cat', 'remote'])
    expect(opened.undoManager.canUndo()).toBe(false)
    opened.close()
    // Taken once: the next open is a fresh session.
    const again = await openPageSession('B2', persistence)
    expect(again).not.toBe(opened)
    again.close()
  })

  it('a second replace on a held page stacks on the same session', async () => {
    const persistence = store()
    const [b1] = seed(persistence, 'B3', 'cat')
    const run = (query: string, replacement: string) =>
      replaceInNotes({ query, opts: plain, replacement, preserveCase: false, pages: [{ pageId: 'B3', picks: [{ boxId: b1!, occurrence: 0 }] }] }, { persistence, onScreen: () => null })
    await run('cat', 'dog')
    await run('dog', 'emu')
    const opened = await openPageSession('B3', persistence)
    opened.undo()
    await tick()
    expect(await storedTexts(persistence, 'B3')).toEqual(['dog'])
    opened.undo()
    await tick()
    expect(await storedTexts(persistence, 'B3')).toEqual(['cat'])
    opened.close()
  })

  it('opens nothing it did not change', async () => {
    const persistence = store()
    seed(persistence, 'B4', 'nothing here')
    const result = await replaceInNotes(
      { query: 'cat', opts: plain, replacement: 'dog', preserveCase: false, pages: [{ pageId: 'B4', picks: [{ boxId: 'gone', occurrence: 0 }] }, { pageId: 'empty', picks: [] }] },
      { persistence, onScreen: () => null },
    )
    expect(result).toEqual({ replaced: 0, pages: 0 })
    expect((await openPageSession('B4', persistence)).undoManager.canUndo()).toBe(false)
  })
})
