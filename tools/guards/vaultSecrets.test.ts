import { describe, expect, it } from 'vitest'
import { read } from './repo'

/**
 * C7 (audit §4.3 Z-5, listing B.19): every secret parameter of `VaultApi` (src/shared/api.ts) is bytes, so the
 * renderer cannot send a password or recovery key as a string and main never receives one. This reads the
 * interface as text and enumerates its methods: a new method that takes a password, a recovery key or any
 * other secret must take `SecretBytes` (a `Uint8Array`) or `VaultSecret`, whose members are `SecretBytes`.
 */

interface Param {
  method: string
  name: string
  type: string
}

/** Every parameter of every method of `export interface <name> { … }` in `source`. */
export function interfaceParams(source: string, name: string): Param[] {
  const body = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(source)?.[1]
  if (body === undefined) throw new Error(`no interface ${name}`)
  const text = body.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '')
  const out: Param[] = []
  for (const m of text.matchAll(/^\s*(\w+)\(([^)]*)\)\s*:/gm)) {
    for (const p of m[2]!.split(/,(?![^<{(]*[>})])/)) {
      const at = p.indexOf(':')
      if (at < 0) continue
      out.push({ method: m[1]!, name: p.slice(0, at).trim().replace(/\?$/, ''), type: p.slice(at + 1).trim() })
    }
  }
  return out
}

/** A parameter name that names a secret the user types. */
const SECRET_NAME = /password|passphrase|recovery|secret|^pw$|^current$|^next$/i
const SECRET_TYPES = new Set(['SecretBytes', 'VaultSecret'])

/**
 * The one secret-named parameter left as text, with why: the recovery key that main just made and the
 * renderer shows (prepareEncryption, newRecoveryKey return it), written to the file the user picks. It adds no
 * copy that did not exist (audit Z-11 residual of a new key).
 */
const TEXT_RESIDUAL = new Set(['saveRecoveryKey.recoveryKey'])

/** The parameters that break the rule. */
export function secretParamsNotBytes(params: Param[]): string[] {
  return params
    .filter((p) => SECRET_NAME.test(p.name) && !SECRET_TYPES.has(p.type) && !TEXT_RESIDUAL.has(`${p.method}.${p.name}`))
    .map((p) => `${p.method}(${p.name}: ${p.type})`)
}

/** Secret channels that vaultIpc.ts does not register as `ipc.handle(CH.<x>, secretHandler(…))`, or that index.ts registers too. */
export function secretChannelsNotWrapped(vaultIpc: string, index: string, channels: string[]): string[] {
  const out: string[] = []
  for (const ch of channels) {
    if (!new RegExp(`ipc\\.handle\\(\\s*CH\\.${ch}\\s*,\\s*secretHandler\\(`).test(vaultIpc)) out.push(`${ch}: not through secretHandler in vaultIpc.ts`)
    if (new RegExp(`\\bCH\\.${ch}\\b`).test(index)) out.push(`${ch}: also registered in index.ts`)
  }
  return out
}

