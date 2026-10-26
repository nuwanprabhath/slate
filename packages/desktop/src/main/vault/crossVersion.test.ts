// Audit C4 criterion 2 and T-KAT-03: files sealed by the audited (pre-C4) code open after C4, and what
// C4 seals opens with the audited construction. fixtures/c4 was written by the pre-C4 build (main
// efcbb2d) through the audited vault/crypto.ts, header.ts, localKeys.ts, names.ts, quickUnlock.ts and
// preunlock.ts; it is never regenerated. The reference below is that construction in node:crypto.
import { createDecipheriv, hkdfSync } from 'node:crypto'
import { cpSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
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
import { unlockVault } from './unlock'
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
