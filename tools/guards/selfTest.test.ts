import { describe, expect, it } from 'vitest'
import { CH } from '../../packages/desktop/src/shared/ipc'
import { isTestFile, read, walk } from './repo'

/**
 * C6 (audit §4.2): the power-up self-test is the first thing that touches the cryptographic module, and a failed
 * one leaves only the error screen. What keeps that so, read as text so it runs without Electron:
 * - the module is gated (`postGate`) before init in the app's start (native/cryptoModule.ts, launch.ts), and only
 *   the self-test (vault/selftest/post.ts) opens and closes the session that lets services run before it passed;
 * - every channel has a SELF_TEST_POLICY row, and the set served in `selftest`/`selftest-failed` is pinned here;
 * - `openDatabase` and `openServices` refuse first thing while the state is `selftest` (criterion 4), and index.ts
 *   registers its state machine before the module starts and opens no window before the self-test.
 */

/** The error screen's channels (audit §4.2 table): status, version, window chrome, Quit, the diagnostic report. */
const SERVED_IN_SELF_TEST = ['appQuit', 'appVersion', 'chromeInvokeMenu', 'chromeKind', 'chromeMenu', 'chromeSetColors', 'chromeToggleMaximize', 'diagnosticsCopyReport', 'themesInitial', 'vaultStatus']

const SOURCES = ['packages/desktop/src', 'packages/sync/src', 'packages/mcp/src', 'packages/importer/src']
  .flatMap((d) => walk(d, ['.ts', '.tsx'], isTestFile).filter((f) => !isTestFile(f)))
  .map((file) => ({ file, text: read(file).replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '') }))

/** Files calling a native self-test control (`.postGate(`, `.postBegin(`, `.postEnd(`), by control. */
export function sessionCallers(sources: ReadonlyArray<{ file: string; text: string }>): Record<string, string[]> {
  const out: Record<string, string[]> = { postGate: [], postBegin: [], postEnd: [] }
  for (const { file, text } of sources) {
    for (const name of Object.keys(out)) if (new RegExp(`(\\.|\\[\\s*['"\`])${name}\\b`).test(text)) out[name]!.push(file)
  }
  return out
}

function selfTestPolicy(): Map<string, string> {
  const text = read('packages/desktop/src/main/ipcGuard.ts')
  const block = /export const SELF_TEST_POLICY[^=]*= \{([\s\S]*?)\n\}/.exec(text)?.[1] ?? ''
  return new Map([...block.matchAll(/^\s+(\w+): '(served|refused|event)',$/gm)].map((m) => [m[1]!, m[2]!]))
}

/**
 * Review C6 (MEDIUM): every function @slate/native exports is either a service whose corruption the POST must
 * catch (a mutation case in vault/selftest/post.mutation.test.ts, named with the check that catches it) or has
 * a reason here why it is not one. A new export without an entry fails.
 */
