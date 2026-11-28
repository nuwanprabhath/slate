// A page whose history was erased to a shallow snapshot (GDPR-04) while sync was off, then synced.
// The engine uploads such a page as a snapshot file; a device takes it in by merging it, or by adopting it
// when it holds nothing the snapshot lacks; anything else is kept and reported, never dropped.
import { describe, expect, it } from 'vitest'
import { PageDoc } from '@slate/core'
import { ERASED_ELSEWHERE_MESSAGE, ERASED_HERE_MESSAGE, SyncEngine } from '../src/engine'
import { memoryDrive, type MemoryDrive } from './memoryDrive'
import { addTextBox, appendText, boxText, deleteText, editPage, memoryLocal, type MemoryLocal } from './memoryLocal'

const PAGE = 'page:11111111-1111-4111-8111-111111111111'

function device(remote: MemoryDrive, deviceId: string, compactAfter?: number, canReplace = true) {
  const local = memoryLocal({ canReplace })
  return { local, engine: new SyncEngine({ local, remote, deviceId, deviceName: deviceId, compactAfter }) }
}

/** What the desktop's erase stores: one shallow snapshot at the doc's frontier, in place of every row. */
function erase(local: MemoryLocal): void {
  const doc = local.doc(PAGE)
  local.docs.set(PAGE, [doc.export({ mode: 'shallow-snapshot', frontiers: doc.oplogFrontiers() })])
  doc.free()
}

const text = (local: MemoryLocal, boxId: string) => boxText(new PageDoc(local.doc(PAGE)), boxId)

/** Every remote file of the page, read as text: what a reader of the sync folder could recover. */
const remoteText = (remote: MemoryDrive) =>
  [...remote.files].filter(([path]) => path.startsWith('docs/')).map(([, bytes]) => new TextDecoder('utf-8', { fatal: false }).decode(bytes)).join('\n')

