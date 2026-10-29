// Audit C4 criterion 2 and T-KAT-03: files sealed by the audited (pre-C4) code open after C4, and what
// C4 seals opens with the audited construction. fixtures/c4 was written by the pre-C4 build (main
// efcbb2d) through the audited vault/crypto.ts, header.ts, localKeys.ts, names.ts, quickUnlock.ts and
// preunlock.ts; it is never regenerated. The reference below is that construction in node:crypto.
import { createDecipheriv, hkdfSync } from 'node:crypto'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { LoroDoc } from 'loro-crdt'
import type { KeyHandle } from '@slate/native'
import type { EnvelopeKeys } from './envelope'
import { PROFILES } from './profile'
import { SUITE } from './suite'

const v1Keys = (syncKey: KeyHandle): EnvelopeKeys => ({ syncKey, suite: SUITE.HKDF_AES256GCM, keyEpoch: 0, readSuites: PROFILES.standard.readSuites })
import { storeWithLk } from './testVault'
import { createSecretStorage } from '../secretStorage'
import { readSettings } from '../settings'
import { openEnvelope, sealEnvelope } from './envelope'
import { blobRemoteName, decodeId, encodeId } from './names'
import { readPreunlock, verifyPreunlock } from './preunlock'
import { openQuickUnlock, type QuickUnlockPlatform } from './quickUnlock'
import { unlockVault, VAULT_FILE } from './unlock'
import { canonicalJson, parseHeader } from './header'
import type { UnlockSecret } from './unlock'
import { secretBytes } from '../../shared/secret'

const FIXTURES = join(__dirname, 'fixtures', 'c4')
const weak = { allowWeakForTests: true }

interface Manifest {
  password: string
  recoveryKey: string
  vaultId: string
  mk: string
  plaintext: string
  envelopes: Record<string, string>
  ids: { notebook: string; page: string; device: string }
  names: { notebook: string; page: string; device: string; blob: string }
  blobName: string
  settings: { idleMinutes: number }
  notice: string
}
const manifest = JSON.parse(readFileSync(join(FIXTURES, 'manifest.json'), 'utf8')) as Manifest

/** A scratch copy: unlocking may tidy files in the data folder, and the fixture must stay as written. */
function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slate-c4-fixture-'))
  cpSync(join(FIXTURES, 'data'), dir, { recursive: true })
  return dir
}

/** The fake safeStorage the fixture's quick-unlock.bin was sealed with, behind the real secretStorage wrapper. */
const platform: QuickUnlockPlatform = {
  platform: 'darwin',
  secrets: createSecretStorage(
    {
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async (s) => Buffer.from('sealed:' + Buffer.from(s).toString('hex')),
      decryptStringAsync: async (b) => ({ result: Buffer.from(b.toString().slice('sealed:'.length), 'hex').toString(), shouldReEncrypt: false }),
      getSelectedStorageBackend: () => 'gnome_libsecret' as const,
    },
    'darwin',
  ),
  systemPreferences: { canPromptTouchID: () => true, promptTouchID: async () => {} },
}

/** The audited SLE1 open (§5.3), independent of the code under test. */
function referenceOpen(logicalPath: string, bytes: Uint8Array): Buffer {
  const mk = Buffer.from(manifest.mk, 'hex')
  const kSync = Buffer.from(hkdfSync('sha256', mk, Buffer.alloc(0), Buffer.from('slate/v1/sync'), 32))
  const buf = Buffer.from(bytes)
  expect(buf.subarray(0, 4).toString()).toBe('SLE1')
  const header = buf.subarray(0, 33)
  const fileKey = Buffer.from(hkdfSync('sha256', kSync, buf.subarray(5, 21), Buffer.from('slate/v1/remote-file'), 32))
  const d = createDecipheriv('aes-256-gcm', fileKey, buf.subarray(21, 33))
  d.setAAD(Buffer.concat([header, Buffer.from('|' + logicalPath)]))
  d.setAuthTag(buf.subarray(buf.length - 16))
  const body = Buffer.concat([d.update(buf.subarray(33, buf.length - 16)), d.final()])
  return buf[4] === 1 ? inflateRawSync(body) : body
}