const NATIVE_COVERAGE: Record<string, string> = {
  init: 'control: loads the provider, whose integrity test and CASTs run on load (SCC_6/SCC_15 at init)',
  hardenProcess: 'control: process limits, checked by POST-HARDEN at start-up (C7)',
  postGate: 'control: the self-test gate itself',
  postBegin: 'control: the self-test session',
  postEnd: 'control: the self-test session (a refusal fails the POST, mutation test)',
  status: 'control: read by POST-MODULE-STATUS',
  enterErrorState: 'control: the error state',
  zeroizeAll: 'control: zeroisation (T-ZERO)',
  requireApprovedKeys: 'control: the fips-140-3 latch; the POST checks the refusals it causes',
  keyRandom: 'key generation from the module DRBG (POST-DRBG); its keys are wrapped and opened by POST-KEY-WRAP',
  keyDestroy: 'mutation: POST-ZEROIZE',
  kbkdf: 'mutation: POST-KBKDF',
  hkdfLegacy: 'mutation: POST-HKDF-LEGACY',
  pbkdf2: 'not called by the vault; the same pbkdf2_derive as pbkdf2Async (POST-PBKDF2)',
  pbkdf2Async: 'mutation: POST-PBKDF2',
  argon2id: 'not called by the vault; the same argon2_derive as argon2idAsync (POST-ARGON2ID)',
  argon2idAsync: 'mutation: POST-ARGON2ID',
  hkdfFromSecret: 'suite 0x01 only (v1 quick unlock and recovery), the same hkdf_std core as hkdfLegacy (POST-HKDF-LEGACY)',
  kbkdfFromSecret: 'mutation: the POST transport (every KAT after it)',
  pbkdf2Calibrate: 'returns an iteration count, no key; clamped to the profile floor by the module and validateKdf',
  nameSivEncode: 'mutation: POST-NAME-V2',
  nameSivDecode: 'mutation: POST-NAME-V2',
  recoveryDecode: 'mutation: POST-RECOVERY',
  hkdfFromRecovery: 'suite 0x01 only (v1 recovery), recoveryDecode (POST-RECOVERY) plus the hkdf_std core (POST-HKDF-LEGACY)',
  kbkdfFromRecovery: 'mutation: POST-RECOVERY',
  gcmSeal: 'mutation: POST-AES-GCM-ENC',
  gcmSealIvInAad: 'mutation: POST-SLE2-SEAL',
  gcmOpen: 'mutation: POST-AES-GCM-DEC',
  gcmSealKey: 'mutation: POST-KEY-WRAP',
  gcmOpenKey: 'mutation: the POST transport, POST-KEY-WRAP',
  rewrapKey: 'mutation: POST-KEY-WRAP',
  historySeal: 'mutation: POST-KEY-WRAP',
  historyRewrap: 'mutation: POST-KEY-WRAP',
  historyOpen: 'mutation: POST-KEY-WRAP',
  hmacSha256: 'mutation: POST-HMAC-SHA256',
  aesEcbBlock: 'mutation: POST-AES-ECB-ENC/DEC',
  aesCtr: 'mutation: POST-AES-GCM-ENC',
  sha256: 'mutation: POST-SHA256',
  randomBytes: 'mutation: POST-DRBG',
  mldsaVerify: 'mutation: POST-MLDSA-VERIFY (PQ-A4; the pass vector verifies, the flipped signature must not)',
  sqlite: 'SQLCipher: the provider CASTs it uses, and checkCipher on every keyed open (C3)',
}

