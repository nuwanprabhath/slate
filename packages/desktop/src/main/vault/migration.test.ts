import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc } from 'loro-crdt'
import { nodeGitRunner, SyncEngine, type DeltaPage, type RemoteDrive } from '@slate/sync'
import { FileBlobStore } from '../blobs'
import { openDatabase } from '../db/openDatabase'
import { docStoreLocal } from '../sync/localStore'
import { readSettings, writeSettings } from '../settings'
import { DocStore } from '../store'
import { liveHandles, lkBytesOf } from '../../../test/vaultKeys'
import { changePassword, createVault, parseHeader, proveSecret } from './header'
import type { KeyRing } from './keyring'
import { finishAfterSwitch, finishSwitchAtUnlock, Migration, MIGRATION_FILE, REJOIN_STEPS, resetSyncBookkeeping, type MigrationDeps } from './migration'
import { GitVaultRemote, type VaultRemote } from './remoteVault'
import { headersOpenedBy } from './testVault'
import { SEEN_FILE } from './seen'
import { checkRemoteVault } from './vaultCheck'
import { LOCAL_KEYS_FILE, PREUNLOCK_FILE, unlockVault, VAULT_FILE } from './unlock'
import { initialVaultState } from './vaultState'
import { expectNotesSurviveCrash, notesUnder, storeWithLk } from './testVault'
import { secretBytes } from '../../shared/secret'

// Each test spawns tens of git processes; 5 s is too tight on a loaded machine.
vi.setConfig({ testTimeout: 30_000 })
const weak = { allowWeakForTests: true }
const PASSWORD = 'correct horse battery staple'
const PAGE = `page:${randomUUID()}`
let dir: string
let dataDir: string
let bare: string
let calls: string[]
let opened: Array<{ keyRing: KeyRing; dbFile: string; store: DocStore }>

function loroUpdate(text: string): Uint8Array {
  const doc = new LoroDoc()
  doc.getText('t').insert(0, text)
  return doc.export({ mode: 'update' })
}

function seedPlaintext(): string {
  mkdirSync(dataDir, { recursive: true })
  const store = new DocStore(join(dataDir, 'slate.db'))
  store.append(PAGE, loroUpdate('SECRET-NOTE'))
  writeSettings(store, { deviceId: randomUUID(), idleMinutes: 15 })
  store.close()
  mkdirSync(join(dataDir, 'blobs'))
  const data = Buffer.from([1, 2, 3])
  const name = `${createHash('sha256').update(data).digest('hex')}.png`
  writeFileSync(join(dataDir, 'blobs', name), data)
  mkdirSync(join(dataDir, 'git-sync', 'abc123'), { recursive: true })
  writeFileSync(join(dataDir, 'git-sync', 'token.bin'), 'tok')
  return name
}

function gitRemote(name = 'vr'): GitVaultRemote {
  return new GitVaultRemote({ run: nodeGitRunner(), dir: join(dir, name), remoteUrl: `file://${bare}`, branch: 'main', authEnv: async () => ({}) })
}

function recording(remote: VaultRemote): VaultRemote {
  return {
    read: async () => {
      calls.push('remote.read')
      return remote.read()
    },
    claim: async (h, v) => {
      calls.push(`remote.claim(localVault=${existsSync(join(dataDir, VAULT_FILE))})`)
      return remote.claim(h, v)
    },
    writeHeader: (h, v) => remote.writeHeader(h, v),
  }
}

function deps(over: Partial<MigrationDeps> = {}): MigrationDeps {
  return {
    dataDir,
    kdfOpts: weak,
    kdf: { argon2: { memoryKiB: 64, passes: 1 }, pbkdf2Iterations: 1000 },
    remote: () => null,
    closeServices: async () => {
      calls.push('closeServices')
    },
    reopenPlaintext: () => {
      calls.push('reopenPlaintext')
    },
    openServices: (keyRing, dbFile) => {
      calls.push('openServices')
      const store = storeWithLk(keyRing, dbFile)
      opened.push({ keyRing, dbFile, store })
      return { store }
    },
    tempDir: join(dir, 'tmp'),
    ...over,
  }
}