describe('C7: VaultApi takes every typed secret as bytes (Z-5)', () => {
  const api = read('packages/desktop/src/shared/api.ts')
  const params = interfaceParams(api, 'VaultApi')

  it('every secret parameter of VaultApi is SecretBytes or VaultSecret', () => {
    expect(secretParamsNotBytes(params).map((p) => `${p}: take the secret as SecretBytes (src/shared/secret.ts); the page sends it with submitSecret (renderer/src/vault/secretInput.ts)`)).toEqual([])
    // The audit's list (C7 files), each present and taking bytes.
    const secretMethods = ['unlock', 'unlockRecovery', 'enableQuickUnlock', 'finishMigration', 'checkPassword', 'prepareEncryption', 'confirmRecovery', 'join', 'changePassword', 'newRecoveryKey']
    for (const m of secretMethods) expect(params.filter((p) => p.method === m && SECRET_TYPES.has(p.type)).length, m).toBeGreaterThan(0)
  })

  it('SecretBytes is a Uint8Array and VaultSecret holds nothing but SecretBytes', () => {
    expect(read('packages/desktop/src/shared/secret.ts')).toMatch(/^export type SecretBytes = Uint8Array & \{ readonly \[secretBytesBrand\]\?: true \}$/m)
    expect(api).toMatch(/^export type VaultSecret = \{ password: SecretBytes \} \| \{ recoveryKey: SecretBytes \}$/m)
  })

  it('the preload zeroes its copy of every secret it forwards (settle)', () => {
    const preload = read('packages/desktop/src/preload/index.ts')
    const vault = /\n {2}vault: \{([\s\S]*?)\n {2}\},/.exec(preload)?.[1] ?? ''
    for (const m of new Set(params.filter((p) => SECRET_TYPES.has(p.type)).map((p) => p.method))) {
      expect(vault, m).toMatch(new RegExp(`\\n {4}${m}: \\([^)]*\\) => settle\\(ipcRenderer\\.invoke\\(`))
    }
  })

  it('main registers every secret channel through secretHandler in vaultIpc.ts, which zeroes the secret on every exit (review M1)', () => {
    const preload = read('packages/desktop/src/preload/index.ts')
    const channels = [...preload.matchAll(/settle\(ipcRenderer\.invoke\(CH\.(\w+)/g)].map((m) => m[1]!)
    expect(channels.length).toBeGreaterThanOrEqual(10)
    expect(secretChannelsNotWrapped(read('packages/desktop/src/main/vaultIpc.ts'), read('packages/desktop/src/main/index.ts'), channels)).toEqual([])
    expect(read('packages/desktop/src/main/vaultIpc.ts')).toMatch(/\} finally \{\n\s+zeroSecret\(\.\.\.secretsIn\(args\)\)/)
  })

  it('every channel that carries a secret is a SECRET_CHANNELS row, so createIpc zeroes it outside the gate and the sender check (re-review M)', () => {
    const preload = read('packages/desktop/src/preload/index.ts')
    const carried = [...preload.matchAll(/settle\(ipcRenderer\.invoke\(CH\.(\w+)/g)].map((m) => m[1]!)
    const guard = read('packages/desktop/src/main/ipcGuard.ts')
    const block = /export const SECRET_CHANNELS[^=]*= \{([\s\S]*?)\n\}/.exec(guard)?.[1] ?? ''
    const marked = [...block.matchAll(/^\s*(\w+): true,/gm)].map((m) => m[1]!)
    expect([...new Set(carried)].sort()).toEqual(marked.sort())
    // The zeroing wraps the sender check and everything inside it.
    expect(guard).toMatch(/if \(!SECRET\.has\(c\)\) return run\(\)[\s\S]*?\} finally \{\n\s+zeroSecret\(\.\.\.secretsIn\(args\)\)/)
  })

  it('the wrapper check sees a secret channel registered bare, or registered elsewhere (self-test)', () => {
    const good = 'ipc.handle(\n    CH.vaultUnlock,\n    secretHandler(async (arg) => d.unlock(arg)),\n  )'
    expect(secretChannelsNotWrapped(good, '', ['vaultUnlock'])).toEqual([])
    expect(secretChannelsNotWrapped('ipc.handle(CH.vaultUnlock, async (_e, arg) => unlock(arg))', '', ['vaultUnlock'])).toEqual(['vaultUnlock: not through secretHandler in vaultIpc.ts'])
    expect(secretChannelsNotWrapped(good, 'ipc.handle(CH.vaultUnlock, (_e, a) => a)', ['vaultUnlock'])).toEqual(['vaultUnlock: also registered in index.ts'])
  })

  it('main checks the shape of each secret it receives (passwordBytes: a Uint8Array of 1-4096 bytes)', () => {
    expect(read('packages/desktop/src/shared/secret.ts')).toMatch(/arg instanceof Uint8Array && arg\.length >= 1 && arg\.length <= SECRET_MAX_BYTES \? arg : null/)
    expect(read('packages/desktop/src/shared/secret.ts')).toMatch(/export const SECRET_MAX_BYTES = 4096/)
  })

  it('the check sees a string secret, a new secret method and a secret inside an object (self-test)', () => {
    const bad = 'export interface VaultApi {\n  unlock(password: string): Promise<UnlockResult>\n  /** x */\n  rotate(current: VaultSecret, next: string): Promise<void>\n  status(): Promise<VaultStatus>\n  wipe(opts: { passphrase: string }): void\n}'
    const p = interfaceParams(bad, 'VaultApi')
    expect(p.map((x) => x.name)).toEqual(['password', 'current', 'next', 'opts'])
    expect(secretParamsNotBytes(p)).toEqual(['unlock(password: string)', 'rotate(next: string)'])
    // An object parameter is caught by its name or not at all: name it after the secret, or use VaultSecret.
    expect(secretParamsNotBytes([{ method: 'wipe', name: 'secret', type: '{ passphrase: string }' }])).toEqual(['wipe(secret: { passphrase: string })'])
  })
})
