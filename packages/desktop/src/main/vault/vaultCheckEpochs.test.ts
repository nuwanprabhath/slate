// Review C9 L1 and L2: what the sync check does with a remote header this device cannot verify. A newer-keys header is
// only a candidate (never the pending header, which only a verified header becomes), replaced whenever the remote's
// changes; a header of an older key epoch is refused however high its revision, and the remote restored.
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

describe('review C9 L1: an unverified newer-keys header is a candidate, never the pending header', () => {
  it('a planted header with a huge revision is replaced by the next one the remote holds', async () => {
    const v = await createVault({ password: secretBytes(PW), kdf: { memoryKiB: 64, passes: 1 } }, weak)
    await writeJsonAtomic(join(dataDir, VAULT_FILE), v.header)
    const ring = new KeyRing(v.mk, importKey(Buffer.alloc(32, 1), 'db'), scheduleOf(v.header))
    await remote('a').claim(v.header, null)
    // Planted: this vault's id, a later epoch, a revision near 2^53, and a check nobody can make.
    const planted = { ...(v.header as VaultHeaderV2), keyEpoch: 1, revision: Number.MAX_SAFE_INTEGER - 1 }
    await put(planted)
    expect(await problem(checkRemoteVault({ remote: remote(), dataDir, keyRing: ring, opts: weak }))).toBe('keys-changed')
    expect(existsSync(join(dataDir, PENDING_FILE))).toBe(false)
    expect(parseHeader(JSON.parse(readFileSync(join(dataDir, CANDIDATE_FILE), 'utf8')), weak).revision).toBe(planted.revision)
    // The real rotation reaches the remote later, at a lower revision: it replaces the candidate.
    const real = await rotated(v.header, ring.get('mk'))
    await put(real.header)
    expect(await problem(checkRemoteVault({ remote: remote(), dataDir, keyRing: ring, opts: weak }))).toBe('keys-changed')
    expect(parseHeader(JSON.parse(readFileSync(join(dataDir, CANDIDATE_FILE), 'utf8')), weak).revision).toBe(real.header.revision)
    destroyKey(real.mk)
    ring.close()
  })
})
