import { execFileSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { PageDoc } from '@slate/core'
import { GitDrive, nodeGitRunner, SyncEngine, type RemoteDrive } from '@slate/sync'
import { memoryDrive, type MemoryDrive } from '../../../../sync/test/memoryDrive'
import { addTextBox, appendText, boxText, editPage, memoryLocal } from '../../../../sync/test/memoryLocal'
import { importKey } from '../../../test/vaultKeys'
import { sealEnvelope, type EnvelopeKeys } from '../vault/envelope'
import { PROFILES } from '../vault/profile'
import { SCHEDULE_V1, SUITE } from '../vault/suite'
import { KeyRing, Locked } from '../vault/keyring'
import { encodeId } from '../vault/names'
import { vaultNative } from '../vault/native'
import type { KeyHandle } from '@slate/native'
import { EncryptingDrive, VAULT_PATH } from './encryptingDrive'

// These cases run a header-v1 (suite 0x01) vault, which keeps its 32-hex names and SLE1 until C9; suite 0x02 is encryptingDrive2.test.ts.
const v1Keys = (syncKey: KeyHandle): EnvelopeKeys => ({ syncKey, suite: SUITE.HKDF_AES256GCM, keyEpoch: 0, readSuites: PROFILES.standard.readSuites })
const NOTICE = /^\d+ synced files could not be verified and were ignored$/
const MARKER = 'PLAINTEXT-MARKER-7f3a'
const temps: string[] = []

// The module holds 64 keys at most: every ring a test opens is closed after it.
const rings: KeyRing[] = []
const track = (ring: KeyRing): KeyRing => {
  rings.push(ring)
  return ring
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const ring of rings.splice(0)) ring.close()
})

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slate-e2ee-'))
  temps.push(dir)
  return dir
}

function device(inner: RemoteDrive, mk: Buffer, deviceId = randomUUID(), deviceName = 'test') {
  const local = memoryLocal()
  const keys = track(new KeyRing(importKey(mk, 'master'), undefined, SCHEDULE_V1))
  const remote = new EncryptingDrive(inner, keys)
  return { local, keys, remote, deviceId, engine: new SyncEngine({ local, remote, deviceId, deviceName }) }
}

const remoteFiles = (inner: MemoryDrive) => [...inner.files.keys()]

