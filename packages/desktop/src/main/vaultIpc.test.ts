import { describe, expect, it } from 'vitest'
import { CH } from '../shared/ipc'
import { createIpc, type Handler, type RawIpc } from './ipcGuard'
import { VaultBusy } from './vault/busy'
import { registerVaultSecretIpc, secretsIn, type VaultSecretDeps } from './vaultIpc'

/**
 * Z-5 (C7, review M1/M2): every secret main receives is zeroed once its handler settles, on every exit. Each
 * case calls the real handler with fresh non-zero bytes and checks every byte is 0 afterwards, so removing
 * the zeroing (or adding a path around it) fails here.
 */
type State = ReturnType<VaultSecretDeps['state']>
type Outcome = 'success' | 'wrong state' | 'busy' | 'invalid bytes' | 'throws' | 'locked' | 'untrusted sender'

const secret = (n = 24) => new Uint8Array(n).fill(7)

/** Each secret channel, the arguments it takes, and the state it needs to succeed. */
const CHANNELS: Array<{ channel: string; args: (bytes: () => Uint8Array) => unknown[]; state: State }> = [
  { channel: CH.vaultUnlock, args: (b) => [b()], state: 'locked' },
  { channel: CH.vaultUnlockRecovery, args: (b) => [b()], state: 'locked' },
  { channel: CH.vaultQuickUnlockEnable, args: (b) => [b()], state: 'unlocked' },
  { channel: CH.vaultCheckPassword, args: (b) => [b()], state: 'plaintext' },
  { channel: CH.vaultPrepare, args: (b) => [b()], state: 'plaintext' },
  { channel: CH.vaultConfirmRecovery, args: (b) => [b()], state: 'plaintext' },
  { channel: CH.vaultFinishMigration, args: (b) => [b()], state: 'migrating' },
  { channel: CH.vaultJoin, args: (b) => [{ password: b() }], state: 'plaintext' },
  { channel: CH.vaultJoin, args: (b) => [{ recoveryKey: b() }], state: 'unlocked' },
  { channel: CH.vaultChangePassword, args: (b) => [{ recoveryKey: b() }, b()], state: 'unlocked' },
  { channel: CH.vaultNewRecovery, args: (b) => [b()], state: 'unlocked' },
  { channel: CH.vaultRekeyPrepare, args: (b) => ['rotate', b()], state: 'unlocked' },
  { channel: CH.vaultRekeyPrepare, args: (b) => ['convert', b(), b()], state: 'unlocked' },
]

const APP = 'app://slate/'
/** An invoke from Slate's own page, or from a frame that is not Slate (refused by the C8 sender check). */
const event = (trusted: boolean) => ({ senderFrame: { url: trusted ? APP : 'https://evil.example/', parent: null }, sender: {} })

/** The handlers as Electron sees them: behind the real createIpc (sender check, vault gate, logging). */
function setup(state: State, fail: boolean, open = true) {
  const handlers = new Map<string, Handler>()
  const raw: RawIpc = { handle: (ch: string, fn: Handler) => void handlers.set(ch, fn), on: () => undefined, removeListener: () => undefined }
  const ipc = createIpc(() => open, () => false, raw, (url) => url === APP, () => true, async () => {})
  const busy = new VaultBusy()
  const seen: Uint8Array[] = []
  const step = async <T>(value: T, ...got: Uint8Array[]): Promise<T> => {
    // What the vault step is given is still the page's secret: zeroing happens after, not before.
    for (const g of got) seen.push(new Uint8Array(g))
    if (fail) throw new Error('the vault step failed')
    return value
  }
  const deps: VaultSecretDeps = {
    state: () => state,
    busy,
    unlock: (s) => step({ ok: true }, 'password' in s ? s.password : s.recoveryKey),
    enableQuickUnlock: (pw) => step({ ok: true }, pw),
    checkPassword: (pw) => {
      seen.push(new Uint8Array(pw))
      if (fail) throw new Error('the vault step failed')
      return { ok: true, strength: 3 }
    },
    prepare: (pw) => step({ kind: 'recovery' as const, recoveryKey: 'X' }, pw),
    confirmRecovery: (k) => step(true, k),
    finishMigration: (pw) => step(undefined, pw),
    join: (s) => step(undefined, 'password' in s ? s.password : s.recoveryKey),
    changePassword: (c, n) => step(undefined, 'password' in c ? c.password : c.recoveryKey, n),
    newRecoveryKey: (pw) => step('NEW-KEY', pw),
    prepareRekey: (_kind, pw, next) => step('REKEY-KEY', pw, ...(next ? [next] : [])),
  }
  registerVaultSecretIpc(ipc, deps)
  return { handlers, busy, seen }
}

async function call(outcome: Outcome, c: (typeof CHANNELS)[number]): Promise<{ args: unknown[]; seen: Uint8Array[] }> {
  const { handlers, busy, seen } = setup(outcome === 'wrong state' ? 'locking' : c.state, outcome === 'throws', outcome !== 'locked')
  const args = c.args(() => (outcome === 'invalid bytes' ? secret(4097) : secret()))
  let release = () => {}
  const holding = outcome === 'busy' ? busy.run(() => new Promise<void>((r) => (release = r))) : null
  try {
    await Promise.resolve(handlers.get(c.channel)!(event(outcome !== 'untrusted sender') as never, ...args)).catch(() => {})
  } finally {
    release()
    await holding
  }
  return { args, seen }
}

describe('vault secret channels zero what they receive (Z-5, C7)', () => {
  it('registers a handler for every secret channel', () => {
    expect([...setup('locked', false).handlers.keys()].sort()).toEqual([...new Set(CHANNELS.map((c) => c.channel))].sort())
  })

  // 'locked': the vault gate refuses (ipcGuard `Locked`); 'untrusted sender': the C8 sender check refuses.
  // Both happen before any vault handler runs, so createIpc zeroes the secret channels' arguments itself.
  for (const outcome of ['success', 'wrong state', 'busy', 'invalid bytes', 'throws', 'locked', 'untrusted sender'] as const) {
    it(`every secret is all zeros after the handler settles: ${outcome}`, async () => {
      const left: string[] = []
      for (const c of CHANNELS) {
        const { args } = await call(outcome, c)
        const secrets = secretsIn(args)
        expect(secrets.length, c.channel).toBeGreaterThan(0)
        if (secrets.some((s) => s.some((b) => b !== 0))) left.push(c.channel)
      }
      expect(left).toEqual([])
    })
  }

  it('a successful call hands the vault step the secret itself, zeroed only afterwards', async () => {
    for (const c of CHANNELS) {
      const { seen } = await call('success', c)
      expect(seen.length, c.channel).toBeGreaterThan(0)
      for (const s of seen) expect(s.every((b) => b === 7), c.channel).toBe(true)
    }
  })

  it('secretsIn finds bytes at the top level and inside a VaultSecret, nothing else', () => {
    const a = secret()
    const b = secret()
    expect(secretsIn([a, { recoveryKey: b }, 'text', null, { other: secret() }])).toEqual([a, b])
  })
})
