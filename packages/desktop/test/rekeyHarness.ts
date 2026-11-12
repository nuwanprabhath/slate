// The shared world of the C9 key-change tests (rekey*.test.ts in src/main/vault): a wizard-encrypted note, a
// migration runner on cheap KDF parameters, and a git remote, one set per test.
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc } from 'loro-crdt'
import { nodeGitRunner } from '@slate/sync'
import { writeSettings } from '../src/main/settings'
import { DocStore } from '../src/main/store'
import { secretBytes } from '../src/shared/secret'
import { parseHeader } from '../src/main/vault/header'
import type { KeyRing } from '../src/main/vault/keyring'
import { Migration, type MigrationDeps } from '../src/main/vault/migration'
import { GitVaultRemote, type VaultRemote } from '../src/main/vault/remoteVault'
import { SUITE } from '../src/main/vault/suite'
import { storeWithLk } from '../src/main/vault/testVault'
import { unlockVault, VAULT_FILE } from '../src/main/vault/unlock'

export const weak = { allowWeakForTests: true }
export const PASSWORD = 'correct horse battery staple'
export const PAGE = `page:${randomUUID()}`
export let dir: string
export let dataDir: string
export let bare: string
export let opened: Array<{ keyRing: KeyRing; dbFile: string; store: DocStore }>

export function gitRemote(name = 'vr'): GitVaultRemote {
  return new GitVaultRemote({ run: nodeGitRunner(), dir: join(dir, name), remoteUrl: `file://${bare}`, branch: 'main', authEnv: async () => ({}) })
}

export function deps(over: Partial<MigrationDeps> = {}, folder = dataDir): MigrationDeps {
  return {
    dataDir: folder,
    kdfOpts: weak,
    kdf: { argon2: { memoryKiB: 64, passes: 1 }, pbkdf2Iterations: 1000 },
    remote: () => null,
    closeServices: async () => {},
    reopenPlaintext: () => {},
    openServices: (keyRing, dbFile) => {
      const store = storeWithLk(keyRing, dbFile)
      opened.push({ keyRing, dbFile, store })
      return { store }
    },
    tempDir: join(dir, 'tmp'),
    ...over,
  }
}

export function closeOpened(): void {
  for (const o of opened.splice(0)) {
    o.store.close()
    if (o.keyRing.isOpen) o.keyRing.close()
  }
}

/** A plaintext note encrypted by the wizard (§7.1); the open ring and its store, as the services hold them. */
export async function encrypted(remote: VaultRemote | null = null, over: Partial<MigrationDeps> = {}): Promise<KeyRing> {
  mkdirSync(dataDir, { recursive: true })
  const store = new DocStore(join(dataDir, 'slate.db'))
  const doc = new LoroDoc()
  doc.getText('t').insert(0, 'SECRET-NOTE')
  store.append(PAGE, doc.export({ mode: 'update' }))
  writeSettings(store, { deviceId: randomUUID() })
  store.close()
  const m = new Migration(deps({ remote: () => remote, ...over }))
  const p = await m.prepare(secretBytes(PASSWORD))
  if (p.kind !== 'recovery') throw new Error('expected a new vault')
  expect(await m.confirmRecovery(p.recoveryKey)).toBe(true)
  await m.run()
  const first = opened.splice(0)[0]!
  first.store.close()
  return first.keyRing
}

export async function rotate(m: Migration, ring: KeyRing, kind: 'rotate' | 'upgrade' = 'rotate'): Promise<KeyRing> {
  const { recoveryKey } = await m.prepareRekey(ring, kind, secretBytes(PASSWORD))
  expect(await m.confirmRecovery(recoveryKey)).toBe(true)
  const next = await m.runRekey(ring)
  opened.splice(0).forEach((o) => o.store.close())
  return next
}

/** The note as the unlocked vault stores it, opened the way unlock opens it. */
export async function noteAfterUnlock(folder = dataDir, password = PASSWORD): Promise<{ text: string; epoch: number }> {
  const { keyRing, dbFile } = await unlockVault(folder, { password: secretBytes(password) }, weak)
  const store = storeWithLk(keyRing, dbFile)
  try {
    const doc = new LoroDoc()
    doc.importBatch(store.load(PAGE))
    return { text: doc.getText('t').toString(), epoch: keyRing.schedule.suite === SUITE.KBKDF_AES256GCM ? keyRing.schedule.keyEpoch : 0 }
  } finally {
    store.close()
    keyRing.close()
  }
}

/** A gate PQ-B4 keeps shut: sync off on a vault that has synced, so its devices cannot be asked (INV-PQ-5). */
export const CLOSED_GATE: Partial<MigrationDeps> = { syncedBefore: async () => true }
/** Device records of builds that read header v3 (PQ-B2) and follow key changes (C9). */
export const PQ_DEVICES = [{ name: 'Laptop', appVersion: '0.4.0', epochs: 1, pq: 1 }]
/** One device of 0.3.x: it follows key changes but would call header v3 damaged. */
export const OLD_DEVICES = [{ name: 'Laptop', appVersion: '0.4.0', epochs: 1, pq: 1 }, { name: 'Desktop', appVersion: '0.3.0', epochs: 1 }]

/** `remote`, counting its header writes (a claim, or a compare-and-swap of `e2ee/vault.json`). */
export function counted(remote: VaultRemote): { remote: VaultRemote; writes: () => number } {
  let writes = 0
  return {
    remote: {
      read: () => remote.read(),
      claim: (h, v) => (writes++, remote.claim(h, v)),
      writeHeader: (h, v) => (writes++, remote.writeHeader(h, v)),
    },
    writes: () => writes,
  }
}

export const header = (folder = dataDir) => parseHeader(JSON.parse(readFileSync(join(folder, VAULT_FILE), 'utf8')), weak)
export const remoteHeader = async (remote: VaultRemote) => parseHeader((await remote.read()).header, weak)
export const databases = (folder = dataDir) => readdirSync(folder).filter((f) => /^slate-[0-9a-f]{8}\.db$/.test(f))

/** `bare` is a fresh bare repository per test; a test that needs another one points it here. */
export function setBare(path: string): void {
  bare = path
}

/** A temp folder, a data folder and a bare git remote per test, and the services a test opened closed after it. */
export function useRekeyHarness(): void {
  // One key-change scenario: a wizard-encrypted vault, a rotation over a local bare git remote, and a crash-survival
  // check. Measured over four full `npm run test:main` runs at load average 10-25, the slowest single-scenario case here
  // cost 17.4 s and the same case varied by 2.1x between a quiet and a busy run, so the old 30 s left only 1.7x and timed
  // cases out mid-list on a busy Mac. 45 s is 2.6x the measured worst case. A case that runs several scenarios in one
  // `it` is not covered by this and declares its own budget per scenario.
  vi.setConfig({ testTimeout: 45_000 })
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slate-rekey-'))
    dataDir = join(dir, 'data')
    bare = join(dir, 'remote.git')
    execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', bare])
    opened = []
  })

  afterEach(() => {
    closeOpened()
    rmSync(dir, { recursive: true, force: true })
  })
}
