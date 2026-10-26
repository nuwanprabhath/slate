import { randomBytes, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { WrongKey } from '../db/openDatabase'
import { storeWithLk } from './testVault'
import { DocStore } from '../store'
import { writeJsonAtomic } from './atomic'
import { importKey, sameDbKey } from '../../../test/vaultKeys'
import { BadLocalKeys, createLocalKeys, readLocalKeys } from './localKeys'
import { destroyKey } from './native'
import { SCHEDULE_V1, scheduleV2 } from './suite'
import { removeStrayDatabases } from '../db/migrateToEncrypted'
import { createEncryptedDataDir } from './testVault'
import { LOCAL_KEYS_FILE, UnlockFailed, unlockVault } from './unlock'
import { secretBytes } from '../../shared/secret'

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

describe('local-keys.json', () => {
  const mk = importKey(randomBytes(32), 'master')
  const vaultId = randomUUID()
  const deviceId = randomUUID()
  const db = `slate-${vaultId.slice(0, 8)}.db`
  const v2 = scheduleV2(vaultId, 'standard')

  it('wraps a random LK that reads back under the same MK', () => {
    const { json, lk } = createLocalKeys(mk, SCHEDULE_V1, vaultId, deviceId, db)
    expect(json).toMatchObject({ format: 'slate-local-keys', version: 1, vaultId, deviceId, db })
    expect(typeof lk).toBe('number')
    const back = readLocalKeys(clone(json), mk, SCHEDULE_V1)
    expect(sameDbKey(back.lk, readLocalKeys(clone(json), mk, SCHEDULE_V1).lk)).toBe(true)
    expect(back).toMatchObject({ db, deviceId })
    expect(sameDbKey(createLocalKeys(mk, SCHEDULE_V1, vaultId, deviceId, db).lk, back.lk)).toBe(false)
  })

  it('refuses another MK, a changed vaultId or deviceId, and bad shapes', () => {
    for (const schedule of [SCHEDULE_V1, v2]) {
      const { json } = createLocalKeys(mk, schedule, vaultId, deviceId, db)
      expect(() => readLocalKeys(json, importKey(randomBytes(32), 'master'), schedule)).toThrow(BadLocalKeys)
      expect(() => readLocalKeys({ ...json, vaultId: randomUUID() }, mk, schedule)).toThrow(BadLocalKeys)
      expect(() => readLocalKeys({ ...json, deviceId: randomUUID() }, mk, schedule)).toThrow(BadLocalKeys)
      expect(() => readLocalKeys({ ...json, extra: 1 }, mk, schedule)).toThrow(BadLocalKeys)
      expect(() => readLocalKeys({ ...json, db: '../slate.db' }, mk, schedule)).toThrow(BadLocalKeys)
      expect(() => readLocalKeys(null, mk, schedule)).toThrow(BadLocalKeys)
      expect(() => createLocalKeys(mk, schedule, vaultId, deviceId, '/etc/passwd')).toThrow()
    }
  })

  it('C5 (review C4 M1-R): LK never moves to another vault; there is no local-keys rewrap, and a v1 file does not open as v2', async () => {
    expect(Object.keys(await import('./localKeys'))).not.toContain('rewrapLocalKeys')
    const { json } = createLocalKeys(mk, SCHEDULE_V1, vaultId, deviceId, db)
    expect(() => readLocalKeys(json, mk, v2)).toThrow(BadLocalKeys)
    const { json: j2 } = createLocalKeys(mk, v2, vaultId, deviceId, db)
    expect(() => readLocalKeys(j2, mk, SCHEDULE_V1)).toThrow(BadLocalKeys)
  })
})

describe('local-keys.json v2 (audit §4.5.4): every field but the wrap is authenticated', () => {
  const mk = importKey(randomBytes(32), 'master')
  const vaultId = randomUUID()
  const deviceId = randomUUID()
  const db = `slate-${vaultId.slice(0, 8)}.db`
  const v2 = scheduleV2(vaultId, 'standard')

  it('writes the v2 fields and reads them back', () => {
    const { json, lk } = createLocalKeys(mk, v2, vaultId, deviceId, db)
    expect(Object.keys(json).sort()).toEqual(['ct', 'db', 'dbCipher', 'deviceId', 'format', 'keyEpoch', 'nonce', 'profile', 'vaultId', 'version'])
    expect(json).toMatchObject({ format: 'slate-local-keys', version: 2, vaultId, deviceId, keyEpoch: 0, db, dbCipher: 'sqlcipher-4' })
    const back = readLocalKeys(clone(json), mk, v2)
    expect(sameDbKey(back.lk, lk)).toBe(true)
  })

  it('F-GEN-01: a repointed db, another epoch or another cipher fails the tag', () => {
    const { json } = createLocalKeys(mk, v2, vaultId, deviceId, db)
    expect(() => readLocalKeys({ ...json, db: 'slate.db' }, mk, v2)).toThrow(BadLocalKeys)
    expect(() => readLocalKeys({ ...json, keyEpoch: 1 }, mk, v2)).toThrow(BadLocalKeys)
    expect(() => readLocalKeys({ ...json, dbCipher: 'sqlcipher-3' }, mk, v2)).toThrow(BadLocalKeys)
  })

  it('review C1: with a repointed v2 db and a planted migration.json, cancelling the migration keeps the real database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slate-lk-stray-'))
    const { header, mk: vmk } = await createEncryptedDataDir(dir, secretBytes('correct horse'), { allowWeakForTests: true })
    destroyKey(vmk)
    const real = `slate-${header.vaultId.slice(0, 8)}.db`
    const file = join(dir, LOCAL_KEYS_FILE)
    const json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    writeFileSync(file, JSON.stringify({ ...json, db: 'slate-00000000.db' }))
    writeFileSync(join(dir, 'migration.json'), JSON.stringify({ step: 'vault', vaultId: header.vaultId, dbFile: 'slate-00000000.db' }))
    removeStrayDatabases(dir)
    expect(existsSync(join(dir, real))).toBe(true)
  })
})