async function encrypt(m: Migration): Promise<void> {
  const prepared = await m.prepare(secretBytes(PASSWORD))
  if (prepared.kind !== 'recovery') throw new Error(`expected a recovery key, got ${prepared.kind}`)
  expect(await m.confirmRecovery(secretBytes(prepared.recoveryKey))).toBe(true)
  expect(await m.run()).toEqual({ kind: 'done' })
}

/** What `initialVaultState` sees in the data folder at start-up. */
function filesNow(): { vault: boolean; localKeys: boolean; migration: boolean; plainDb: boolean } {
  const has = (f: string) => existsSync(join(dataDir, f))
  return { vault: has(VAULT_FILE), localKeys: has(LOCAL_KEYS_FILE), migration: has(MIGRATION_FILE), plainDb: has('slate.db') }
}

function closeOpened(): void {
  for (const o of opened.splice(0)) {
    o.store.close()
    o.keyRing.close()
  }
}

/** The page's text as stored in the encrypted database, opened the way unlock opens it. */
async function noteAfterUnlock(password = PASSWORD): Promise<string> {
  closeOpened()
  const { keyRing, dbFile } = await unlockVault(dataDir, { password: secretBytes(password) }, weak)
  const store = storeWithLk(keyRing, dbFile)
  try {
    const doc = new LoroDoc()
    doc.importBatch(store.load(PAGE))
    return doc.getText('t').toString()
  } finally {
    store.close()
    keyRing.close()
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'slate-migration-'))
  dataDir = join(dir, 'data')
  bare = join(dir, 'remote.git')
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', bare])
  calls = []
  opened = []
})

afterEach(() => {
  closeOpened()
  rmSync(dir, { recursive: true, force: true })
})

