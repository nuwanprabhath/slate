import { describe, expect, it } from 'vitest'
import { contentToJSON } from '@slate/core'
import { writeContent } from '../src/content'
import { PageSession, pageDocId, type DocPersistence } from '../src/PageSession'

/**
 * F1: Loro updates are incremental, so a single rejected append makes every later edit unloadable.
 * The fake rejects one append in the middle of a burst of edits; what reloads must still be what the
 * user typed.
 */
function flakyPersistence(rejectCall: number): DocPersistence & { data: Map<string, Uint8Array[]>; calls: number } {
  const data = new Map<string, Uint8Array[]>()
  const p = {
    data,
    calls: 0,
    load: async (id: string) => data.get(id) ?? [],
    append: async (id: string, update: Uint8Array) => {
      p.calls++
      if (p.calls === rejectCall) throw new Error('disk full')
      data.set(id, [...(data.get(id) ?? []), update])
    },
  }
  return p
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))
const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] })

function textOf(session: PageSession, boxId: string): string {
  return JSON.stringify(contentToJSON(session.page.contentMap(boxId)!))
}

describe('durable saves', () => {
  it('reloads every edit after one append was rejected', async () => {
    const persistence = flakyPersistence(2)
    const session = await PageSession.open('p1', persistence)
    const box = session.createBox(0, 0)
    await tick()
    for (const word of ['one ', 'one two ', 'one two three ', 'one two three four']) {
      writeContent(session.page.contentMap(box)!, [para(word)], session.doc)
      session.doc.commit()
      await tick()
    }
    await tick(10)
    const live = textOf(session, box)
    expect(live).toContain('one two three four')
    session.close()

    const reopened = await PageSession.open('p1', persistence)
    expect(reopened.getBoxes().map((b) => b.id)).toEqual([box])
    expect(textOf(reopened, box)).toBe(live)
    reopened.close()
  })

  it('reports unsaved while the store rejects and saved once it takes the write', async () => {
    let fail = true
    const data = new Map<string, Uint8Array[]>()
    const persistence: DocPersistence = {
      load: async (id) => data.get(id) ?? [],
      append: async (id, update) => {
        if (fail) throw new Error('disk full')
        data.set(id, [...(data.get(id) ?? []), update])
      },
    }
    const session = await PageSession.open('p2', persistence)
    session.createBox(0, 0)
    await tick(10)
    expect(session.saves.state).toBe('unsaved')
    expect(session.saves.error).toContain('disk full')
    fail = false
    await session.saves.idle(3000)
    expect(session.saves.state).toBe('saved')
    expect(session.saves.error).toBeUndefined()
    session.close()
  })
})
