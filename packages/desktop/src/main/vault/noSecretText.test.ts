import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CH } from '../../shared/ipc'
import { secretBytes } from '../../shared/secret'
import type { IpcRegistrar } from '../ipcGuard'
import { DocStore } from '../store'
import { registerVaultSecretIpc, type VaultSecretDeps } from '../vaultIpc'
import { readJsonCapped } from './atomic'
import { destroyProof, parseHeader, proveSecret, unlockWithPassword } from './header'
import type { KeyRing } from './keyring'
import { Migration } from './migration'
import { destroyKey } from './native'
import { checkPassword } from './password'
import { storeWithLk } from './testVault'
import { unlockVault, VAULT_FILE } from './unlock'
import { VaultBusy } from './busy'

/**
 * Z-5 (C7, review M2, re-review L): no main-process path a secret channel drives turns the typed password or
 * recovery key into text. A heap snapshot cannot show this (a short-lived string is collected first), so
 * this watches the conversions themselves while every secret channel runs on real vault steps: TextDecoder,
 * Buffer#toString and Buffer's internal slices, TypedArray#toString/join, and String.fromCharCode /
 * fromCodePoint (as one stream, so a character-by-character decode shows too). The one residual,
 * `checkPassword` (a password being set, for the policy), is excluded while it runs, and checked as the
 * control that the watch sees a decode.
 */
const inPolicyCheck = vi.hoisted(() => ({ depth: 0 }))
vi.mock('./password', async (importOriginal) => {
  const real = await importOriginal<typeof import('./password')>()
  return {
    ...real,
    checkPassword: (...a: Parameters<typeof real.checkPassword>) => {
      inPolicyCheck.depth++
      try {
        return real.checkPassword(...a)
      } finally {
        inPolicyCheck.depth--
      }
    },
  }
})

const weak = { allowWeakForTests: true }
const PASSWORD = 'secret channel password 7f3e'
const NEW_PASSWORD = 'a brand new password 91c2'

function contains(hay: ArrayLike<number>, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return true
  }
  return false
}

interface Watch {
  /** Byte sequences handed to a text conversion. */
  seen: Uint8Array[]
  /** Every code unit String.fromCharCode / fromCodePoint made, in order. */
  chars: number[]
}

/** Watches every byte-to-text conversion while `work` runs, outside the policy check. */
async function textConversions(work: () => Promise<unknown>, includePolicy = false): Promise<Watch> {
  const w: Watch = { seen: [], chars: [] }
  const watching = () => includePolicy || inPolicyCheck.depth === 0
  const copy = (v: unknown) => {
    if (!watching()) return
    if (ArrayBuffer.isView(v)) w.seen.push(new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)))
    else if (v instanceof ArrayBuffer) w.seen.push(new Uint8Array(v.slice(0)))
  }
  const wrap = <T extends object>(target: T, name: string, before: (self: unknown, args: unknown[]) => void) => {
    const original = (target as Record<string, unknown>)[name]
    if (typeof original !== 'function') return
    vi.spyOn(target as Record<string, (...a: unknown[]) => unknown>, name).mockImplementation(function (this: unknown, ...args: unknown[]) {
      before(this, args)
      return (original as (...a: unknown[]) => unknown).apply(this, args)
    })
  }
  wrap(TextDecoder.prototype, 'decode', (_self, [input]) => copy(input))
  wrap(Buffer.prototype, 'toString', (self) => copy(self))
  for (const slice of ['utf8Slice', 'latin1Slice', 'asciiSlice', 'ucs2Slice', 'hexSlice', 'base64Slice', 'base64urlSlice']) {
    wrap(Buffer.prototype, slice, (self, [start, end]) => copy((self as Buffer).subarray(Number(start ?? 0), end === undefined ? undefined : Number(end))))
  }
  const typedArrayProto = Object.getPrototypeOf(Uint8Array.prototype) as object
  for (const m of ['toString', 'join', 'toLocaleString']) wrap(typedArrayProto, m, (self) => copy(self))
  for (const m of ['fromCharCode', 'fromCodePoint']) {
    wrap(String, m, (_self, codes) => {
      if (watching()) for (const c of codes) w.chars.push(Number(c) & 0xff)
    })
  }
  try {
    await work()
  } finally {
    vi.restoreAllMocks()
  }
  return w
}

const leaks = (w: Watch, needles: Uint8Array[]) => needles.filter((n) => w.seen.some((s) => contains(s, n)) || contains(w.chars, n)).length

afterEach(() => vi.restoreAllMocks())

