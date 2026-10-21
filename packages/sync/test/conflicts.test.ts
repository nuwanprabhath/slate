import { describe, expect, it } from 'vitest'
import { LoroDoc } from 'loro-crdt'
import { PageDoc } from '@slate/core'
import { boxesTouched, boxMarkdown } from '../src/conflicts'
import { SyncEngine } from '../src/engine'
import { memoryDrive, type MemoryDrive } from './memoryDrive'
import { addTextBox, appendText, boxText, editPage, memoryLocal } from './memoryLocal'

const PAGE = 'page:44444444-4444-4444-8444-444444444444'

function device(remote: MemoryDrive, deviceId: string) {
  const local = memoryLocal()
  return { local, engine: new SyncEngine({ local, remote, deviceId, deviceName: deviceId }) }
}

/** A and B share one page with two boxes; both have synced it. */
async function shared() {
  const remote = memoryDrive()
  const a = device(remote, 'A')
  const b = device(remote, 'B')
  const [x, y] = editPage(a.local, PAGE, (p) => [addTextBox(p, 'base'), addTextBox(p, 'other', { x: 0, y: 300 })])
  await a.engine.syncOnce()
  await b.engine.syncOnce()
  await a.engine.syncOnce()
  return { remote, a, b, x: x!, y: y! }
}

describe('boxesTouched', () => {
  it('reports content edits and deletions by box', () => {
    const page = new PageDoc(new LoroDoc())
    const [x, y, z] = [addTextBox(page, 'x'), addTextBox(page, 'y'), addTextBox(page, 'z')]
    const base = page.doc.fork()
    const v = page.doc.oplogVersion()
    appendText(page, x, '!')
    page.deleteBox(y)
    page.updateBox(z, { x: 50 })
    const touched = boxesTouched(base, page.doc.export({ mode: 'update', from: v }))
    expect([...touched.contentEdited]).toEqual([x])
    expect([...touched.deleted]).toEqual([y])
    expect(boxMarkdown(page.doc, x)).toBe('x!')
    expect(boxMarkdown(base, x)).toBe('x')
  })
})

describe('conflicts', () => {
  it('records one conflict when both devices typed into the same box offline', async () => {
    const { remote, a, b, x } = await shared()
    remote.offline = true
    editPage(a.local, PAGE, (p) => appendText(p, x, ' alpha'))
    editPage(b.local, PAGE, (p) => appendText(p, x, ' beta'))
    remote.offline = false
    await a.engine.syncOnce()
    const report = await b.engine.syncOnce()
    expect(report.conflicts).toBe(1)
    expect(b.local.conflicts).toHaveLength(1)
    const c = b.local.conflicts[0]!
    expect(c).toMatchObject({ pageId: PAGE, boxId: x, device: 'A' })
    expect(c.mine).toBe('base beta')
    expect(c.theirs).toBe('base alpha')
    expect(c.merged).toContain('alpha')
    expect(c.merged).toContain('beta')
    expect(c.id).toBeTruthy()
    // Already merged: syncing again records nothing new, and A saw B's edit after its own sync.
    await b.engine.syncOnce()
    await a.engine.syncOnce()
    expect(b.local.conflicts).toHaveLength(1)
    expect(a.local.doc(PAGE).toJSON()).toEqual(b.local.doc(PAGE).toJSON())
  })

  it('records nothing for edits to different boxes', async () => {
    const { a, b, x, y } = await shared()
    editPage(a.local, PAGE, (p) => appendText(p, x, ' alpha'))
    editPage(b.local, PAGE, (p) => appendText(p, y, ' beta'))
    await a.engine.syncOnce()
    await b.engine.syncOnce()
    await a.engine.syncOnce()
    expect(a.local.conflicts).toEqual([])
    expect(b.local.conflicts).toEqual([])
  })

  it('records nothing for a later edit to a box this device edited and synced before', async () => {
    const { a, b, x } = await shared()
    editPage(b.local, PAGE, (p) => appendText(p, x, ' beta'))
    await b.engine.syncOnce()
    await a.engine.syncOnce()
    editPage(a.local, PAGE, (p) => appendText(p, x, ' alpha'))
    await a.engine.syncOnce()
    await b.engine.syncOnce()
    expect(b.local.conflicts).toEqual([])
    expect(a.local.conflicts).toEqual([])
  })

  it('restores a box deleted on another device while edited here', async () => {
    const { remote, a, b, x } = await shared()
    remote.offline = true
    editPage(a.local, PAGE, (p) => p.deleteBox(x))
    editPage(b.local, PAGE, (p) => appendText(p, x, ' kept'))
    remote.offline = false
    await a.engine.syncOnce()
    await b.engine.syncOnce()

    const onB = new PageDoc(b.local.doc(PAGE))
    const restored = onB.listBoxes().filter((box) => boxText(onB, box.id) === 'base kept')
    expect(restored).toHaveLength(1)
    expect(restored[0]).toMatchObject({ x: 0, y: 0, width: 200 })
    expect(b.local.notes).toEqual(['A box deleted on another device was restored because you edited it'])

    await b.engine.syncOnce()
    await a.engine.syncOnce()
    const onA = new PageDoc(a.local.doc(PAGE))
    expect(onA.listBoxes().map((box) => boxText(onA, box.id))).toContain('base kept')
    expect(a.local.doc(PAGE).toJSON()).toEqual(b.local.doc(PAGE).toJSON())
  })
})