describe('C4 cross-version fixtures (criterion 2, T-KAT-03)', () => {
  it('the generator that wrote them is committed, and refuses to write over committed fixtures (review C4 L4)', () => {
    const generator = readFileSync(join(FIXTURES, 'generate.pre-c4.ts.txt'), 'utf8')
    expect(generator).toMatch(/if \(existsSync\(join\(OUT, 'manifest\.json'\)\)\) throw new Error/)
    expect(generator.indexOf('existsSync(join(OUT')).toBeLessThan(generator.indexOf('rmSync(OUT'))
  })

  it('the reference construction opens the fixture envelopes (the fixture is genuine SLE1)', () => {
    for (const [file, path] of Object.entries(manifest.envelopes)) {
      expect(referenceOpen(path, readFileSync(join(FIXTURES, file))).toString('utf8')).toBe(manifest.plaintext)
    }
  })

  it('a header-v1 vault and its local keys open with the password and with the recovery key', async () => {
    for (const secret of [{ password: secretBytes(manifest.password) }, { recoveryKey: secretBytes(manifest.recoveryKey) }]) {
      const { keyRing, dbFile } = await unlockVault(dataDir(), secret, weak)
      expect(dbFile.endsWith('.db')).toBe(true)
      keyRing.close()
    }
  })

  it('opens pre-C4 SLE1 envelopes, names and the preunlock MAC with the unlocked key ring', async () => {
    const dir = dataDir()
    const { keyRing } = await unlockVault(dir, { password: secretBytes(manifest.password) }, weak)
    try {
      const sync = keyRing.get('sync')
      for (const [file, path] of Object.entries(manifest.envelopes)) {
        expect(Buffer.from(openEnvelope(v1Keys(sync), path, readFileSync(join(FIXTURES, file)))).toString('utf8')).toBe(manifest.plaintext)
      }
      const nameEnc = keyRing.get('nameEnc')
      for (const kind of ['notebook', 'page', 'device'] as const) {
        expect(encodeId(nameEnc, kind, manifest.ids[kind])).toBe(manifest.names[kind])
        expect(decodeId(nameEnc, manifest.names[kind])).toEqual({ kind, uuid: manifest.ids[kind] })
      }
      expect(blobRemoteName(keyRing.get('name'), manifest.blobName)).toBe(manifest.names.blob)
      expect(verifyPreunlock(await readPreunlock(join(dir, 'preunlock.json')), keyRing.get('prefs'))).toBe(true)
    } finally {
      keyRing.close()
    }
  })

  it('opens the pre-C4 quick-unlock file, and its master key passes the header check', async () => {
    const dir = dataDir()
    const mk = await openQuickUnlock(dir, platform)
    const { keyRing } = await unlockVault(dir, { mk }, weak)
    keyRing.close()
    expect(keyRing.isOpen).toBe(false)
  })

  it('opens the pre-C4 encrypted database with the unwrapped local key', async () => {
    const dir = dataDir()
    const { keyRing, dbFile } = await unlockVault(dir, { password: secretBytes(manifest.password) }, weak)
    try {
      const store = storeWithLk(keyRing, dbFile)
      try {
        expect(readSettings(store).idleMinutes).toBe(manifest.settings.idleMinutes)
      } finally {
        store.close()
      }
    } finally {
      keyRing.close()
    }
  })

  it('an envelope sealed now opens with the audited construction (devices on older Slate keep reading)', async () => {
    const { keyRing } = await unlockVault(dataDir(), { password: secretBytes(manifest.password) }, weak)
    try {
      const text = new TextEncoder().encode(manifest.plaintext)
      for (const deflate of [true, false]) {
        const sealed = sealEnvelope(v1Keys(keyRing.get('sync')), 'docs/page_a/b/00000002.chunk', text, { deflate })
        expect(referenceOpen('docs/page_a/b/00000002.chunk', sealed).toString('utf8')).toBe(manifest.plaintext)
      }
    } finally {
      keyRing.close()
    }
  })
})