describe('Migration', () => {
  it('checks the remote first, claims it before any local change, then migrates locally', async () => {
    seedPlaintext()
    const m = new Migration(
      deps({ remote: () => recording(gitRemote()), syncNow: async () => void calls.push('syncNow'), pauseSync: async () => void calls.push('pauseSync') }),
    )
    await encrypt(m)
    expect(calls).toEqual(['remote.read', 'syncNow', 'pauseSync', 'remote.read', 'remote.claim(localVault=false)', 'closeServices', 'openServices'])
    expect(existsSync(join(dataDir, 'slate.db'))).toBe(false)
    expect(existsSync(join(dataDir, 'blobs'))).toBe(false)
    expect(existsSync(join(dataDir, MIGRATION_FILE))).toBe(false)
    // Clones go; the stored tokens stay.
    expect(readdirSync(join(dataDir, 'git-sync'))).toEqual(['token.bin'])
    expect(existsSync(join(dataDir, 'preunlock.json'))).toBe(true)
    expect(execFileSync('git', ['ls-tree', '-r', '--name-only', 'main'], { cwd: bare, encoding: 'utf8' })).toContain('e2ee/vault.json')
    expect(await noteAfterUnlock()).toBe('SECRET-NOTE')
  })

  it('without sync it never touches a remote', async () => {
    seedPlaintext()
    await encrypt(new Migration(deps()))
    expect(calls).toEqual(['closeServices', 'openServices'])
    expect(await noteAfterUnlock()).toBe('SECRET-NOTE')
  })

  it('a remote that already has a vault turns the wizard into a join before anything is generated', async () => {
    seedPlaintext()
    const theirs = await createVault({ password: secretBytes('their password 123'), kdf: { memoryKiB: 64, passes: 1 } }, weak)
    await gitRemote('other').claim(theirs.header, null)
    const m = new Migration(deps({ remote: () => gitRemote() }))
    expect(await m.prepare(secretBytes(PASSWORD))).toEqual({ kind: 'join' })
    expect(existsSync(join(dataDir, VAULT_FILE))).toBe(false)
  })

  it('refuses a recovery key that does not open the new vault', async () => {
    seedPlaintext()
    const m = new Migration(deps())
    const prepared = await m.prepare(secretBytes(PASSWORD))
    expect(prepared.kind).toBe('recovery')
    expect(await m.confirmRecovery(secretBytes('0000-0000-0000-0000-0000-0000-0000-0000-0000-0000-0000-0000-0000-0000'))).toBe(false)
    await expect(m.run()).rejects.toThrow(/recovery key/)
  })

  it('stops with the "another program" message while another connection holds the database', async () => {
    seedPlaintext()
    const other = openDatabase(join(dataDir, 'slate.db'), null)
    other.exec('BEGIN IMMEDIATE')
    try {
      const m = new Migration(deps())
      const prepared = await m.prepare(secretBytes(PASSWORD))
      await m.confirmRecovery(secretBytes(prepared.kind === 'recovery' ? prepared.recoveryKey : ''))
      await expect(m.run()).rejects.toThrow('Another program has your notes open')
    } finally {
      other.exec('ROLLBACK')
      other.close()
    }
    expect(calls).toContain('reopenPlaintext')
    expect(initialVaultState(filesNow())).toBe('migrating')
    expect(existsSync(join(dataDir, 'slate.db'))).toBe(true)
  })

  it('aborts on a doc id remote names cannot carry, naming no note', async () => {
    seedPlaintext()
    const store = new DocStore(join(dataDir, 'slate.db'))
    store.append('page:not-a-uuid', loroUpdate('x'))
    store.close()
    const m = new Migration(deps())
    const prepared = await m.prepare(secretBytes(PASSWORD))
    await m.confirmRecovery(secretBytes(prepared.kind === 'recovery' ? prepared.recoveryKey : ''))
    const err = (await m.run().catch((e: unknown) => e)) as Error
    expect(err.message).toMatch(/1 note/)
    expect(err.message).not.toContain('not-a-uuid')
  })

  for (const step of ['close', 'copy', 'bookkeeping', 'switch'] as const) {
    it(`a crash before "${step}" leaves the plaintext notes in use and resumes with the password`, async () => {
      seedPlaintext()
      const m = new Migration(deps({ crashAt: step }))
      await expect(encrypt(m)).rejects.toThrow(`Injected crash before ${step}`)
      expect(initialVaultState(filesNow())).toBe('migrating')
      expect(existsSync(join(dataDir, 'slate.db'))).toBe(true)
      // After a restart: a new orchestrator, the password asked again.
      const resumed = new Migration(deps())
      await expect(resumed.resume(secretBytes('wrong password here'))).rejects.toThrow("That password didn't work")
      await resumed.resume(secretBytes(PASSWORD))
      expect(existsSync(join(dataDir, 'slate.db'))).toBe(false)
      expect(await noteAfterUnlock()).toBe('SECRET-NOTE')
    })
  }

  it('a crash after the switch finishes the clean-up at the next unlock', async () => {
    seedPlaintext()
    await expect(encrypt(new Migration(deps({ crashAt: 'cleanup' })))).rejects.toThrow('Injected crash before cleanup')
    expect(initialVaultState(filesNow())).toBe('locked')
    expect(existsSync(join(dataDir, 'slate.db'))).toBe(true)
    finishAfterSwitch(dataDir, join(dir, 'tmp'))
    expect(existsSync(join(dataDir, 'slate.db'))).toBe(false)
    expect(existsSync(join(dataDir, MIGRATION_FILE))).toBe(false)
    expect(await noteAfterUnlock()).toBe('SECRET-NOTE')
  })

  it('joins a remote vault with the password, and with the recovery key', async () => {
    for (const how of ['password', 'recovery'] as const) {
      rmSync(dataDir, { recursive: true, force: true })
      rmSync(bare, { recursive: true, force: true })
      execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', bare])
      seedPlaintext()
      const theirs = await createVault({ password: secretBytes('their password 123'), kdf: { memoryKiB: 64, passes: 1 } }, weak)
      await gitRemote(`a-${how}`).claim(theirs.header, null)
      const m = new Migration(deps({ remote: () => gitRemote(`b-${how}`) }))
      await expect(m.join({ password: secretBytes('nope nope nope') })).rejects.toThrow("That password didn't work")
      await m.join(how === 'password' ? { password: secretBytes('their password 123') } : { recoveryKey: secretBytes(theirs.recoveryKey!) })
      expect(parseHeader(JSON.parse(readFileSync(join(dataDir, VAULT_FILE), 'utf8')), weak).vaultId).toBe(theirs.header.vaultId)
      expect(await noteAfterUnlock('their password 123')).toBe('SECRET-NOTE')
    }
  })

  it('changes the password remotely first, on the highest header, then locally', async () => {
    seedPlaintext()
    await encrypt(new Migration(deps({ remote: () => gitRemote() })))
    closeOpened()
    const { keyRing } = await unlockVault(dataDir, { password: secretBytes(PASSWORD) }, weak)
    const m = new Migration(deps({ remote: () => gitRemote() }))
    await m.changePassword(keyRing, { password: secretBytes(PASSWORD) }, secretBytes('a brand new password'))
    keyRing.close()
    const remoteHeader = parseHeader(JSON.parse(execFileSync('git', ['show', 'main:e2ee/vault.json'], { cwd: bare, encoding: 'utf8' })), weak)
    expect(remoteHeader.revision).toBe(2)
    expect(await noteAfterUnlock('a brand new password')).toBe('SECRET-NOTE')
    await expect(unlockVault(dataDir, { password: secretBytes(PASSWORD) }, weak)).rejects.toThrow()
    expect(await headersOpenedBy(dataDir, secretBytes(PASSWORD), weak)).toEqual([])
    // Review C9 M5: the header written to the remote is also this device's record of what it last saw there.
    expect(await headersOpenedBy(dataDir, secretBytes('a brand new password'), weak)).toEqual([VAULT_FILE, SEEN_FILE].sort())
  })

  it('"Encrypt this sync folder" wipes a plaintext remote and restarts sync from nothing', async () => {
    seedPlaintext()
    await encrypt(new Migration(deps()))
    const work = join(dir, 'work')
    execFileSync('git', ['clone', '-q', bare, work])
    mkdirSync(join(work, 'docs'))
    writeFileSync(join(work, 'docs/x'), 'PLAIN')
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
    execFileSync('git', ['checkout', '-q', '-b', 'main'], { cwd: work })
    execFileSync('git', ['add', '-A'], { cwd: work })
    execFileSync('git', ['commit', '-q', '-m', 'x'], { cwd: work, env })
    execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: work })
    const { keyRing, dbFile } = opened[0]!
    calls = []
    await new Migration(deps({ remote: () => gitRemote() })).encryptRemote(keyRing, dbFile)
    expect(calls).toEqual(['closeServices', 'openServices'])
    expect(execFileSync('git', ['ls-tree', '-r', '--name-only', 'main'], { cwd: bare, encoding: 'utf8' }).trim().split('\n').sort()).toEqual(['README.md', 'e2ee/README.md', 'e2ee/vault.json'])
  })

  it('deletes old clones before anything else after the switch, so sync never starts on one', async () => {
    seedPlaintext()
    const clone = join(dataDir, 'git-sync', 'abc123')
    mkdirSync(join(clone, '.git'), { recursive: true })
    // A plaintext leftover the clean-up cannot remove: it must not stop the clones going first.
    const stuck = join(dataDir, 'Cache', 'stuck')
    mkdirSync(stuck, { recursive: true })
    writeFileSync(join(stuck, 'f'), 'x')
    chmodSync(stuck, 0o555)
    const seen: boolean[] = []
    try {
      await encrypt(
        new Migration(
          deps({
            openServices: (keyRing, dbFile) => {
              seen.push(existsSync(clone))
              const store = storeWithLk(keyRing, dbFile)
              opened.push({ keyRing, dbFile, store })
              return { store }
            },
          }),
        ),
      )
    } finally {
      chmodSync(stuck, 0o755)
    }
    expect(seen).toEqual([false])
  })

  it('"Encrypt this sync folder" pauses sync before the claim', async () => {
    seedPlaintext()
    await encrypt(new Migration(deps()))
    const { keyRing, dbFile } = opened[0]!
    calls = []
    const remote = recording(gitRemote())
    const m = new Migration(
      deps({
        remote: () => remote,
        pauseSync: async () => {
          calls.push('pauseSync')
        },
        resumeSync: () => calls.push('resumeSync'),
      }),
    )
    await m.encryptRemote(keyRing, dbFile)
    expect(calls[0]).toBe('pauseSync')
    expect(calls.findIndex((c) => c.startsWith('remote.claim'))).toBeGreaterThan(0)
  })

  it('a wrong current password changes nothing', async () => {
    seedPlaintext()
    await encrypt(new Migration(deps()))
    closeOpened()
    const { keyRing } = await unlockVault(dataDir, { password: secretBytes(PASSWORD) }, weak)
    const before = readFileSync(join(dataDir, VAULT_FILE), 'utf8')
    await expect(new Migration(deps()).changePassword(keyRing, { password: secretBytes('not the password') }, secretBytes('a brand new password'))).rejects.toThrow("That password didn't work")
    keyRing.close()
    expect(readFileSync(join(dataDir, VAULT_FILE), 'utf8')).toBe(before)
  })
})

