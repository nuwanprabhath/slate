// Review C9 C1: a conversion to fips-140-3 cut short at any step, then unlocked with the OLD password and with the NEW
// one (the natural guess right after choosing it), never loses the notes: no unlock deletes the only complete
// database. Its own file, in two phases: every standard-profile step (Argon2id) runs before the first fips-140-3
// unlock latches the module for the process (C5).
import { describe, expect, it, vi } from 'vitest'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { LoroDoc } from 'loro-crdt'
import { secretBytes } from '../../shared/secret'
import { writeSettings } from '../settings'
import { DocStore } from '../store'
import type { KeyRing } from './keyring'
import { Migration, REKEY_STEPS, type MigrationDeps, type RekeyStep } from './migration'
import { storeWithLk } from './testVault'
import { LOCAL_KEYS_FILE, unlockVault } from './unlock'

vi.setConfig({ testTimeout: 120_000 })
const weak = { allowWeakForTests: true }
const PASSWORD = 'correct horse battery staple'
const FIPS_PASSWORD = 'a fifteen-plus character passphrase'
const PAGE = `page:${randomUUID()}`
const STEPS = REKEY_STEPS.filter((s) => !['repush', 'sweep', 'prune'].includes(s)) as RekeyStep[]
const root = mkdtempSync(join(tmpdir(), 'slate-convert-crash-'))
const results = new Map<RekeyStep, { dir: string; old: string | null }>()
const opened: Array<{ ring: KeyRing; close(): void }> = []
const closeOpened = () => {
  for (const o of opened.splice(0)) {
    o.close()
    if (o.ring.isOpen) o.ring.close()
  }
}

function deps(dataDir: string, crashAt?: RekeyStep): MigrationDeps {
  return {
    dataDir,
    kdfOpts: weak,
    kdf: { argon2: { memoryKiB: 64, passes: 1 }, pbkdf2Iterations: 1000 },
    remote: () => null,
    closeServices: async () => {},
    reopenPlaintext: () => {},
    openServices: (keyRing, dbFile) => {
      const store = storeWithLk(keyRing, dbFile)
      opened.push({ ring: keyRing, close: () => store.close() })
      return { store }
    },
    ...(crashAt ? { crashAt } : {}),
  }
}

async function note(dataDir: string, password: string): Promise<string | null> {
  let ring: KeyRing | undefined
  try {
    const u = await unlockVault(dataDir, { password: secretBytes(password) }, weak)
    ring = u.keyRing
    const store = storeWithLk(ring, u.dbFile)
    try {
      const doc = new LoroDoc()
      doc.importBatch(store.load(PAGE))
      return doc.getText('t').toString()
    } finally {
      store.close()
    }
  } catch {
    return null
  } finally {
    ring?.close()
  }
}

const databases = (dir: string) => readdirSync(dir).filter((f) => /^slate-[0-9a-f]{8}\.db$/.test(f))

describe('review C9 C1: a conversion cut short never loses the notes', () => {
  it('phase 1 (standard): crash before every step, then the old password', async () => {
    for (const step of STEPS) {
      const dir = join(root, step)
      mkdirSync(dir, { recursive: true })
      const plain = new DocStore(join(dir, 'slate.db'))
      const doc = new LoroDoc()
      doc.getText('t').insert(0, 'SECRET-NOTE')
      plain.append(PAGE, doc.export({ mode: 'update' }))
      writeSettings(plain, { deviceId: randomUUID() })
      plain.close()
      const wizard = new Migration(deps(dir))
      const p = await wizard.prepare(secretBytes(PASSWORD))
      if (p.kind !== 'recovery') throw new Error('expected a new vault')
      await wizard.confirmRecovery(secretBytes(p.recoveryKey))
      await wizard.run()
      closeOpened()
      const u = await unlockVault(dir, { password: secretBytes(PASSWORD) }, weak)
      const m = new Migration(deps(dir, step))
      const { recoveryKey } = await m.prepareRekey(u.keyRing, 'convert', secretBytes(PASSWORD), secretBytes(FIPS_PASSWORD))
      await m.confirmRecovery(secretBytes(recoveryKey))
      await expect(m.runRekey(u.keyRing)).rejects.toThrow(`Injected crash before ${step}`)
      closeOpened()
      if (u.keyRing.isOpen) u.keyRing.close()
      // Three copies of the crashed folder: one for the old password, one for the new, one left as it was.
      cpSync(dir, `${dir}-new`, { recursive: true })
      cpSync(dir, `${dir}-pristine`, { recursive: true })
      results.set(step, { dir, old: await note(dir, PASSWORD) })
    }
    expect(results.size).toBe(STEPS.length)
  })

  it('phase 2 (fips-140-3): the new password, then the notes are still there under one of the two', async () => {
    for (const step of STEPS) {
      const { old } = results.get(step)!
      const dir = join(root, `${step}-new`)
      const pristine = join(root, `${step}-pristine`)
      // The new password first, on a folder the old one never touched.
      const fresh = await note(dir, FIPS_PASSWORD)
      expect(old ?? fresh, step).toBe('SECRET-NOTE')
      for (const t of [old, fresh]) if (t !== null) expect(t, step).toBe('SECRET-NOTE')
      // The pair on disk names a database that is there; a complete copy the crash left unstaged is removed by the next
      // unlock that succeeds, so after a successful one exactly one is left.
      expect(databases(dir).length, step).toBeGreaterThanOrEqual(1)
      if (fresh !== null) expect(databases(dir), step).toHaveLength(1)
      const named = (JSON.parse(readFileSync(join(dir, LOCAL_KEYS_FILE), 'utf8')) as { db: string }).db
      expect(existsSync(join(dir, named)), step).toBe(true)
      if (fresh !== null) {
        // Once the new password opens, it keeps opening: the swap (if any) left a complete pair.
        expect(await note(dir, FIPS_PASSWORD), step).toBe('SECRET-NOTE')
      } else {
        // It did not open: the old pair and its database are as the crash left them, so the old password still does
        // (phase 1 showed it on a copy; Argon2id cannot run here after the latch).
        expect(readFileSync(join(dir, LOCAL_KEYS_FILE), 'utf8'), step).toBe(readFileSync(join(pristine, LOCAL_KEYS_FILE), 'utf8'))
        expect(readFileSync(join(dir, named)).equals(readFileSync(join(pristine, named))), step).toBe(true)
      }
    }
  })
})
