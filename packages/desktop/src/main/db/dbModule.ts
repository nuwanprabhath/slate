// Which @slate/native instance the notes database runs on (audit C3: SQLCipher lives inside the
// module, so there is no database without it). The app registers the module launch.ts started; the
// CLIs register an uninitialised one (plaintext only); main-process tests register theirs in testSetup.
import { join } from 'node:path'
import { loadNative, type SlateNative } from '@slate/native'

export interface DbModule {
  native: SlateNative
  /** A keyed database must run on the FIPS provider (packaged builds; `fips-140-3` once C5 adds profiles). */
  requireFips: boolean
  /**
   * Review C6 (S-7 c): every error of a connection openDatabase made, its constructor or its statements, before it
   * reaches the caller. The app classifies it (`databaseFault`) and fails closed on a module fault.
   */
  onDatabaseError?: (e: unknown) => void
}

export class DatabaseModuleUnavailable extends Error {
  constructor() {
    super('The cryptographic module is not loaded, so notes cannot be opened (build it with `npm run -w @slate/native build`)')
    this.name = 'DatabaseModuleUnavailable'
  }
}

let provider: (() => DbModule) | null = null
let current: DbModule | null = null

/** Registers how to reach the module; `get` runs once, at the first database open. */
export function provideDbModule(get: (() => DbModule) | null): void {
  provider = get
  current = null
}

export function dbModule(): DbModule {
  if (!current) {
    if (!provider) throw new DatabaseModuleUnavailable()
    current = provider()
  }
  return current
}

/**
 * The MCP and import CLIs open only the plaintext `slate.db` (an encrypted data folder is opened by the
 * app alone, §9), so they load the addon next to their bundle and never initialise its key services.
 */
export function provideCliDbModule(mainDir: string): void {
  provideDbModule(() => ({ native: loadNative(join(mainDir, '../native/slate_native.node')), requireFips: false }))
}

/** C6 criterion 4: a note database or the services opened while the power-up self-test runs or after it failed. */
export class NotesBeforeSelfTest extends Error {
  override name = 'NotesBeforeSelfTest'
  constructor(what: string, state: string) {
    super(`${what} while the vault state is ${state}: notes open only after the power-up self-test passed (audit §4.2 S-2)`)
  }
}

let selfTestState: (() => string) | null = null

/**
 * index.ts registers the vault state here before anything else runs. From then on `openDatabase` and
 * `openServices` throw while it is `selftest` or `selftest-failed`; a process that registers nothing (the CLIs,
 * most tests) is not gated here, and the module's own gate still refuses a keyed database.
 */
export function gateNotesOnSelfTest(state: (() => string) | null): void {
  selfTestState = state
}

export function assertNotesMayOpen(what: string): void {
  const state = selfTestState?.()
  if (state === 'selftest' || state === 'selftest-failed') throw new NotesBeforeSelfTest(what, state)
}
