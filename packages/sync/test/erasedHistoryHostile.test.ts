// A remote serving a shallow snapshot (an erased history, GDPR-04) whose header reads but whose body is
// damaged, as a hostile plaintext remote or a broken upload can. Sync must skip it as unverifiable and go on,
// never fail every run on the same file.
import { describe, expect, it } from 'vitest'
import { decodeImportBlobMeta, LoroDoc } from 'loro-crdt'
import { PageDoc } from '@slate/core'
import { SyncEngine, unverifiedMessage } from '../src/engine'
import { snapshotPath } from '../src/paths'
import { memoryDrive } from './memoryDrive'
import { addTextBox, appendText, editPage, memoryLocal } from './memoryLocal'

const PAGE = 'page:11111111-1111-4111-8111-111111111111'

/** A real shallow snapshot of a page with one byte of its body flipped where the header still reads. */
function damagedShallowSnapshot(): Uint8Array {
  const doc = new LoroDoc()
  doc.setPeerId(900n)
  const page = new PageDoc(doc)
  const id = addTextBox(page, 'theirs')
  doc.commit()
  appendText(page, id, ' more')
  doc.commit()
  const snapshot = doc.export({ mode: 'shallow-snapshot', frontiers: doc.oplogFrontiers() })
  doc.free()
  for (let i = snapshot.length - 1; i > 20; i--) {
    const bytes = Uint8Array.from(snapshot)
    bytes[i] = (bytes[i] ?? 0) ^ 0xff
    let headerReads = false
    try {
      const meta = decodeImportBlobMeta(bytes, false)
      headerReads = meta.mode === 'shallow-snapshot'
      meta.partialStartVersionVector.free()
      meta.partialEndVersionVector.free()
    } catch {
      continue
    }
    if (!headerReads) continue
    const probe = new LoroDoc()
    try {
      probe.import(bytes)
    } catch {
      return bytes
    } finally {
      probe.free()
    }
  }
  throw new Error('no damaged snapshot found')
}

describe('a damaged erased-history snapshot on the remote', () => {
  it('is skipped as unverifiable: the sync completes, the next one too, and the local page is untouched', async () => {
    const remote = memoryDrive()
    const local = memoryLocal()
    const engine = new SyncEngine({ local, remote, deviceId: 'B', deviceName: 'B' })
    editPage(local, PAGE, (p) => addTextBox(p, 'mine'))
    expect((await engine.syncOnce()).status).toBe('idle-synced')
    await remote.upload(snapshotPath(PAGE, 'X', 1), damagedShallowSnapshot())

    expect((await engine.syncOnce()).status).toBe('idle-synced')
    expect(local.notes).toContain(unverifiedMessage(1))
    expect((await engine.syncOnce()).status).toBe('idle-synced')
    const doc = local.doc(PAGE)
    expect(new PageDoc(doc).listBoxes()).toHaveLength(1)
    doc.free()
  })
})