/** Member names of `export interface SlateNative` in packages/native/index.ts. */
export function nativeMembers(indexTs: string): string[] {
  const body = /export interface SlateNative \{([\s\S]*?)\n\}/.exec(indexTs)?.[1] ?? ''
  return [...body.matchAll(/^ {2}(?:readonly )?(\w+)[(:]/gm)].map((m) => m[1]!)
}

describe('the power-up self-test comes first (C6)', () => {
  it('review C6: every native export is covered by a POST mutation case or has a reason', () => {
    const members = nativeMembers(read('packages/native/index.ts'))
    expect(members.length).toBeGreaterThan(30)
    expect(members.filter((m) => !(m in NATIVE_COVERAGE)).map((m) => `${m}: add a POST check (and a mutation case) or a reason to NATIVE_COVERAGE`)).toEqual([])
    expect(Object.keys(NATIVE_COVERAGE).filter((m) => !members.includes(m))).toEqual([])
    const mutations = /export const MUTATIONS[^=]*= \{([\s\S]*?)\n\}/.exec(read('packages/desktop/src/main/vault/selftest/post.mutation.test.ts'))?.[1] ?? ''
    const mutated = [...mutations.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]!)
    const claimed = Object.entries(NATIVE_COVERAGE).filter(([, v]) => v.startsWith('mutation:')).map(([k]) => k)
    expect(claimed.filter((m) => !mutated.includes(m)).map((m) => `${m} claims a mutation case that post.mutation.test.ts does not have`)).toEqual([])
    expect(nativeMembers('export interface SlateNative {\n  a(): 0\n  readonly b: object\n}')).toEqual(['a', 'b'])
  })

  it('only the self-test opens and closes a module session, and only the start-up gates the module', () => {
    expect(sessionCallers(SOURCES)).toEqual({
      postGate: ['packages/desktop/src/main/native/cryptoModule.ts'],
      postBegin: ['packages/desktop/src/main/vault/selftest/post.ts'],
      postEnd: ['packages/desktop/src/main/vault/selftest/post.ts'],
    })
  })

  it('the app always starts the module gated', () => {
    const launch = read('packages/desktop/src/main/native/launch.ts')
    expect(launch).toMatch(/startCryptoModule\(\{[^}]*\bgated: true,/)
    expect(read('packages/desktop/src/main/native/cryptoModule.ts')).toMatch(/if \(o\.gated\) \{\s*try \{\s*native\.postGate\(\)/)
  })

  it('every channel is decided for the self-test states, and only the error screen\'s are served', () => {
    const policy = selfTestPolicy()
    expect([...policy.keys()].sort()).toEqual(Object.keys(CH).sort())
    expect([...policy].filter(([, v]) => v === 'served').map(([k]) => k).sort()).toEqual(SERVED_IN_SELF_TEST)
  })

  it('review C6, S-7 (b): every vault-changing channel runs the self-test first, applied once in the registrar', () => {
    const guard = read('packages/desktop/src/main/ipcGuard.ts')
    const block = /export const VAULT_CHANGE_CHANNELS[^=]*= \{([\s\S]*?)\n\}/.exec(guard)?.[1] ?? ''
    expect([...block.matchAll(/^\s+(\w+): true,$/gm)].map((m) => m[1]).sort()).toEqual(
      ['vaultChangePassword', 'vaultEncrypt', 'vaultEncryptRemote', 'vaultFinishMigration', 'vaultJoin', 'vaultNewRecovery', 'vaultPrepare', 'vaultQuickUnlockEnable', 'vaultRekeyPrepare', 'vaultRekeyRun'],
    )
    expect(guard).toMatch(/if \(change\) return beforeChange\(\)\.then\(\(\) => handler\(\.\.\.args\)\)/)
    // index.ts hands the registrar its self-test; without one every vault change is refused.
    expect(read('packages/desktop/src/main/index.ts')).toMatch(/createIpc\([^\n]*, isSlateWindow, beforeVaultChange\)/)
  })

  it('criterion 4: openDatabase and openServices refuse first thing while the state is selftest', () => {
    expect(read('packages/desktop/src/main/db/openDatabase.ts')).toMatch(/export function openDatabase\([^)]*\)[^{]*\{\n\s*assertNotesMayOpen\('openDatabase'\)/)
    expect(read('packages/desktop/src/main/services.ts')).toMatch(/export function openServices\([^)]*\)[^{]*\{\n\s*assertNotesMayOpen\('openServices'\)/)
  })

  it('index.ts registers the state before the module starts, and opens no window and no notes before the self-test', () => {
    const index = read('packages/desktop/src/main/index.ts').replace(/\/\/.*$/gm, '')
    const at = (s: string) => index.indexOf(s)
    const selfTest = at('await startupSelfTest(')
    expect(at('gateNotesOnSelfTest(')).toBeGreaterThan(-1)
    expect(at('gateNotesOnSelfTest(')).toBeLessThan(at('launchCryptoModule('))
    expect(at('launchCryptoModule(')).toBeLessThan(selfTest)
    for (const later of ['openWindow()', 'startServices(null', 'armLockTriggers()', 'createUpdates(']) expect(at(later), later).toBeGreaterThan(selfTest)
    expect(index).not.toMatch(/new VaultStateMachine\(\s*[^)\s]/)
    // Review C6: the window factory shows the error screen whatever page is asked for once the self-test failed.
    expect(at('pinErrorPage(')).toBeGreaterThan(-1)
    expect(at('pinErrorPage(')).toBeLessThan(at('openWindow()'))
  })

  it('the checks catch the bad patterns (self-test)', () => {
    const bad = [
      { file: 'packages/desktop/src/main/feature.ts', text: 'native.postBegin(); native.postEnd(true)' },
      { file: 'packages/desktop/src/main/other.ts', text: "n['postGate']()" },
    ]
    expect(sessionCallers(bad)).toEqual({ postGate: ['packages/desktop/src/main/other.ts'], postBegin: ['packages/desktop/src/main/feature.ts'], postEnd: ['packages/desktop/src/main/feature.ts'] })
    expect('export function openDatabase(file: string) {\n  const mod = dbModule()\n  assertNotesMayOpen(\'openDatabase\')').not.toMatch(
      /export function openDatabase\([^)]*\)[^{]*\{\n\s*assertNotesMayOpen\('openDatabase'\)/,
    )
  })
})