describe('resetSyncBookkeeping', () => {
  class MemoryDrive implements RemoteDrive {
    files = new Map<string, Uint8Array>()
    async upload(path: string, bytes: Uint8Array) {
      this.files.set(path, bytes)
    }
    async download(path: string) {
      return this.files.get(path)!
    }
    async remove(path: string) {
      this.files.delete(path)
    }
    async delta(): Promise<DeltaPage> {
      return { items: [...this.files.keys()].map((path) => ({ id: path, path, eTag: '1', deleted: false, isFile: true })), cursor: 'c' }
    }
  }

  it('makes the next sync push every doc and image again, and keeps unrelated keys', async () => {
    const name = seedPlaintext()
    const file = join(dataDir, 'slate.db')
    const first = new MemoryDrive()
    const sync = async (drive = first) => {
      const store = new DocStore(file)
      const deviceId = readSettings(store).deviceId!
      const engine = new SyncEngine({ local: docStoreLocal(store, new FileBlobStore(join(dataDir, 'blobs')), () => {}), remote: drive, deviceId, deviceName: 'x' })
      const report = await engine.syncOnce()
      store.setSyncMeta('search-index-version', new TextEncoder().encode('7'))
      store.close()
      return { report, drive }
    }
    expect((await sync()).report.pushed).toBe(1)
    expect((await sync()).report.pushed).toBe(0)
    resetSyncBookkeeping(file, null)
    const again = await sync(new MemoryDrive())
    expect(again.report.pushed).toBe(1)
    expect([...again.drive.files.keys()]).toContain(`blobs/${name}`)
    const store = new DocStore(file)
    expect(new TextDecoder().decode(store.getSyncMeta('search-index-version'))).toBe('7')
    store.close()
  })
})

