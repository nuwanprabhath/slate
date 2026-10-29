// Tests only (vault/pqUpgrade*.test.ts): a small encrypted device for the v2 → v3 upgrade, and an
// in-memory remote header with OneDrive's eTag compare-and-swap. No production path imports it.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { newId } from '@slate/core'
import { LoroDoc } from 'loro-crdt'
import { secretBytes } from '../src/shared/secret'
import { writeSettings } from '../src/main/settings'
import { DocStore } from '../src/main/store'
import type { VaultHeader } from '../src/main/vault/header'
import type { WeakKdfOption } from '../src/main/vault/kdf'
import type { KeyRing } from '../src/main/vault/keyring'
import { destroyKey, toHex, vaultNative } from '../src/main/vault/native'
import type { ProfileId } from '../src/main/vault/profile'
import type { RemoteSnapshot, VaultRemote } from '../src/main/vault/remoteVault'
import { createEncryptedDataDir } from '../src/main/vault/testVault'
import { unlockVault } from '../src/main/vault/unlock'

export const TEST_PASSWORD = 'a pq upgrade test password'
export const weak: WeakKdfOption = { allowWeakForTests: true }
const IMAGE = Buffer.from('not really a png')
/** The image every test device holds: named by its SHA-256, as `FileBlobStore` names them. */
export const blobName = (): string => `${toHex(vaultNative().sha256(IMAGE))}.png`

export interface TestDevice {
  dir: string
  recoveryKey: string
  header: VaultHeader
  notes: number
  ring: KeyRing
}

/** A plaintext folder with `notes` pages and one image, encrypted as header v2 and unlocked with the password. */
export async function testDevice(root: string, notes = 3, profile: ProfileId = 'standard', password = TEST_PASSWORD): Promise<TestDevice> {
  const dir = mkdtempSync(join(root, 'dev-'))
  const plain = new DocStore(join(dir, 'slate.db'))
  for (let i = 0; i < notes; i++) {
    const doc = new LoroDoc()
    doc.getText('t').insert(0, `PQ-NOTE-${i}`)
    plain.append(`page:${newId()}`, doc.export({ mode: 'update' }))
  }
  writeSettings(plain, { deviceId: newId() })
  plain.close()
  mkdirSync(join(dir, 'blobs'), { recursive: true })
  writeFileSync(join(dir, 'blobs', blobName()), IMAGE)
  const made = await createEncryptedDataDir(dir, secretBytes(password), weak, profile)
  destroyKey(made.mk)
  const u = await unlockVault(dir, { password: secretBytes(password) }, weak)
  return { dir, recoveryKey: made.recoveryKey, header: made.header, notes, ring: u.keyRing }
}

/** Every file under `dir` (relative path → bytes as base64), except the names in `skip`. */
export function snapshot(dir: string, skip: readonly string[] = []): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (!skip.includes(relative(dir, p))) out[relative(dir, p)] = readFileSync(p).toString('base64')
    }
  }
  walk(dir)
  return out
}

/** OneDrive's semantics for `e2ee/vault.json`: a version (eTag) per write, and a write refused unless it still matches. */
export function memoryRemote(): { remote: VaultRemote; writes: () => number; set(header: unknown): void } {
  let header: unknown = null
  let version = 0
  let writes = 0
  const current = (): string | null => (header === null ? null : `etag-${version}`)
  const write = async (h: VaultHeader, v: string | null): Promise<boolean> => {
    // Another device's write can land between this one's read and write.
    await new Promise((r) => setTimeout(r, 1))
    if (v !== current()) return false
    header = structuredClone(h) as unknown
    version++
    writes++
    return true
  }
  const remote: VaultRemote = {
    read: async (): Promise<RemoteSnapshot> => ({ header: header === null ? null : (structuredClone(header) as unknown), version: current(), otherFiles: [] }),
    claim: (h, v) => write(h, v),
    writeHeader: (h, v) => write(h, v),
  }
  return {
    remote,
    writes: () => writes,
    set: (h) => {
      header = structuredClone(h) as unknown
      version++
    },
  }
}

export const tempRoot = (tag: string): string => mkdtempSync(join(tmpdir(), `slate-pq-${tag}-`))