describe('local-keys.json v1 does not authenticate `db` (F-GEN-01; the AAD fix is v2, C5)', () => {
  const weak = { allowWeakForTests: true }
  const PAGE = 'page:00000000-0000-4000-8000-000000000001'

  /** A data folder whose local-keys.json names `db` instead of its own database. */
  async function repointed(db: (dir: string) => string): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'slate-lk-db-'))
    await createEncryptedDataDir(dir, secretBytes('correct horse'), weak)
    const file = join(dir, LOCAL_KEYS_FILE)
    const json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    writeFileSync(file, JSON.stringify({ ...json, db: db(dir) }))
    return dir
  }

  /** The repointed database is never opened as notes: the unlock fails, or LK does not open it. */
  async function refused(dir: string): Promise<void> {
    let opened: Awaited<ReturnType<typeof unlockVault>>
    try {
      opened = await unlockVault(dir, { password: secretBytes('correct horse') }, weak)
    } catch (e) {
      expect(e).toBeInstanceOf(UnlockFailed)
      return
    }
    expect(() => storeWithLk(opened.keyRing, opened.dbFile)).toThrow(WrongKey)
    opened.keyRing.close()
  }

  it('a db that does not match the vault id is refused: a plaintext slate.db ends in WrongKey, never a plaintext open', async () => {
    const dir = await repointed((d) => {
      const plain = new DocStore(join(d, 'slate.db'))
      const doc = new LoroDoc()
      doc.getText('t').insert(0, 'planted')
      plain.append(PAGE, doc.export({ mode: 'update' }))
      plain.close()
      return 'slate.db'
    })
    await refused(dir)
  })

  it('a db that does not match the vault id is refused: another vault\'s database ends in WrongKey', async () => {
    const other = mkdtempSync(join(tmpdir(), 'slate-lk-other-'))
    const { header } = await createEncryptedDataDir(other, secretBytes('another horse'), weak)
    const otherDb = `slate-${header.vaultId.slice(0, 8)}.db`
    const dir = await repointed((d) => {
      copyFileSync(join(other, otherDb), join(d, otherDb))
      return otherDb
    })
    await refused(dir)
  })
})

describe('writeJsonAtomic', () => {
  it('writes the value and leaves no temporary file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slate-atomic-'))
    const file = join(dir, 'local-keys.json')
    await writeJsonAtomic(file, { a: 1 })
    await writeJsonAtomic(file, { a: 2 })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ a: 2 })
    expect(readdirSync(dir)).toEqual(['local-keys.json'])
  })
})
