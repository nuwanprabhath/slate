// A page whose history was erased (GDPR-04) before it ever synced, carried through an encrypted remote:
// the erased page goes up as a sealed snapshot file, which a joining device opens and takes in whole.
import { randomBytes, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { PageDoc } from '@slate/core'
import { SyncEngine, type RemoteDrive } from '@slate/sync'
import { memoryDrive } from '../../../../sync/test/memoryDrive'
import { addTextBox, appendText, boxText, deleteText, editPage, memoryLocal, type MemoryLocal } from '../../../../sync/test/memoryLocal'
import { importKey } from '../../../test/vaultKeys'
import { parseEnvelope } from '../vault/envelope'
import { KeyRing } from '../vault/keyring'
import { scheduleV2 } from '../vault/suite'
import { EncryptingDrive } from './encryptingDrive'
import { docStoreLocal } from './localStore'

const VAULT = '3c1d2e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f'
const PAGE = 'page:7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d'
const MARKER = 'WOMBAT-ERASED-93c1'
const rings: KeyRing[] = []
afterEach(() => {
  for (const ring of rings.splice(0)) ring.close()
})

function device(inner: RemoteDrive, mk: Buffer, compactAfter?: number) {
  const keys = new KeyRing(importKey(mk, 'master'), undefined, scheduleV2(VAULT, 'standard'))
  rings.push(keys)
  const local = memoryLocal()
  const deviceId = randomUUID()
  return { local, engine: new SyncEngine({ local, remote: new EncryptingDrive(inner, keys), deviceId, deviceName: 'test', compactAfter }) }
}

function erase(local: MemoryLocal): void {
  const doc = local.doc(PAGE)
  local.docs.set(PAGE, [doc.export({ mode: 'shallow-snapshot', frontiers: doc.oplogFrontiers() })])
  doc.free()
}

const text = (local: MemoryLocal, boxId: string) => boxText(new PageDoc(local.doc(PAGE)), boxId)

describe('an erased page over an encrypted remote', () => {
  it('reaches a device that joins, also after the remote compacts, and keeps both in step; every file stays sealed', async () => {
    const inner = memoryDrive()
    const mk = randomBytes(32)
    const a = device(inner, mk, 2)
    const id = editPage(a.local, PAGE, (p) => addTextBox(p, 'kept '))
    editPage(a.local, PAGE, (p) => appendText(p, id, MARKER))
    editPage(a.local, PAGE, (p) => deleteText(p, id, 5, MARKER.length))
    erase(a.local)
    expect((await a.engine.syncOnce()).status).toBe('idle-synced')
    for (const bytes of inner.files.values()) expect(parseEnvelope(bytes).format).toBe('SLE2')
    const b = device(inner, mk)
    expect((await b.engine.syncOnce()).status).toBe('idle-synced')
    expect(text(b.local, id)).toBe('kept ')
    for (const word of ['x', 'y', 'z']) {
      editPage(a.local, PAGE, (p) => appendText(p, id, word))
      await a.engine.syncOnce()
    }
    const c = device(inner, mk)
    await c.engine.syncOnce()
    expect(text(c.local, id)).toBe('kept xyz')
    editPage(c.local, PAGE, (p) => appendText(p, id, '!'))
    await c.engine.syncOnce()
    await a.engine.syncOnce()
    await b.engine.syncOnce()
    expect([text(a.local, id), text(b.local, id)]).toEqual(['kept xyz!', 'kept xyz!'])
    expect(a.local.notes.concat(b.local.notes, c.local.notes)).toEqual([])
  })
})

describe('the desktop store under sync (GDPR-04)', () => {
  it('offers no replaceDoc: an open window would write edits onto a history the store no longer has', () => {
    const local = docStoreLocal({} as never, {} as never, () => {})
    expect(local.replaceDoc).toBeUndefined()
  })
})