describe('no text is made from a typed secret on any secret channel (Z-5, review M2, re-review L)', () => {
  it('every secret channel, on real vault steps, never decodes the password or a recovery key', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'slate-notext-'))
    new DocStore(join(dataDir, 'slate.db')).close()
    mkdirSync(join(dataDir, 'tmp'))
    const migration = new Migration({
      dataDir,
      kdfOpts: weak,
      kdf: { argon2: { memoryKiB: 64, passes: 1 }, pbkdf2Iterations: 1000 },
      remote: () => null,
      closeServices: async () => {},
      reopenPlaintext: () => {},
      openServices: (keyRing, dbFile) => ({ store: storeWithLk(keyRing, dbFile) }),
      tempDir: join(dataDir, 'tmp'),
    })
    let state: ReturnType<VaultSecretDeps['state']> = 'plaintext'
    let ring: KeyRing | null = null
    const header = async () => parseHeader(await readJsonCapped(join(dataDir, VAULT_FILE)), weak)
    const handlers = new Map<string, (e: unknown, ...a: unknown[]) => Promise<unknown>>()
    const ipc = { handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => Promise<unknown>) => handlers.set(ch, fn), on: () => () => {} } as unknown as IpcRegistrar
    registerVaultSecretIpc(ipc, {
      state: () => state,
      busy: new VaultBusy(),
      unlock: async (secret) => {
        ring = (await unlockVault(dataDir, secret, weak)).keyRing
        return { ok: true }
      },
      enableQuickUnlock: async (password) => {
        destroyProof(await proveSecret(await header(), { password }, weak))
        return { ok: true }
      },
      checkPassword: (pw) => checkPassword(pw, []),
      prepare: (pw) => migration.prepare(pw),
      confirmRecovery: (key) => migration.confirmRecovery(key),
      // What resume and join do with the secret: open MK from a header.
      finishMigration: async (pw) => destroyKey(await unlockWithPassword(await header(), pw, weak)),
      join: async (secret) => destroyProof(await proveSecret(await header(), secret, weak)),
      changePassword: (current, next) => migration.changePassword(ring!, current, next),
      newRecoveryKey: (pw) => migration.newRecoveryKey(ring!, pw),
      prepareRekey: async (kind, pw, next) => (await migration.prepareRekey(ring!, kind, pw, next)).recoveryKey,
    })
    const send = (ch: string, ...args: unknown[]) => handlers.get(ch)!({}, ...args)

    let firstKey = ''
    let newKey = ''
    let rotatedKey = ''
    const results: unknown[] = []
    const w = await textConversions(async () => {
      results.push(await send(CH.vaultCheckPassword, secretBytes(PASSWORD)))
      const prepared = (await send(CH.vaultPrepare, secretBytes(PASSWORD))) as { kind: string; recoveryKey: string }
      firstKey = prepared.recoveryKey
      results.push(await send(CH.vaultConfirmRecovery, secretBytes(firstKey)))
      results.push(await migration.run())
      state = 'locked'
      results.push(await send(CH.vaultUnlock, secretBytes(PASSWORD)))
      ring!.close()
      results.push(await send(CH.vaultUnlockRecovery, secretBytes(firstKey)))
      state = 'unlocked'
      results.push(await send(CH.vaultQuickUnlockEnable, secretBytes(PASSWORD)))
      results.push(await send(CH.vaultJoin, { password: secretBytes(PASSWORD) }))
      results.push(await send(CH.vaultJoin, { recoveryKey: secretBytes(firstKey) }))
      const made = (await send(CH.vaultNewRecovery, secretBytes(PASSWORD))) as { ok: boolean; recoveryKey: string }
      newKey = made.recoveryKey
      results.push(made.ok)
      results.push(await send(CH.vaultChangePassword, { recoveryKey: secretBytes(newKey) }, secretBytes(NEW_PASSWORD)))
      // C9: a key rotation takes the password and gives a new recovery key, typed back before it counts.
      const rekeyed = (await send(CH.vaultRekeyPrepare, 'rotate', secretBytes(NEW_PASSWORD))) as { ok: boolean; recoveryKey: string }
      rotatedKey = rekeyed.recoveryKey
      results.push(rekeyed.ok)
      results.push(await send(CH.vaultConfirmRecovery, secretBytes(rotatedKey)))
      ring = await migration.runRekey(ring!)
      state = 'migrating'
      results.push(await send(CH.vaultFinishMigration, secretBytes(NEW_PASSWORD)))
    })
    ring!.close()
    expect(results).toEqual([{ ok: true, strength: expect.any(Number) }, true, { kind: 'done' }, { ok: true }, { ok: true }, { ok: true }, { ok: true }, { ok: true }, true, { ok: true }, true, true, { ok: true }])
    const needles = [PASSWORD, NEW_PASSWORD, firstKey, firstKey.replace(/-/g, ''), newKey, newKey.replace(/-/g, ''), rotatedKey, rotatedKey.replace(/-/g, '')].map(secretBytes)
    expect(leaks(w, needles)).toBe(0)
  }, 60_000)

  it('the watch sees every form of decode (controls: the policy check, and planted decodes)', async () => {
    const pw = secretBytes(PASSWORD)
    const watched = async (f: () => unknown) => leaks(await textConversions(async () => f()), [pw])
    expect(leaks(await textConversions(async () => checkPassword(pw, []), true), [pw])).toBe(1)
    expect(await watched(() => checkPassword(pw, []))).toBe(0)
    expect(await watched(() => new TextDecoder().decode(pw))).toBe(1)
    expect(await watched(() => Array.from(pw, (b) => String.fromCharCode(b)).join(''))).toBe(1)
    expect(await watched(() => String.fromCodePoint(...pw))).toBe(1)
    expect(await watched(() => pw.toString())).toBe(1)
    expect(await watched(() => Buffer.from(pw).toString('latin1'))).toBe(1)
    expect(await watched(() => (Buffer.from(pw) as unknown as { latin1Slice(s: number, e: number): string }).latin1Slice(0, pw.length))).toBe(1)
  })
})