describe('changePassword on a header revision written elsewhere', () => {
  it('builds on the pending (higher) header', async () => {
    seedPlaintext()
    await encrypt(new Migration(deps({ remote: () => gitRemote() })))
    closeOpened()
    // Another device bumps the remote to revision 2.
    const local = parseHeader(JSON.parse(readFileSync(join(dataDir, VAULT_FILE), 'utf8')), weak)
    const { keyRing } = await unlockVault(dataDir, { password: secretBytes(PASSWORD) }, weak)
    const mk = keyRing.get('mk')
    const r2 = await changePassword(local, mk, await proveSecret(local, { password: secretBytes(PASSWORD) }, weak), secretBytes('the other device pw'), weak)
    const snap = await gitRemote('other').read()
    expect(await gitRemote('other').writeHeader(r2, snap.version)).toBe(true)
    // Review C9 M5: a change is written only over the header this device last saw, so it syncs first (which keeps r2
    // as the pending header and as the one seen); before that, the change is refused.
    await expect(new Migration(deps({ remote: () => gitRemote() })).changePassword(keyRing, { password: secretBytes(PASSWORD) }, secretBytes('my newest password!'))).rejects.toThrow(/Another device changed the vault/)
    await checkRemoteVault({ remote: gitRemote(), dataDir, keyRing, opts: weak })
    await new Migration(deps({ remote: () => gitRemote() })).changePassword(keyRing, { password: secretBytes(PASSWORD) }, secretBytes('my newest password!'))
    keyRing.close()
    const remoteHeader = parseHeader(JSON.parse(execFileSync('git', ['show', 'main:e2ee/vault.json'], { cwd: bare, encoding: 'utf8' })), weak)
    expect(remoteHeader.revision).toBe(3)
    expect(await noteAfterUnlock('my newest password!')).toBe('SECRET-NOTE')
  })
})

