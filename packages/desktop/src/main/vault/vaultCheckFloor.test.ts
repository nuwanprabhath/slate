// Review C9 L2: a header of an older key epoch is refused however high its revision, and the remote restored.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nodeGitRunner } from '@slate/sync'
import { importKey } from '../../../test/vaultKeys'
import { secretBytes } from '../../shared/secret'
import { writeJsonAtomic } from './atomic'
import { changePassword, createVault, parseHeader, proveSecret, rekeyHeader, scheduleOf, type VaultHeader, type VaultHeaderV2 } from './header'
import { KeyRing } from './keyring'
import { destroyKey } from './native'
import { GitVaultRemote } from './remoteVault'
import { CANDIDATE_FILE, PENDING_FILE, VAULT_FILE } from './unlock'
import { writeSeen } from './seen'
import { checkRemoteVault, VaultSyncProblem } from './vaultCheck'

vi.setConfig({ testTimeout: 30_000 })
const weak = { allowWeakForTests: true }
const PW = 'correct horse battery'
let dir: string
let dataDir: string
let bare: string

const remote = (name = 'vr') => new GitVaultRemote({ run: nodeGitRunner(), dir: join(dir, name), remoteUrl: `file://${bare}`, branch: 'main', authEnv: async () => ({}) })
const problem = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e instanceof VaultSyncProblem ? e.problem : `other: ${String(e)}`))
const argon = () => ({ alg: 'argon2id' as const, memoryKiB: 64, passes: 1, parallelism: 1 as const, salt: Buffer.alloc(16, 5).toString('base64') })

async function rotated(base: VaultHeader, mk: Parameters<typeof rekeyHeader>[0]['mk']) {
  const proof = await proveSecret(base, { password: secretBytes(PW) }, weak)
  try {
    return await rekeyHeader({ kind: 'rotate', base, mk, proof, password: secretBytes(PW), kdf: argon(), profile: 'standard' }, weak)
  } finally {
    destroyKey(proof.kek)
  }
}

async function put(header: VaultHeader): Promise<void> {
  const r = remote('writer')
  expect(await r.writeHeader(header, (await r.read()).version)).toBe(true)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'slate-vault-epochs-'))
  bare = join(dir, 'remote.git')
  dataDir = join(dir, 'data')
  mkdirSync(dataDir)
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', bare])
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('review C9 L2: a key-epoch floor', () => {
  it('a header of an older epoch is refused and logged; written over only when its revision is not higher (review C9 M4)', async () => {
    const v = await createVault({ password: secretBytes(PW), kdf: { memoryKiB: 64, passes: 1 } }, weak)
    const r1 = await rotated(v.header, v.mk)
    await writeJsonAtomic(join(dataDir, VAULT_FILE), r1.header)
    const ring = new KeyRing(r1.mk, importKey(Buffer.alloc(32, 1), 'db'), scheduleOf(r1.header))
    await remote('a').claim(r1.header, null)
    // Someone holding the retired epoch-0 master key re-signs the old header at a higher revision.
    let replay: VaultHeader = v.header
    for (let i = 0; i < 2; i++) {
      const proof = await proveSecret(replay, { password: secretBytes(PW) }, weak)
      replay = await changePassword(replay, v.mk, proof, secretBytes(PW), weak)
      destroyKey(proof.kek)
    }
    expect(replay).toMatchObject({ keyEpoch: 0, revision: 3 })
    await put(replay)
    // A higher revision may be another device's password change made before it saw this rotation: sync stops and
    // asks; nothing is written over it.
    const err = await checkRemoteVault({ remote: remote(), dataDir, keyRing: ring, opts: weak }).catch((e: unknown) => e)
    expect(String(err)).toMatch(/Another device changed the vault/)
    expect(parseHeader((await remote().read()).header, weak)).toMatchObject({ keyEpoch: 0, revision: 3 })
    // Review C9 M5: written over only when the remote holds exactly the header this device last saw there (here: the
    // epoch-0 header it rotated from with sync off), never on a revision comparison.
    await put(v.header)
    await writeSeen(dataDir, v.header)
    const again = await checkRemoteVault({ remote: remote(), dataDir, keyRing: ring, opts: weak }).catch((e: unknown) => e)
    expect(String(again)).toMatch(/older or weaker/)
    expect(parseHeader((await remote().read()).header, weak)).toMatchObject({ keyEpoch: 1, revision: r1.header.revision })
    destroyKey(v.mk)
    ring.close()
  })
})