describe('EncryptingDrive over a memory drive', () => {
  it('syncs a page both ways and the remote holds only e2ee names', async () => {
    const inner = memoryDrive()
    const mk = randomBytes(32)
    const a = device(inner, mk)
    const b = device(inner, mk)
    const page = `page:${randomUUID()}`
    const x = editPage(a.local, page, (p) => addTextBox(p, MARKER))
    expect((await a.engine.syncOnce()).status).toBe('idle-synced')
    expect(await b.engine.syncOnce()).toMatchObject({ status: 'idle-synced', pulled: 1 })
    expect(boxText(new PageDoc(b.local.doc(page)), x)).toBe(MARKER)
    editPage(b.local, page, (p) => appendText(p, x, ' from B'))
    await b.engine.syncOnce()
    expect(await a.engine.syncOnce()).toMatchObject({ pulled: 1 })
    expect(boxText(new PageDoc(a.local.doc(page)), x)).toBe(`${MARKER} from B`)
    const names = remoteFiles(inner)
    expect(names.every((n) => /^e2ee\/(d|v)\//.test(n))).toBe(true)
    const uuids = [page.slice(5), a.deviceId, b.deviceId]
    for (const [name, bytes] of inner.files) {
      for (const u of uuids) expect(name.includes(u) || Buffer.from(bytes).includes(u)).toBe(false)
      expect(Buffer.from(bytes).includes(MARKER)).toBe(false)
    }
  })

  it('maps engine paths to the §15 N1 layout', async () => {
    const inner = memoryDrive()
    const keys = track(new KeyRing(vaultNative().keyRandom('master'), undefined, SCHEDULE_V1))
    const drive = new EncryptingDrive(inner, keys)
    const doc = randomUUID()
    const dev = randomUUID()
    await drive.upload(`docs/notebook_${doc}/${dev}/00000003.chunk`, new Uint8Array([1]))
    await drive.upload(`docs/page_${doc}/${dev}/snapshot-00000004.bin`, new Uint8Array([2]))
    await drive.upload(`devices/${dev}.json`, new Uint8Array([3]))
    const d = encodeId(keys.get('nameEnc'), 'notebook', doc)
    const p = encodeId(keys.get('nameEnc'), 'page', doc)
    const v = encodeId(keys.get('nameEnc'), 'device', dev)
    expect(remoteFiles(inner)).toEqual([`e2ee/d/${d}/${v}/00000003.c`, `e2ee/d/${p}/${v}/s-00000004.c`, `e2ee/v/${v}.c`])
    const paths = (await drive.delta(null)).items.map((i) => i.path)
    expect(paths).toEqual([`docs/notebook_${doc}/${dev}/00000003.chunk`, `docs/page_${doc}/${dev}/snapshot-00000004.bin`, `devices/${dev}.json`])
    expect(await drive.download(`devices/${dev}.json`)).toEqual(new Uint8Array([3]))
  })

  it('refuses ids that are not kind + uuidv4', async () => {
    const drive = new EncryptingDrive(memoryDrive(), track(new KeyRing(vaultNative().keyRandom('master'), undefined, SCHEDULE_V1)))
    await expect(drive.upload(`docs/page_${randomUUID()}/A/00000001.chunk`, new Uint8Array(1))).rejects.toThrow()
    await expect(drive.upload(`docs/thing_${randomUUID()}/${randomUUID()}/00000001.chunk`, new Uint8Array(1))).rejects.toThrow()
    await expect(drive.upload('devices/A.json', new Uint8Array(1))).rejects.toThrow()
    await expect(drive.upload('blobs/abc.png', new Uint8Array(1))).rejects.toThrow()
    await expect(drive.upload('elsewhere/x', new Uint8Array(1))).rejects.toThrow()
  })

  async function tampered(change: (inner: MemoryDrive, keys: KeyRing) => Promise<void>) {
    const inner = memoryDrive()
    const mk = randomBytes(32)
    const a = device(inner, mk)
    const b = device(inner, mk)
    const page = `page:${randomUUID()}`
    editPage(a.local, page, (p) => addTextBox(p, 'one'))
    await a.engine.syncOnce()
    editPage(a.local, page, (p) => addTextBox(p, 'two'))
    await a.engine.syncOnce()
    await change(inner, a.keys)
    const report = await b.engine.syncOnce()
    expect(report.status).toBe('idle-synced')
    return { b, page, report }
  }

  const chunks = (inner: MemoryDrive) => remoteFiles(inner).filter((n) => n.startsWith('e2ee/d/')).sort()

  it('skips a file with a flipped byte', async () => {
    const { b, report } = await tampered(async (inner) => {
      const bytes = inner.files.get(chunks(inner)[0]!)!
      bytes[bytes.length - 3] = bytes[bytes.length - 3]! ^ 1
    })
    expect(report.pulled).toBe(1)
    expect(b.local.notes).toEqual([expect.stringMatching(NOTICE)])
  })

  it('skips files swapped between paths', async () => {
    const { b, report } = await tampered(async (inner) => {
      const [one, two] = chunks(inner)
      const first = inner.files.get(one!)!
      inner.files.set(one!, inner.files.get(two!)!)
      inner.files.set(two!, first)
    })
    expect(report.pulled).toBe(0)
    expect(b.local.notes).toEqual(['2 synced files could not be verified and were ignored'])
  })

  it('skips a file moved to another sequence number', async () => {
    const { b, report } = await tampered(async (inner) => {
      const [one] = chunks(inner)
      const bytes = inner.files.get(one!)!
      await inner.remove(one!)
      await inner.upload(one!.replace(/\d+\.c$/, '00000009.c'), bytes)
    })
    expect(report.pulled).toBe(1)
    expect(b.local.notes).toEqual([expect.stringMatching(NOTICE)])
  })

  it('skips a file under a forged but well-formed name', async () => {
    const { b, report } = await tampered(async (inner, keys) => {
      const [one] = chunks(inner)
      const forged = encodeId(keys.get('nameEnc'), 'page', randomUUID())
      await inner.upload(one!.replace(/^e2ee\/d\/[0-9a-f]+/, `e2ee/d/${forged}`), inner.files.get(one!)!)
    })
    expect(report.pulled).toBe(2)
    expect(b.local.notes).toEqual([expect.stringMatching(NOTICE)])
  })

  it('skips a correctly sealed file whose contents are not a Loro update, and keeps syncing', async () => {
    const inner = memoryDrive()
    const mk = randomBytes(32)
    const a = device(inner, mk)
    const b = device(inner, mk)
    const page = `page:${randomUUID()}`
    editPage(a.local, page, (p) => addTextBox(p, 'one'))
    await a.engine.syncOnce()
    // Someone holding the key (or a buggy client) seals garbage under a valid engine path.
    const [path] = remoteFiles(inner).filter((n) => n.startsWith('e2ee/d/'))
    const enginePath = (await a.remote.delta(null)).items.find((i) => i.path.startsWith('docs/'))!.path
    await inner.upload(path!, sealEnvelope(v1Keys(a.keys.get('sync')), enginePath, new TextEncoder().encode('garbage'), { deflate: true }))
    const other = `page:${randomUUID()}`
    editPage(a.local, other, (p) => addTextBox(p, 'two'))
    await a.engine.syncOnce()
    expect(await b.engine.syncOnce()).toMatchObject({ status: 'idle-synced', pulled: 1 })
    expect(b.local.notes).toEqual([expect.stringMatching(NOTICE)])
    expect(await b.engine.syncOnce()).toMatchObject({ status: 'idle-synced' })
  })

  it('imports nothing under the wrong master key', async () => {
    const inner = memoryDrive()
    const a = device(inner, randomBytes(32))
    const b = device(inner, randomBytes(32))
    const page = `page:${randomUUID()}`
    editPage(a.local, page, (p) => addTextBox(p, 'secret'))
    await a.engine.syncOnce()
    expect(await b.engine.syncOnce()).toMatchObject({ status: 'idle-synced', pulled: 0 })
    expect(b.local.docs.size).toBe(0)
  })

  it('round-trips a blob and refuses one whose bytes do not match its hash', async () => {
    const inner = memoryDrive()
    const keys = track(new KeyRing(vaultNative().keyRandom('master'), undefined, SCHEDULE_V1))
    const drive = new EncryptingDrive(inner, keys)
    const bytes = randomBytes(100)
    const name = `${createHash('sha256').update(bytes).digest('hex')}.png`
    await drive.upload(`blobs/${name}`, bytes)
    const [remote] = remoteFiles(inner)
    expect(remote).toMatch(/^e2ee\/b\/[0-9a-f]{64}$/)
    expect(Buffer.from(await drive.download(`blobs/${name}`))).toEqual(bytes)
    expect((await drive.delta(null)).items).toEqual([])
    // Sealed with the right key and path, but not the named image.
    inner.files.set(remote!, sealEnvelope(v1Keys(keys.get('sync')), `blobs/${name}`, randomBytes(100)))
    await expect(drive.download(`blobs/${name}`)).rejects.toMatchObject({ unverifiable: true })
  })

  it('passes drive errors through and never returns unauthenticated bytes', async () => {
    const inner = memoryDrive()
    const drive = new EncryptingDrive(inner, track(new KeyRing(vaultNative().keyRandom('master'), undefined, SCHEDULE_V1)))
    const dev = randomUUID()
    await expect(drive.download(`devices/${dev}.json`)).rejects.toMatchObject({ status: 404 })
    await drive.upload(`devices/${dev}.json`, new Uint8Array([1, 2, 3]))
    const [remote] = remoteFiles(inner)
    inner.files.set(remote!, new Uint8Array([1, 2, 3]))
    await expect(drive.download(`devices/${dev}.json`)).rejects.toMatchObject({ unverifiable: true })
  })

  it('review C4 L1: a module failure or a closed vault is never "unverifiable", so the engine does not skip an authentic file', async () => {
    const inner = memoryDrive()
    const keys = new KeyRing(vaultNative().keyRandom('master'), undefined, SCHEDULE_V1)
    const drive = new EncryptingDrive(inner, keys)
    const dev = randomUUID()
    await drive.upload(`devices/${dev}.json`, new Uint8Array([1, 2, 3]))
    // The sync key destroyed under the ring (zeroizeAll in the error path does this): SCC_8 from the module.
    vaultNative().keyDestroy(keys.get('sync'))
    const failed = await drive.download(`devices/${dev}.json`).then(() => null, (e: unknown) => e as { code?: string; unverifiable?: boolean })
    expect(failed?.code).toBe('SCC_8')
    expect(failed?.unverifiable).toBeUndefined()
    // A locked vault: the ring is closed, and the download says so instead of judging the file.
    keys.close()
    await expect(drive.download(`devices/${dev}.json`)).rejects.toBeInstanceOf(Locked)
    await expect(drive.download(`devices/${dev}.json`)).rejects.not.toMatchObject({ unverifiable: true })
  })

  it('hides vault.json and counts plaintext files outside e2ee/', async () => {
    const inner = memoryDrive()
    const drive = new EncryptingDrive(inner, track(new KeyRing(vaultNative().keyRandom('master'), undefined, SCHEDULE_V1)))
    await inner.upload(VAULT_PATH, new Uint8Array([1]))
    await inner.upload('e2ee/README.md', new Uint8Array([1]))
    await inner.upload('README.md', new Uint8Array([1]))
    await inner.upload('e2ee/d/zz/x.c', new Uint8Array([1]))
    await inner.upload(`docs/page_${randomUUID()}/${randomUUID()}/00000001.chunk`, new Uint8Array([1]))
    await inner.upload('devices/old.json', new Uint8Array([1]))
    expect((await drive.delta(null)).items).toEqual([])
    expect(drive.plaintextItemsSeen).toBe(2)
  })

  it('removes plaintext files an older Slate wrote at the next flush (§7.6)', async () => {
    const inner = memoryDrive()
    const drive = new EncryptingDrive(inner, track(new KeyRing(vaultNative().keyRandom('master'), undefined, SCHEDULE_V1)))
    const old = `docs/page_${randomUUID()}/${randomUUID()}/00000001.chunk`
    await inner.upload(old, new Uint8Array([1]))
    await inner.upload('README.md', new Uint8Array([1]))
    await drive.delta(null)
    await drive.flush()
    expect(remoteFiles(inner)).toEqual(['README.md'])
  })
})

/** Every byte the bare repo holds: its files raw and zlib-inflated, and every object's content. */
function repoHaystacks(bare: string): Buffer[] {
  const out: Buffer[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else {
        const bytes = readFileSync(path)
        out.push(bytes)
        try {
          out.push(inflateSync(bytes))
        } catch {
          // Not a loose object.
        }
      }
    }
  }
  walk(bare)
  out.push(execFileSync('git', ['--git-dir', bare, 'cat-file', '--batch-all-objects', '--batch'], { maxBuffer: 1 << 28 }))
  return out
}

describe('EncryptingDrive over git', { timeout: 60_000 }, () => {
  it('syncs two devices through a bare repo that holds no plaintext, ids or hostname', async () => {
    const bare = temp()
    execFileSync('git', ['init', '--bare', '--initial-branch=main', bare])
    const mk = randomBytes(32)
    const run = nodeGitRunner()
    const gitDevice = () => {
      const inner = new GitDrive({
        run,
        dir: join(temp(), 'repo'),
        remoteUrl: `file://${bare}`,
        branch: 'main',
        authEnv: async () => ({}),
        author: { name: 'Slate', email: 'slate@invalid' },
        commitMessage: 'slate: sync'
      })
      return device(inner, mk, randomUUID(), hostname())
    }
    const a = gitDevice()
    const b = gitDevice()
    const page = `page:${randomUUID()}`
    const x = editPage(a.local, page, (p) => addTextBox(p, MARKER))
    expect((await a.engine.syncOnce()).status).toBe('idle-synced')
    expect(await b.engine.syncOnce()).toMatchObject({ status: 'idle-synced', pulled: 1 })
    editPage(b.local, page, (p) => appendText(p, x, ' and B'))
    expect((await b.engine.syncOnce()).status).toBe('idle-synced')
    expect(await a.engine.syncOnce()).toMatchObject({ status: 'idle-synced', pulled: 1 })
    expect(boxText(new PageDoc(a.local.doc(page)), x)).toBe(`${MARKER} and B`)

    const tree = execFileSync('git', ['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'main']).toString().trim().split('\n')
    expect(tree.every((p) => p === 'README.md' || p.startsWith('e2ee/'))).toBe(true)
    const needles = [MARKER, page.slice(5), page.slice(5).replace(/-/g, ''), a.deviceId, b.deviceId, a.deviceId.replace(/-/g, ''), b.deviceId.replace(/-/g, '')]
    if (hostname().length >= 4) needles.push(hostname())
    const haystacks = repoHaystacks(bare)
    for (const needle of needles) expect(haystacks.some((h) => h.includes(needle)), needle).toBe(false)
  })
})