describe('a page erased while sync was off, then synced', () => {
  it('keeps syncing when every edit had been pushed before the erase: to a device that has the page, a new one, and one that joins after the remote compacts', async () => {
    const remote = memoryDrive()
    const a = device(remote, 'A', 2)
    const b = device(remote, 'B')
    const id = editPage(a.local, PAGE, (p) => addTextBox(p, 'base'))
    await a.engine.syncOnce()
    await b.engine.syncOnce()
    erase(a.local)
    editPage(a.local, PAGE, (p) => appendText(p, id, ' after'))
    expect((await a.engine.syncOnce()).status).toBe('idle-synced')
    await b.engine.syncOnce()
    expect(text(b.local, id)).toBe('base after')
    const c = device(remote, 'C')
    await c.engine.syncOnce()
    expect(text(c.local, id)).toBe('base after')
    // Past compactAfter, A's chunks become one snapshot of its shallow doc.
    for (const word of [' x', ' y', ' z']) {
      editPage(a.local, PAGE, (p) => appendText(p, id, word))
      await a.engine.syncOnce()
    }
    await b.engine.syncOnce()
    expect(text(b.local, id)).toBe('base after x y z')
    const d = device(remote, 'D')
    await d.engine.syncOnce()
    expect(text(d.local, id)).toBe('base after x y z')
  })

  it('carries edits that were never pushed before the erase: the other device adopts the erased snapshot, and later edits flow both ways', async () => {
    const remote = memoryDrive()
    const a = device(remote, 'A')
    const b = device(remote, 'B')
    const id = editPage(a.local, PAGE, (p) => addTextBox(p, 'base'))
    await a.engine.syncOnce()
    await b.engine.syncOnce()
    editPage(a.local, PAGE, (p) => appendText(p, id, ' offline'))
    erase(a.local)
    editPage(a.local, PAGE, (p) => appendText(p, id, ' after'))
    expect((await a.engine.syncOnce()).status).toBe('idle-synced')
    expect((await b.engine.syncOnce()).status).toBe('idle-synced')
    expect(text(a.local, id)).toBe('base offline after')
    expect(text(b.local, id)).toBe('base offline after')
    expect(b.local.conflicts).toEqual([])
    expect(b.local.notes).toEqual([])
    editPage(b.local, PAGE, (p) => appendText(p, id, ' fromB'))
    await b.engine.syncOnce()
    await a.engine.syncOnce()
    editPage(a.local, PAGE, (p) => appendText(p, id, ' fromA'))
    await a.engine.syncOnce()
    await b.engine.syncOnce()
    expect(text(a.local, id)).toBe('base offline after fromB fromA')
    expect(text(b.local, id)).toBe('base offline after fromB fromA')
    // A's own chunks, which held the history before the erase, left the remote with the snapshot's upload.
    expect([...remote.files.keys()].filter((p) => p.includes('/A/')).some((p) => p.endsWith('00000001.chunk'))).toBe(false)
  })

  it('carries a page erased before the vault ever synced to a device that joins later, then keeps both in step', async () => {
    const remote = memoryDrive()
    const a = device(remote, 'A')
    const id = editPage(a.local, PAGE, (p) => addTextBox(p, 'base'))
    editPage(a.local, PAGE, (p) => appendText(p, id, ' secret'))
    erase(a.local)
    editPage(a.local, PAGE, (p) => appendText(p, id, ' after'))
    expect((await a.engine.syncOnce()).status).toBe('idle-synced')
    const b = device(remote, 'B')
    await b.engine.syncOnce()
    expect(text(b.local, id)).toBe('base secret after')
    editPage(b.local, PAGE, (p) => appendText(p, id, ' b'))
    await b.engine.syncOnce()
    await a.engine.syncOnce()
    expect(text(a.local, id)).toBe('base secret after b')
  })

  it('uploads no deleted text: a word deleted before the erase is in no remote file', async () => {
    const remote = memoryDrive()
    const a = device(remote, 'A')
    const id = editPage(a.local, PAGE, (p) => addTextBox(p, 'keep '))
    editPage(a.local, PAGE, (p) => appendText(p, id, 'ZQXMARKER'))
    editPage(a.local, PAGE, (p) => deleteText(p, id, 5, 'ZQXMARKER'.length))
    erase(a.local)
    await a.engine.syncOnce()
    expect(remoteText(remote)).not.toContain('ZQXMARKER')
    const b = device(remote, 'B')
    await b.engine.syncOnce()
    expect(text(b.local, id)).toBe('keep ')
  })

  it('reaches a third device that joins after the erased page was compacted again', async () => {
    const remote = memoryDrive()
    const a = device(remote, 'A', 2)
    const b = device(remote, 'B')
    const id = editPage(a.local, PAGE, (p) => addTextBox(p, 'base'))
    await a.engine.syncOnce()
    await b.engine.syncOnce()
    editPage(a.local, PAGE, (p) => appendText(p, id, ' offline'))
    erase(a.local)
    await a.engine.syncOnce()
    for (const word of [' x', ' y', ' z']) {
      editPage(a.local, PAGE, (p) => appendText(p, id, word))
      await a.engine.syncOnce()
    }
    await b.engine.syncOnce()
    expect(text(b.local, id)).toBe('base offline x y z')
    const c = device(remote, 'C')
    await c.engine.syncOnce()
    expect(text(c.local, id)).toBe('base offline x y z')
    editPage(c.local, PAGE, (p) => appendText(p, id, ' c'))
    await c.engine.syncOnce()
    await a.engine.syncOnce()
    await b.engine.syncOnce()
    expect(text(a.local, id)).toBe('base offline x y z c')
    expect(text(b.local, id)).toBe('base offline x y z c')
  })

  it('keeps and reports, never drops, an edit the other device made before the erased snapshot reached it (edits unpushed at the erase)', async () => {
    const remote = memoryDrive()
    const a = device(remote, 'A')
    const b = device(remote, 'B')
    const id = editPage(a.local, PAGE, (p) => addTextBox(p, 'base'))
    await a.engine.syncOnce()
    await b.engine.syncOnce()
    editPage(a.local, PAGE, (p) => appendText(p, id, ' offline'))
    erase(a.local)
    editPage(b.local, PAGE, (p) => appendText(p, id, ' concurrent'))
    await b.engine.syncOnce()
    await a.engine.syncOnce()
    await b.engine.syncOnce()
    // Neither device loses its own text.
    expect(text(a.local, id)).toBe('base offline')
    expect(text(b.local, id)).toBe('base concurrent')
    // B could not take the erased page in: its version of every differing box is a conflict, with A's as "theirs".
    expect(b.local.conflicts).toEqual([expect.objectContaining({ pageId: PAGE, boxId: id, device: 'A', mine: 'base concurrent', theirs: 'base offline', merged: 'base concurrent' })])
    expect(b.local.notes).toContain(ERASED_ELSEWHERE_MESSAGE)
    // A could not take B's edit, which builds on history A no longer has.
    expect(a.local.notes).toContain(ERASED_HERE_MESSAGE)
  })

  it('keeps and reports a concurrent edit when every edit had been pushed before the erase: the other device merges, the erasing one says what it could not take', async () => {
    const remote = memoryDrive()
    const a = device(remote, 'A')
    const b = device(remote, 'B')
    const id = editPage(a.local, PAGE, (p) => addTextBox(p, 'base'))
    await a.engine.syncOnce()
    await b.engine.syncOnce()
    editPage(a.local, PAGE, (p) => appendText(p, id, ' pushed'))
    await a.engine.syncOnce()
    editPage(b.local, PAGE, (p) => appendText(p, id, ' concurrent'))
    erase(a.local)
    editPage(a.local, PAGE, (p) => appendText(p, id, ' after'))
    await b.engine.syncOnce()
    await a.engine.syncOnce()
    await b.engine.syncOnce()
    const merged = text(b.local, id)!
    expect(merged).toContain('pushed')
    expect(merged).toContain('concurrent')
    expect(merged).toContain('after')
    expect(text(a.local, id)).toBe('base pushed after')
    expect(a.local.notes).toContain(ERASED_HERE_MESSAGE)
  })

  it('keeps its own doc and reports it, on a store that cannot replace a doc, when the erased snapshot would need adopting', async () => {
    const remote = memoryDrive()
    const a = device(remote, 'A')
    const b = device(remote, 'B', undefined, false)
    const id = editPage(a.local, PAGE, (p) => addTextBox(p, 'base'))
    await a.engine.syncOnce()
    await b.engine.syncOnce()
    editPage(a.local, PAGE, (p) => appendText(p, id, ' offline'))
    erase(a.local)
    await a.engine.syncOnce()
    await b.engine.syncOnce()
    expect(text(b.local, id)).toBe('base')
    expect(b.local.conflicts).toEqual([expect.objectContaining({ boxId: id, mine: 'base', theirs: 'base offline' })])
    expect(b.local.notes).toContain(ERASED_ELSEWHERE_MESSAGE)
  })

  it('takes in an erased snapshot listed after a later chunk of the same page in one pull', async () => {
    const remote = memoryDrive()
    const a = device(remote, 'A')
    const id = editPage(a.local, PAGE, (p) => addTextBox(p, 'base'))
    erase(a.local)
    await a.engine.syncOnce()
    editPage(a.local, PAGE, (p) => appendText(p, id, ' later'))
    await a.engine.syncOnce()
    // A listing in another order, as git's (alphabetical: 00000002.chunk before snapshot-00000001.bin).
    const delta = remote.delta.bind(remote)
    remote.delta = async (cursor, signal) => {
      const page = await delta(cursor, signal)
      return { ...page, items: [...page.items].reverse() }
    }
    const b = device(remote, 'B')
    await b.engine.syncOnce()
    expect(text(b.local, id)).toBe('base later')
  })

  it('reads and syncs, once upgraded, a page a v0.7.14 device stored from such a listing: the chunk row before the snapshot', async () => {
    const remote = memoryDrive()
    const a = device(remote, 'A')
    const id = editPage(a.local, PAGE, (p) => addTextBox(p, 'base'))
    for (const word of [' 1', ' 2']) editPage(a.local, PAGE, (p) => appendText(p, id, word))
    erase(a.local)
    await a.engine.syncOnce()
    editPage(a.local, PAGE, (p) => appendText(p, id, ' later'))
    await a.engine.syncOnce()
    // What v0.7.14 left: every file stored as received in git's order, and marked seen.
    const b = device(remote, 'B', undefined, false)
    const listed = (await remote.delta(null)).items.filter((item) => item.path.startsWith('docs/')).sort((x, y) => (x.path < y.path ? -1 : 1))
    for (const item of listed) {
      b.local.appendLocal(PAGE, remote.files.get(item.path)!)
      await b.local.markSeen(item.id, item.eTag)
    }
    expect(text(b.local, id)).toBe('base 1 2 later')
    editPage(b.local, PAGE, (p) => appendText(p, id, ' fromB'))
    expect((await b.engine.syncOnce()).status).toBe('idle-synced')
    await a.engine.syncOnce()
    expect(text(a.local, id)).toBe('base 1 2 later fromB')
    expect(a.local.notes).toEqual([])
  })
})

describe('conflicts on a page whose history was erased', () => {
  it('records a conflict, with each side as it was, when two devices edit the same box of an erased page', async () => {
    const remote = memoryDrive()
    const a = device(remote, 'A')
    const id = editPage(a.local, PAGE, (p) => addTextBox(p, 'base'))
    erase(a.local)
    await a.engine.syncOnce()
    const b = device(remote, 'B')
    await b.engine.syncOnce()
    editPage(a.local, PAGE, (p) => appendText(p, id, ' fromA'))
    editPage(b.local, PAGE, (p) => appendText(p, id, ' fromB'))
    await a.engine.syncOnce()
    await b.engine.syncOnce()
    await a.engine.syncOnce()
    const merged = text(b.local, id)!
    expect(text(a.local, id)).toBe(merged)
    expect(b.local.conflicts).toEqual([expect.objectContaining({ boxId: id, device: 'A', mine: 'base fromB', theirs: 'base fromA', merged })])
  })
})