// ---- PQ-B4 (T-PQ-B4-04): every header version this build has written opens, with its notes ----

const V2_FIXTURE = join(__dirname, '..', '..', '..', 'e2e', 'fixtures', 'pq-v2-0.3.0')
const V3_FIXTURE = join(__dirname, 'fixtures', 'pq-v3')
const v2Secrets = JSON.parse(readFileSync(join(V2_FIXTURE, 'secrets.json'), 'utf8')) as { password: string; recoveryKey: string; note: string }
const v3Manifest = JSON.parse(readFileSync(join(V3_FIXTURE, 'manifest.json'), 'utf8')) as { device: string }

/** A scratch copy of a fixture's data folder, `vault.json` replaced by `header` when given. */
function copyOf(data: string, header?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'slate-pq-fixture-'))
  cpSync(data, dir, { recursive: true })
  if (header) writeFileSync(join(dir, VAULT_FILE), readFileSync(header))
  return dir
}

/** Every note's text (the JSON of each document) and the idle setting, as the unlocked vault reads them. */
async function notesOf(dir: string, secret: UnlockSecret): Promise<{ docs: string[]; idleMinutes: number }> {
  const { keyRing, dbFile } = await unlockVault(dir, secret, weak)
  try {
    const store = storeWithLk(keyRing, dbFile)
    try {
      const docs = store.list('').map((id) => {
        const doc = new LoroDoc()
        doc.importBatch(store.load(id))
        return `${id} ${JSON.stringify(doc.toJSON())}`
      })
      return { docs, idleMinutes: readSettings(store).idleMinutes }
    } finally {
      store.close()
    }
  } finally {
    keyRing.close()
  }
}

describe('PQ-B4: header v1, v2 (0.3.0) and v3 fixtures', () => {
  it('T-PQ-B4-04: the v1, v2 and v3 fixtures each unlock with the password and the recovery key, and their notes match', async () => {
    const cases = [
      { label: 'v1', version: 1, data: join(FIXTURES, 'data'), header: undefined, password: manifest.password, recoveryKey: manifest.recoveryKey },
      { label: 'v2', version: 2, data: join(V2_FIXTURE, 'data'), header: undefined, password: v2Secrets.password, recoveryKey: v2Secrets.recoveryKey },
      { label: 'v3', version: 3, data: join(V2_FIXTURE, 'data'), header: join(V3_FIXTURE, 'vault.json'), password: v2Secrets.password, recoveryKey: v2Secrets.recoveryKey },
    ]
    const seen = new Map<string, Awaited<ReturnType<typeof notesOf>>>()
    for (const c of cases) {
      for (const [how, secret] of [
        ['password', () => ({ password: secretBytes(c.password) })],
        ['recovery key', () => ({ recoveryKey: secretBytes(c.recoveryKey) })],
      ] as const) {
        const dir = copyOf(c.data, c.header)
        try {
          expect(parseHeader(JSON.parse(readFileSync(join(dir, VAULT_FILE), 'utf8')), weak).version).toBe(c.version)
          const notes = await notesOf(dir, secret())
          const first = seen.get(c.label)
          if (first) expect(notes, `${c.label} by ${how}`).toEqual(first)
          else seen.set(c.label, notes)
          // The device slot is carried, never opened: the header on disk still holds it after the unlock.
          if (c.version === 3) expect(canonicalJson(JSON.parse(readFileSync(join(dir, VAULT_FILE), 'utf8')).wraps[v3Manifest.device])).toBe(canonicalJson(JSON.parse(readFileSync(c.header!, 'utf8')).wraps[v3Manifest.device]))
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      }
    }
    expect(seen.get('v1')).toEqual({ docs: [], idleMinutes: manifest.settings.idleMinutes })
    expect(seen.get('v2')!.docs.some((d) => d.includes(v2Secrets.note))).toBe(true)
    // v3 is v2's data folder under the upgraded header: the very same notes.
    expect(seen.get('v3')).toEqual(seen.get('v2'))
  })
})
