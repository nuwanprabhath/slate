// The vault channels that receive a typed secret (Z-5, audit §4.3; C7). Each is registered through
// `secretHandler`, which zeroes every secret argument main received when the call settles, on every exit:
// success, a refusal for the vault's state, a busy vault, bytes `passwordBytes` refuses, or a throw.
// `tools/guards/vaultSecrets.test.ts` holds every secret-taking VaultApi channel to this file and this
// wrapper. Nothing here turns a secret into a string (T-STATIC-01, slate/secret-bytes-stay-bytes).
import type { PasswordCheck, PrepareEncryption, RekeyKind, UnlockResult, VaultSecret } from '../shared/api'
import { CH } from '../shared/ipc'
import { passwordBytes, secretsIn, zeroSecret, type SecretBytes } from '../shared/secret'

export { secretsIn }
import type { IpcRegistrar } from './ipcGuard'
import { BUSY_MESSAGE, type VaultBusy } from './vault/busy'
import { UNLOCK_FAILED_MESSAGE } from './vault/unlock'
import type { VaultStateMachine } from './vault/vaultState'
import { isProfileId, type ProfileId } from './vault/profile'

/**
 * The one way main takes an invoke that carries a secret: `fn` gets the page's arguments, and every secret
 * among them is zeroed when `fn` settles, however it settles (Z-5: the owner zeroes its copy). Main's copy
 * is the structured clone Electron made; the IPC message buffer it came in cannot be reached from
 * JavaScript (Z-11 residual, poam.md POAM-10).
 */
export function secretHandler<R>(fn: (...args: unknown[]) => R | Promise<R>): (event: unknown, ...args: unknown[]) => Promise<R> {
  return async (_event, ...args) => {
    try {
      return await fn(...args)
    } finally {
      zeroSecret(...secretsIn(args))
    }
  }
}

/** A password or recovery key as bytes of an accepted size, or null for any other shape. */
export function secretOf(s: unknown): VaultSecret | null {
  const v = (typeof s === 'object' && s !== null ? s : {}) as Record<string, unknown>
  const recoveryKey = passwordBytes(v.recoveryKey)
  if (recoveryKey) return { recoveryKey }
  const password = passwordBytes(v.password)
  return password ? { password } : null
}

/** What the secret channels do once the bytes are checked; index.ts supplies the vault's own steps. */
export interface VaultSecretDeps {
  state(): VaultStateMachine['state']
  busy: Pick<VaultBusy, 'running' | 'run'>
  unlock(secret: VaultSecret): Promise<UnlockResult>
  enableQuickUnlock(password: SecretBytes): Promise<UnlockResult>
  /** `profile` (C5): the profile a password is being set for; the vault's own when undefined. */
  checkPassword(password: SecretBytes, profile: ProfileId | undefined): PasswordCheck | Promise<PasswordCheck>
  prepare(password: SecretBytes, profile: ProfileId): Promise<PrepareEncryption>
  confirmRecovery(recoveryKey: SecretBytes): Promise<boolean>
  /** Runs the migration (it holds `busy` itself). */
  finishMigration(password: SecretBytes): Promise<void>
  /** Joins or rejoins (holding `busy` itself). */
  join(secret: VaultSecret): Promise<void>
  changePassword(current: VaultSecret, next: SecretBytes): Promise<void>
  newRecoveryKey(password: SecretBytes): Promise<string>
  /** C9: the new header in memory, its recovery key returned (holding `busy` itself). */
  prepareRekey(kind: RekeyKind, password: SecretBytes, newPassword: SecretBytes | undefined): Promise<string>
}

const REKEY_KINDS: ReadonlySet<unknown> = new Set<RekeyKind>(['rotate', 'upgrade', 'convert'])

const failed = (): UnlockResult => ({ ok: false, message: UNLOCK_FAILED_MESSAGE })
const failure = (e: unknown): UnlockResult => ({ ok: false, message: e instanceof Error ? e.message : String(e) })
const TOO_SHORT = 'Use at least 10 characters.'

