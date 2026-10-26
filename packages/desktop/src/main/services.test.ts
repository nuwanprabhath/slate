import { LoroDoc } from 'loro-crdt'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDatabase, WrongKey } from './db/openDatabase'
import type { AuthService } from './onenote/auth'
import { closeServices, openServices, services, servicesOpen, type ServiceContext } from './services'
import { DocStore } from './store'
import { lkBytesOf } from '../../test/vaultKeys'
import { Locked } from './vault/keyring'
import { createEncryptedDataDir } from './vault/testVault'
import { unlockVault } from './vault/unlock'
import { secretBytes } from '../shared/secret'

const PAGE = 'page:00000000-0000-4000-8000-000000000002'
const auth: AuthService = { status: async () => ({ configured: false, signedIn: false }), signIn: async () => {}, signOut: async () => {}, token: async () => '' }

function context(dataDir: string, events: string[] = []): ServiceContext {
  return {
    dataDir,
    emit: (channel) => void events.push(channel),
    sync: { auth, graphUrl: 'http://127.0.0.1:9', gitDir: join(dataDir, 'git-sync'), secrets: { available: async () => false, seal: async () => Buffer.alloc(0), open: async () => ({ plain: '', rewrite: false }) }, intervalMs: 0 },
    importer: { auth, graphUrl: 'http://127.0.0.1:9' },
  }
}

function update(text: string): Uint8Array {
  const doc = new LoroDoc()
  doc.getText('t').insert(0, text)
  return doc.export({ mode: 'update' })
}

describe('services (§6.2)', () => {
  it('opens a plaintext data folder as before, and services() throws Locked once closed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slate-svc-'))
    expect(() => services()).toThrow(Locked)
    const svc = openServices(null, join(dir, 'slate.db'), context(dir))
    svc.store.append(PAGE, update('plain'))
    expect(services().store.load(PAGE)).toHaveLength(1)
    expect(svc.blobs.put(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png')).toMatch(/^slate-blob:/)
    closeServices()
    expect(servicesOpen()).toBe(false)
    expect(() => services()).toThrow(Locked)
    expect(new DocStore(join(dir, 'slate.db')).load(PAGE)).toHaveLength(1)
  })

  it('opens an encrypted folder with the key ring: images go into the encrypted database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slate-svc-'))
    const seed = new DocStore(join(dir, 'slate.db'))
    seed.append(PAGE, update('secret'))
    seed.close()
    await createEncryptedDataDir(dir, secretBytes('a test password'), { allowWeakForTests: true })
    const { keyRing, dbFile } = await unlockVault(dir, { password: secretBytes('a test password') }, { allowWeakForTests: true })
    const events: string[] = []
    const svc = openServices(keyRing, dbFile, context(dir, events))
    expect(() => openServices(keyRing, dbFile, context(dir))).toThrow(/already open/)
    expect(svc.store.load(PAGE)).toHaveLength(1)
    const url = svc.blobs.put(new Uint8Array([1, 2, 3]), 'image/png')
    expect(svc.blobs.readForUrl(url)?.bytes).toEqual(new Uint8Array([1, 2, 3]))
    expect(() => openDatabase(dbFile, null)).toThrow(WrongKey)
    svc.muteEvents()
    await svc.stopSync()
    svc.closeWatch()
    svc.closeDatabases()
    expect(() => services()).toThrow(Locked)
    expect(events).not.toContain('docs:external')
  })

  it('keeps no copy of the database key in the services once their connections are open (§15 N9)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slate-svc-'))
    new DocStore(join(dir, 'slate.db')).close()
    await createEncryptedDataDir(dir, secretBytes('a test password'), { allowWeakForTests: true })
    const { keyRing, dbFile } = await unlockVault(dir, { password: secretBytes('a test password') }, { allowWeakForTests: true })
    // LK's bytes, recomputed outside the module from the password, only to search for them: the services
    // hold LK's handle, never its bytes.
    const lk = await lkBytesOf(dir, 'a test password')
    const svc = openServices(keyRing, dbFile, context(dir))
    try {
      // Two levels down: each service, its deps or options, and the stores it owns.
      const found: string[] = []
      const scan = (value: unknown, path: string, depth: number) => {
        if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
          if (Buffer.from(value as Uint8Array).equals(lk)) found.push(path)
          return
        }
        if (depth === 0 || value === null || typeof value !== 'object') return
        for (const [k, v] of Object.entries(value)) scan(v, `${path}.${k}`, depth - 1)
      }
      for (const name of ['store', 'sync', 'importer', 'search', 'themes'] as const) scan(svc[name], name, 3)
      expect(found).toEqual([])
      expect(svc.store.load(PAGE)).toEqual([])
    } finally {
      await svc.stopSync()
      svc.closeDatabases()
      keyRing.close()
    }
  })
})
