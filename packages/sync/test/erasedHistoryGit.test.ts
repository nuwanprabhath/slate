// A page whose history was erased (GDPR-04), synced through real git. The git drive lists a folder's files
// alphabetically, so a later chunk (`00000002.chunk`) comes before the snapshot it builds on (`snapshot-…`).
import { afterEach, describe, expect, it } from 'vitest'
import { PageDoc } from '@slate/core'
import { addTextBox, appendText, boxText, editPage, type MemoryLocal } from './memoryLocal'
import { PAGE, bareRepo, device, removeTemps } from './gitWorld'

afterEach(removeTemps)

function erase(local: MemoryLocal): void {
  const doc = local.doc(PAGE)
  local.docs.set(PAGE, [doc.export({ mode: 'shallow-snapshot', frontiers: doc.oplogFrontiers() })])
  doc.free()
}

const text = (local: MemoryLocal, boxId: string) => boxText(new PageDoc(local.doc(PAGE)), boxId)

describe('an erased page over git', { timeout: 90_000 }, () => {
  it('reaches a device that joins after later edits and a compaction, and one that had the page, and keeps them in step', async () => {
    const url = bareRepo()
    const a = device(url, 'A')
    const b = device(url, 'B')
    const id = editPage(a.local, PAGE, (p) => addTextBox(p, 'base'))
    expect((await a.engine.syncOnce()).status).toBe('idle-synced')
    expect((await b.engine.syncOnce()).status).toBe('idle-synced')
    editPage(a.local, PAGE, (p) => appendText(p, id, ' offline'))
    erase(a.local)
    expect((await a.engine.syncOnce()).status).toBe('idle-synced')
    editPage(a.local, PAGE, (p) => appendText(p, id, ' later'))
    expect((await a.engine.syncOnce()).status).toBe('idle-synced')
    const c = device(url, 'C')
    expect((await c.engine.syncOnce()).status).toBe('idle-synced')
    expect(text(c.local, id)).toBe('base offline later')
    expect((await b.engine.syncOnce()).status).toBe('idle-synced')
    expect(text(b.local, id)).toBe('base offline later')
    editPage(c.local, PAGE, (p) => appendText(p, id, ' c'))
    await c.engine.syncOnce()
    await a.engine.syncOnce()
    await b.engine.syncOnce()
    expect([text(a.local, id), text(b.local, id)]).toEqual(['base offline later c', 'base offline later c'])
  })
})