export function registerVaultSecretIpc(ipc: IpcRegistrar, d: VaultSecretDeps): void {
  ipc.handle(
    CH.vaultUnlock,
    secretHandler(async (arg) => {
      const password = passwordBytes(arg)
      return password ? d.unlock({ password }) : failed()
    }),
  )
  ipc.handle(
    CH.vaultUnlockRecovery,
    secretHandler(async (arg) => {
      const recoveryKey = passwordBytes(arg)
      return recoveryKey ? d.unlock({ recoveryKey }) : failed()
    }),
  )
  ipc.handle(
    CH.vaultQuickUnlockEnable,
    secretHandler(async (arg) => {
      const password = passwordBytes(arg)
      return d.state() === 'unlocked' && password ? d.enableQuickUnlock(password) : failed()
    }),
  )
  // C7 criterion 5: checkPassword is where a password being set becomes text, for the policy only.
  ipc.handle(
    CH.vaultCheckPassword,
    secretHandler((arg, profile) => d.checkPassword(passwordBytes(arg) ?? new Uint8Array(0), isProfileId(profile) ? profile : undefined)),
  )
  ipc.handle(
    CH.vaultPrepare,
    secretHandler(async (arg, profile) => {
      // §7.1: refused while another vault change runs, as VaultBusy.guard did.
      if (d.busy.running) throw new Error(BUSY_MESSAGE)
      if (d.state() !== 'plaintext') throw new Error('Your notes are already encrypted')
      const pw = passwordBytes(arg)
      if (!pw) throw new Error(TOO_SHORT)
      return d.prepare(pw, isProfileId(profile) ? profile : 'standard')
    }),
  )
  ipc.handle(
    CH.vaultConfirmRecovery,
    secretHandler(async (arg) => {
      if (d.busy.running) throw new Error(BUSY_MESSAGE)
      const key = passwordBytes(arg)
      return key ? d.confirmRecovery(key) : false
    }),
  )
  ipc.handle(
    CH.vaultFinishMigration,
    secretHandler(async (arg): Promise<UnlockResult> => {
      if (d.state() !== 'migrating') return { ok: false, message: 'There is no unfinished encryption' }
      const pw = passwordBytes(arg)
      if (!pw) return failed()
      try {
        await d.finishMigration(pw)
        return { ok: true }
      } catch (e) {
        return failure(e)
      }
    }),
  )
  ipc.handle(
    CH.vaultJoin,
    secretHandler(async (arg): Promise<UnlockResult> => {
      const secret = secretOf(arg)
      if (!secret) return failed()
      try {
        await d.join(secret)
        return { ok: true }
      } catch (e) {
        return failure(e)
      }
    }),
  )
  ipc.handle(
    CH.vaultChangePassword,
    secretHandler(async (currentArg, nextArg): Promise<UnlockResult> => {
      const current = secretOf(currentArg)
      const next = passwordBytes(nextArg)
      if (!current) return failed()
      if (!next) return { ok: false, message: TOO_SHORT }
      try {
        await d.busy.run(() => d.changePassword(current, next))
        return { ok: true }
      } catch (e) {
        return failure(e)
      }
    }),
  )
  ipc.handle(
    CH.vaultRekeyPrepare,
    secretHandler(async (kind, arg, nextArg): Promise<{ ok: true; recoveryKey: string } | { ok: false; message: string }> => {
      const pw = passwordBytes(arg)
      if (!pw || !REKEY_KINDS.has(kind)) return failed() as { ok: false; message: string }
      const next = nextArg === undefined ? undefined : passwordBytes(nextArg)
      if (nextArg !== undefined && !next) return { ok: false, message: TOO_SHORT }
      try {
        return { ok: true, recoveryKey: await d.prepareRekey(kind as RekeyKind, pw, next ?? undefined) }
      } catch (e) {
        return failure(e) as { ok: false; message: string }
      }
    }),
  )
  ipc.handle(
    CH.vaultNewRecovery,
    secretHandler(async (arg): Promise<{ ok: true; recoveryKey: string } | { ok: false; message: string }> => {
      const pw = passwordBytes(arg)
      if (!pw) return failed() as { ok: false; message: string }
      try {
        return { ok: true, recoveryKey: await d.busy.run(() => d.newRecoveryKey(pw)) }
      } catch (e) {
        return failure(e) as { ok: false; message: string }
      }
    }),
  )
}
