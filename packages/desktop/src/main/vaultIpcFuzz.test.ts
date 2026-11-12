import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { CH } from '../shared/ipc'
import { secretBytes } from '../shared/secret'
import { createIpc, SECRET_CHANNELS, type Handler, type RawIpc } from './ipcGuard'
import { VaultBusy } from './vault/busy'
import { registerVaultSecretIpc, type VaultSecretDeps } from './vaultIpc'
import { registerUpdateIpc } from './update/ipc'
import type { UpdateService } from './update/updateService'
import { fcParams, fuzzTimeout } from '../../test/fuzz'

// F4a property 6: on every channel in SECRET_CHANNELS, every Uint8Array the renderer sent is all zero
// once the call settles, whether the handler resolved, refused or threw, and in any vault state.
// Set up as vaultIpc.test.ts sets up createIpc; the arguments here are arbitrary, not well formed.

type State = ReturnType<VaultSecretDeps['state']>
const STATES: State[] = ['locked', 'unlocked', 'plaintext', 'migrating', 'locking']
const APP = 'app://slate/'

function setup(state: State, fail: boolean, open: boolean) {
  const handlers = new Map<string, Handler>()
  const raw: RawIpc = { handle: (ch: string, fn: Handler) => void handlers.set(ch, fn), on: () => undefined, removeListener: () => undefined }
  const ipc = createIpc(() => open, () => false, raw, (url) => url === APP, () => true, async () => {})
  const step = async <T>(value: T): Promise<T> => {
    if (fail) throw new Error('the vault step failed')
    return value
  }
  const deps: VaultSecretDeps = {
    state: () => state,
    busy: new VaultBusy(),
    unlock: () => step({ ok: true }),
    enableQuickUnlock: () => step({ ok: true }),
    checkPassword: () => {
      if (fail) throw new Error('the vault step failed')
      return { ok: true, strength: 3 }
    },
    prepare: () => step({ kind: 'recovery' as const, recoveryKey: secretBytes('X') }),
    confirmRecovery: () => step(true),
    finishMigration: () => step(undefined),
    join: () => step(undefined),
    changePassword: () => step(undefined),
    newRecoveryKey: () => step(secretBytes('NEW-KEY')),
    prepareRekey: () => step(secretBytes('REKEY-KEY')),
  }
  registerVaultSecretIpc(ipc, deps)
  // The one secret channel that is not the vault's: sudo's password for Install and restart.
  registerUpdateIpc(ipc, { installAndRestart: () => step({ ok: true }) } as unknown as UpdateService)
  return handlers
}

const CHANNELS = Object.keys(SECRET_CHANNELS).map((k) => CH[k as keyof typeof CH])

/** Non-zero bytes, so a byte left unzeroed shows. */
const bytes = fc.integer({ min: 1, max: 5000 }).map((n) => new Uint8Array(n).fill(7))
const arg: fc.Arbitrary<unknown> = fc.oneof(
  bytes,
  fc.record({ password: bytes }),
  fc.record({ recoveryKey: bytes }),
  fc.record({ password: bytes, recoveryKey: bytes }),
  fc.constantFrom('rotate', 'convert', null, 5, 'x'),
  fc.anything({ maxDepth: 1 }),
)

const call = fc.record({
  channel: fc.constantFrom(...CHANNELS),
  args: fc.array(arg, { maxLength: 4 }),
  state: fc.constantFrom(...STATES),
  fail: fc.boolean(),
  open: fc.boolean(),
  trusted: fc.boolean(),
})

/** The bytes `secretsIn` is documented to zero: top level and inside a VaultSecret. */
function sentBytes(args: unknown[]): Uint8Array[] {
  const out: Uint8Array[] = []
  for (const a of args) {
    if (a instanceof Uint8Array) out.push(a)
    else if (typeof a === 'object' && a !== null)
      for (const k of ['password', 'recoveryKey']) {
        const x = (a as Record<string, unknown>)[k]
        if (x instanceof Uint8Array) out.push(x)
      }
  }
  return out
}

describe('F4a: secret channels zero what they receive, on any arguments', () => {
  it('T-F4A-50: SECRET_CHANNELS are all registered', () => {
    const handlers = setup('locked', false, true)
    for (const c of CHANNELS) expect([...handlers.keys()], c).toContain(c)
  })

  it(
    'T-F4A-51: every Uint8Array sent is all zero after the call settles',
    async () => {
      await fc.assert(
        fc.asyncProperty(call, async ({ channel, args, state, fail, open, trusted }) => {
          const handlers = setup(state, fail, open)
          const event = { senderFrame: { url: trusted ? APP : 'https://evil.example/', parent: null }, sender: {} }
          await Promise.resolve()
            .then(() => handlers.get(channel)!(event as never, ...args))
            .catch(() => {})
          for (const b of sentBytes(args)) expect(b.every((x) => x === 0), `${channel} ${state}`).toBe(true)
        }),
        { ...fcParams, numRuns: Math.max(300, Math.floor(fcParams.numRuns / 4)) },
      )
    },
    fuzzTimeout(),
  )
})
