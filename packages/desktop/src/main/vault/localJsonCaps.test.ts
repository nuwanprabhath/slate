import { execFileSync } from 'node:child_process'
import { existsSync, linkSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { scheduleOf } from './header'
import { removeStrayDatabases } from '../db/migrateToEncrypted'
import { JsonTooLarge, LOCAL_JSON_CAP, readJsonCapped, readJsonCappedSync } from './atomic'
import { KeyRing } from './keyring'
import { Migration, type MigrationDeps } from './migration'
import { readPreunlock } from './preunlock'
import { openQuickUnlock, QUICK_UNLOCK_FILE, QuickUnlockFailed, type QuickUnlockPlatform } from './quickUnlock'
import type { VaultRemote } from './remoteVault'
import { createEncryptedDataDir } from './testVault'
import { LOCAL_KEYS_FILE, PENDING_FILE, PREUNLOCK_FILE, REJOIN_KEYS_FILE, REJOIN_VAULT_FILE, UnlockFailed, unlockVault, VAULT_FILE } from './unlock'
import { checkRemoteVault } from './vaultCheck'
import { secretBytes } from '../../shared/secret'

const weak = { allowWeakForTests: true }
const PASSWORD = 'correct horse battery'

/** Valid JSON of exactly `bytes` bytes, so only its size can make a reader refuse it. */
function jsonOfSize(bytes: number): string {
  const head = '{"pad":"'
  const tail = '"}'
  return head + 'a'.repeat(bytes - head.length - tail.length) + tail
}

const OVER = jsonOfSize(LOCAL_JSON_CAP + 1)

/** Every JSON.parse call during `run`, so a test can prove the oversized text never reached it. */
async function parsedDuring(run: () => Promise<unknown>): Promise<number[]> {
  const spy = vi.spyOn(JSON, 'parse')
  try {
    await run()
    return spy.mock.calls.map(([text]) => String(text).length)
  } finally {
    spy.mockRestore()
  }
}

const tmp = () => mkdtempSync(join(tmpdir(), 'slate-cap-'))

afterEach(() => vi.restoreAllMocks())

describe('readJsonCapped (F-GEN-02)', () => {
  it('parses a file at the cap and refuses one byte more before JSON.parse', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'at.json'), jsonOfSize(LOCAL_JSON_CAP))
    writeFileSync(join(dir, 'over.json'), OVER)
    expect(await readJsonCapped(join(dir, 'at.json'), LOCAL_JSON_CAP)).toMatchObject({ pad: expect.any(String) })
    const lengths = await parsedDuring(() => expect(readJsonCapped(join(dir, 'over.json'), LOCAL_JSON_CAP)).rejects.toThrow(JsonTooLarge))
    expect(lengths).toEqual([])
  })

  it('the cap is 64 KiB, as for remote reads', () => {
    expect(LOCAL_JSON_CAP).toBe(64 * 1024)
  })

  it('the synchronous variant caps the same way', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'at.json'), jsonOfSize(LOCAL_JSON_CAP))
    writeFileSync(join(dir, 'over.json'), OVER)
    expect(readJsonCappedSync(join(dir, 'at.json'))).toMatchObject({ pad: expect.any(String) })
    const lengths = await parsedDuring(async () => expect(() => readJsonCappedSync(join(dir, 'over.json'))).toThrow(JsonTooLarge))
    expect(lengths).toEqual([])
  })

  it('refuses a FIFO (or any non-file) at once instead of blocking on open', async () => {
    const dir = tmp()
    const fifo = join(dir, 'vault.json')
    execFileSync('mkfifo', [fifo])
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('blocked on the FIFO')), 2000))
    await expect(Promise.race([readJsonCapped(fifo), timeout])).rejects.toThrow(JsonTooLarge)
    expect(() => readJsonCappedSync(fifo)).toThrow(JsonTooLarge)
    expect(() => readJsonCappedSync(dir)).toThrow(JsonTooLarge)
  })

  it('a missing file still throws the fs error', async () => {
    await expect(readJsonCapped(join(tmp(), 'none.json'), LOCAL_JSON_CAP)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('T-FUZZ-13: every local JSON of 64 KiB + 1 byte is refused before JSON.parse', () => {
  const fits = (lengths: number[]) => expect(lengths.filter((n) => n > LOCAL_JSON_CAP)).toEqual([])

  it('T-FUZZ-13: vault.json (unlock.ts)', async () => {
    const dir = tmp()
    await createEncryptedDataDir(dir, secretBytes(PASSWORD), weak)
    writeFileSync(join(dir, VAULT_FILE), OVER)
    fits(await parsedDuring(() => expect(unlockVault(dir, { password: secretBytes(PASSWORD) }, weak)).rejects.toThrow(JsonTooLarge)))
  })

  it('T-FUZZ-13: vault.pending.json, vault.rejoin.json and local-keys.rejoin.json (unlock.ts) are ignored', async () => {
    const dir = tmp()
    await createEncryptedDataDir(dir, secretBytes(PASSWORD), weak)
    for (const f of [PENDING_FILE, REJOIN_VAULT_FILE]) writeFileSync(join(dir, f), OVER)
    fits(await parsedDuring(() => expect(unlockVault(dir, { password: secretBytes('not the password') }, weak)).rejects.toThrow(UnlockFailed)))
    writeFileSync(join(dir, REJOIN_KEYS_FILE), OVER)
    writeFileSync(join(dir, LOCAL_KEYS_FILE), OVER)
    fits(await parsedDuring(() => expect(unlockVault(dir, { password: secretBytes(PASSWORD) }, weak)).rejects.toThrow(UnlockFailed)))
  })

  it('T-FUZZ-13: local-keys.json (unlock.ts)', async () => {
    const dir = tmp()
    await createEncryptedDataDir(dir, secretBytes(PASSWORD), weak)
    writeFileSync(join(dir, LOCAL_KEYS_FILE), OVER)
    fits(await parsedDuring(() => expect(unlockVault(dir, { password: secretBytes(PASSWORD) }, weak)).rejects.toThrow(UnlockFailed)))
  })

  it('T-FUZZ-13: vault.json before a sync upload (vaultCheck.ts)', async () => {
    const dir = tmp()
    const { mk, header } = await createEncryptedDataDir(dir, secretBytes(PASSWORD), weak)
    writeFileSync(join(dir, VAULT_FILE), OVER)
    const remote = { read: async () => ({ header: null, version: null, otherFiles: [] }), writeHeader: async () => true } as unknown as VaultRemote
    const keyRing = new KeyRing(mk, undefined, scheduleOf(header))
    fits(await parsedDuring(() => expect(checkRemoteVault({ remote, dataDir: dir, keyRing, opts: weak })).rejects.toThrow(/missing or damaged/)))
    keyRing.close()
  })

  it('T-FUZZ-13: preunlock.json (preunlock.ts)', async () => {
    const dir = tmp()
    writeFileSync(join(dir, PREUNLOCK_FILE), OVER)
    let got: unknown = 'unset'
    fits(await parsedDuring(async () => (got = await readPreunlock(join(dir, PREUNLOCK_FILE)))))
    expect(got).toBeNull()
  })

  it('T-FUZZ-13: quick-unlock.bin and local-keys.json (quickUnlock.ts)', async () => {
    const p: QuickUnlockPlatform = {
      platform: 'linux',
      secrets: { available: async () => true, seal: async (s) => Buffer.from(s), open: async (b) => ({ plain: b.toString(), rewrite: false }) },
      systemPreferences: {},
    }
    for (const file of [QUICK_UNLOCK_FILE, LOCAL_KEYS_FILE]) {
      const dir = tmp()
      await createEncryptedDataDir(dir, secretBytes(PASSWORD), weak)
      writeFileSync(join(dir, QUICK_UNLOCK_FILE), jsonOfSize(100))
      writeFileSync(join(dir, file), OVER)
      fits(await parsedDuring(() => expect(openQuickUnlock(dir, p)).rejects.toThrow(QuickUnlockFailed)))
    }
  })

  it('T-FUZZ-13: local-keys.json when removing stray databases (db/migrateToEncrypted.ts) keeps every database', async () => {
    const dir = tmp()
    const { header } = await createEncryptedDataDir(dir, secretBytes(PASSWORD), weak)
    const live = `slate-${header.vaultId.slice(0, 8)}.db`
    writeFileSync(join(dir, LOCAL_KEYS_FILE), OVER)
    fits(await parsedDuring(async () => removeStrayDatabases(dir)))
    // An unreadable local-keys.json does not say which database is live, so none is removed.
    expect(existsSync(join(dir, live))).toBe(true)
    expect(readdirSync(dir).filter((f) => f.startsWith('slate-')).length).toBeGreaterThan(0)
  })

  it('T-FUZZ-13 (C1 re-review): with local-keys.json unreadable, plaintext temp copies still go, scrubbed', async () => {
    const dir = tmp()
    const { header } = await createEncryptedDataDir(dir, secretBytes(PASSWORD), weak)
    const live = `slate-${header.vaultId.slice(0, 8)}.db`
    const temp = 'slate-0badc0de.db.tmp'
    writeFileSync(join(dir, temp), 'plaintext notes')
    // A second name for the temp copy's inode sees what happened to its bytes before the unlink.
    linkSync(join(dir, temp), join(dir, 'peek'))
    writeFileSync(join(dir, LOCAL_KEYS_FILE), OVER)
    removeStrayDatabases(dir)
    expect(existsSync(join(dir, temp))).toBe(false)
    expect(readFileSync(join(dir, 'peek')).every((b) => b === 0)).toBe(true)
    expect(existsSync(join(dir, live))).toBe(true)
  })

  it('T-FUZZ-13: vault.json when resuming a migration (migration.ts)', async () => {
    const dir = tmp()
    await createEncryptedDataDir(dir, secretBytes(PASSWORD), weak)
    writeFileSync(join(dir, VAULT_FILE), OVER)
    const runner = new Migration({ dataDir: dir, kdfOpts: weak } as unknown as MigrationDeps)
    fits(await parsedDuring(() => expect(runner.resume(secretBytes(PASSWORD))).rejects.toThrow(JsonTooLarge)))
  })
})