describe('finishing a switched migration at unlock (§7.4)', () => {
  it('is best effort: a clean-up that throws is logged, never thrown, and holds sync back', () => {
    mkdirSync(join(dataDir, 'git-sync', 'stale'), { recursive: true })
    writeFileSync(join(dataDir, MIGRATION_FILE), '{}')
    const logged: string[] = []
    const log = { warn: (msg: string) => void logged.push(msg) }
    const ok = finishSwitchAtUnlock(dataDir, log, () => {
      throw new Error('disk full')
    })
    expect(ok).toBe(false)
    expect(logged).toHaveLength(1)
  })

  it('lets sync start once the clean-up is done, or when there was none', () => {
    mkdirSync(join(dataDir, 'git-sync', 'stale'), { recursive: true })
    const log = { warn: () => {} }
    expect(finishSwitchAtUnlock(dataDir, log)).toBe(true)
    writeFileSync(join(dataDir, MIGRATION_FILE), '{}')
    expect(finishSwitchAtUnlock(dataDir, log, (d) => finishAfterSwitch(d, join(dir, 'tmp')))).toBe(true)
    expect(existsSync(join(dataDir, 'git-sync', 'stale'))).toBe(false)
  })
})

describe('rejoin (§7.5) survives a crash or failure at every step', () => {
  const OTHER = 'another vault entirely, longer'

  /** This device encrypted with PASSWORD; the remote now holds a different vault opened by OTHER. */
  async function setup(over: Partial<MigrationDeps> = {}): Promise<{ m: Migration; keyRing: KeyRing }> {
    seedPlaintext()
    await encrypt(new Migration(deps()))
    const first = opened.splice(0)[0]!
    first.store.close()
    const other = await createVault({ password: secretBytes(OTHER), kdf: { memoryKiB: 64, passes: 1 } }, weak)
    const remote: VaultRemote = { read: async () => ({ header: other.header, version: 'v1', otherFiles: [] }), claim: async () => false, writeHeader: async () => false }
    calls = []
    return { m: new Migration(deps({ remote: () => remote, ...over })), keyRing: first.keyRing }
  }

  it('adopts the remote vault: its password opens the notes, the old one no longer does', async () => {
    const { m, keyRing } = await setup()
    await m.rejoin(keyRing, { password: secretBytes(OTHER) })
    expect(await noteAfterUnlock(OTHER)).toBe('SECRET-NOTE')
    await expect(unlockVault(dataDir, { password: secretBytes(PASSWORD) }, weak)).rejects.toThrow()
    expect(readdirSync(dataDir).filter((f) => f.includes('rejoin'))).toEqual([])
  })

  it('C5 (review C4 M1-R): the device gets a fresh LK under the new vault and a rekeyed copy of its database; the old one is gone', async () => {
    const { m, keyRing } = await setup()
    const oldLk = await lkBytesOf(dataDir, PASSWORD)
    const oldDb = (JSON.parse(readFileSync(join(dataDir, LOCAL_KEYS_FILE), 'utf8')) as { db: string }).db
    await m.rejoin(keyRing, { password: secretBytes(OTHER) })
    const json = JSON.parse(readFileSync(join(dataDir, LOCAL_KEYS_FILE), 'utf8')) as { db: string; version: number }
    expect(json.version).toBe(2)
    expect(json.db).not.toBe(oldDb)
    expect(existsSync(join(dataDir, oldDb))).toBe(false)
    expect((await lkBytesOf(dataDir, OTHER)).equals(oldLk)).toBe(false)
    expect(await noteAfterUnlock(OTHER)).toBe('SECRET-NOTE')
  })

  for (const [step, order] of REJOIN_STEPS.flatMap((s) => [[s, 'old first'], [s, 'new first']] as const)) {
    it(`a crash before ${step} leaves a vault some password opens, with the notes (${order})`, async () => {
      const { m, keyRing } = await setup({ crashAt: step })
      const notes = (await notesUnder(dataDir, () => ({ password: secretBytes(PASSWORD) }), weak))!
      const withOldRing = liveHandles()
      await expect(m.rejoin(keyRing, { password: secretBytes(OTHER) })).rejects.toThrow(`Injected crash before ${step}`)
      closeOpened()
      keyRing.close()
      await expectNotesSurviveCrash(dataDir, {
        old: { label: 'old password', secret: () => ({ password: secretBytes(PASSWORD) }) },
        next: [{ label: 'new password', secret: () => ({ password: secretBytes(OTHER) }) }],
        notes,
        opts: weak,
      })
      // Review C4 M2: whichever step it stopped at, no key of the old or the new vault is left behind.
      expect(liveHandles()).toBe(withOldRing - 9) // the old ring: a header-v2 vault holds MK, LK and seven subkeys
      // Review C9 C1: whichever secret the user types first (the new one, after a crash, is the natural guess), no
      // unlock deletes the only complete database: the notes open afterwards with one of them.
      const texts: string[] = []
      for (const password of order === 'old first' ? [PASSWORD, OTHER, PASSWORD, OTHER] : [OTHER, PASSWORD, OTHER, PASSWORD]) {
        try {
          texts.push(await noteAfterUnlock(password))
        } catch {
          // This password belongs to the pair that did not survive.
        }
      }
      expect(texts.length).toBeGreaterThanOrEqual(2)
      expect(texts.every((t) => t === 'SECRET-NOTE')).toBe(true)
      // Review C5 L3: the unlock that finished or forgot the rejoin removed the other database, whichever it was.
      expect(readdirSync(dataDir).filter((f) => /^slate-[0-9a-f]{8}\.db$/.test(f))).toHaveLength(1)
    })
  }

  it('a failure before the swap reopens the notes with the old keys', async () => {
    const { m, keyRing } = await setup({ closeServices: () => Promise.reject(new Error('flush broke')) })
    await expect(m.rejoin(keyRing, { password: secretBytes(OTHER) })).rejects.toThrow('flush broke')
    expect(calls).toContain('openServices')
    expect(opened.at(-1)!.keyRing).toBe(keyRing)
    expect(await noteAfterUnlock(PASSWORD)).toBe('SECRET-NOTE')
  })

  it('a failure opening the new services leaves the new vault openable', async () => {
    let first = true
    const { m, keyRing } = await setup({
      openServices: (ring, dbFile) => {
        if (first) {
          first = false
          throw new Error('open broke')
        }
        return deps().openServices(ring, dbFile)
      },
    })
    await expect(m.rejoin(keyRing, { password: secretBytes(OTHER) })).rejects.toThrow('open broke')
    keyRing.close()
    expect(await noteAfterUnlock(OTHER)).toBe('SECRET-NOTE')
  })

  it('review C4 M2: a failure opening the new services after the swap leaves no key of either ring in the module', async () => {
    const { m, keyRing } = await setup({
      openServices: () => {
        throw new Error('open broke')
      },
    })
    // The old ring's eight keys are live; after the failed rejoin and the caller's lock (index.ts
    // lockAfterFailedRejoin closes the old ring) nothing of the new ring may be left either.
    const withOldRing = liveHandles()
    await expect(m.rejoin(keyRing, { password: secretBytes(OTHER) })).rejects.toThrow('open broke')
    keyRing.close()
    expect(liveHandles()).toBe(withOldRing - 9) // the old ring: a header-v2 vault holds MK, LK and seven subkeys
  })

  it('review C4 M2: a failure writing preunlock.json after the switch still closes the old ring (the services hold the new one)', async () => {
    const { m, keyRing } = await setup()
    // A folder where preunlock.json goes makes its atomic write fail after the services took the new ring.
    rmSync(join(dataDir, PREUNLOCK_FILE), { force: true })
    mkdirSync(join(dataDir, PREUNLOCK_FILE))
    writeFileSync(join(dataDir, PREUNLOCK_FILE, 'x'), '')
    const withOldRing = liveHandles()
    await expect(m.rejoin(keyRing, { password: secretBytes(OTHER) })).rejects.toThrow()
    expect(keyRing.isOpen).toBe(false)
    const next = opened.at(-1)!.keyRing
    expect(next).not.toBe(keyRing)
    expect(next.isOpen).toBe(true)
    // Old ring gone, new ring live: the same count of keys as before, none of the old ones.
    expect(liveHandles()).toBe(withOldRing)
    closeOpened()
  })
})
