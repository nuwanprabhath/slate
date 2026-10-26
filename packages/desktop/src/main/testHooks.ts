/**
 * Environment variables that weaken or redirect the app for tests. A packaged app must never obey
 * them (anyone who can set an environment variable could otherwise make a vault with a weak KDF,
 * crash a migration or send Graph requests elsewhere), and the packaged e2e harness needs none.
 */
export const TEST_HOOK_VARS = [
  'SLATE_TEST_WEAK_KDF',
  'SLATE_TEST_ENCRYPT_PASSWORD',
  'SLATE_TEST_IDLE_MS',
  'SLATE_TEST_CRASH_AT',
  // The e2e hook's test vault (SLATE_TEST_ENCRYPT_PASSWORD) in this crypto profile: fips-140-3 or standard (C5).
  'SLATE_TEST_PROFILE',
  'SLATE_GRAPH_URL',
  // The fake update feed (update/fakeBackend.ts) verifies against a key it made itself.
  'SLATE_FAKE_UPDATE',
  // Forces a power-up self-test failure (T-POST-10, -13); with _ON_DEMAND=1 only the runs after start-up (T-POST-12).
  'SLATE_TEST_SELFTEST_CORRUPT',
  'SLATE_TEST_SELFTEST_CORRUPT_ON_DEMAND',
  // The e2e fakes: a Microsoft sign-in that always succeeds, a canned theme generator, a backup
  // file instead of the open dialog (C12 N2). The packaged e2e harness needs none of them.
  'SLATE_FAKE_AUTH',
  'SLATE_FAKE_CLAUDE_THEME',
  'SLATE_E2E_BACKUP_PATH',
  // T-ZERO-04/-07 (C7): a full GC and a V8 heap snapshot for the e2e memory tests (memoryProbes.ts).
  'SLATE_TEST_EXPOSE_GC',
  'SLATE_TEST_HEAP_SNAPSHOT',
] as const
export type TestHookVar = (typeof TEST_HOOK_VARS)[number]

/**
 * The other `SLATE_*` variables main reads, which a packaged app still sees. Each has its reason in
 * tools/guards/allowlists/env-vars.json; a guard test fails on a variable read under src/main that
 * is in neither list. A variable that weakens the app belongs in TEST_HOOK_VARS instead.
 */
export const APP_ENV_VARS = [
  'SLATE_E2E',
  'SLATE_E2E_SHOW',
  'SLATE_USER_DATA',
  'SLATE_MS_CLIENT_ID',
  'SLATE_SYNC_INTERVAL_MS',
  'SLATE_GITHUB_CLIENT_ID',
  'SLATE_SAFE_THEME',
  'SLATE_ONE2HTML',
] as const
export type AppEnvVar = (typeof APP_ENV_VARS)[number]

/** Variables the platform or the tooling sets, which main reads; each documented in env-vars.json too. */
export const PLATFORM_ENV_VARS = ['ELECTRON_RENDERER_URL', 'SHELL', 'VITEST', 'APPDATA', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR', 'APPIMAGE'] as const
export type PlatformEnvVar = (typeof PLATFORM_ENV_VARS)[number]

export type EnvVar = TestHookVar | AppEnvVar | PlatformEnvVar

/**
 * App variables only an e2e run sets (hidden window; SLATE_E2E also turns off update checks). A
 * packaged release ignores them; only the build `npm run dist:e2e` makes for the packaged e2e
 * harness obeys them, which is decided at build time (`isE2EBuild`), never by the environment.
 */
export const E2E_BUILD_VARS = ['SLATE_E2E', 'SLATE_E2E_SHOW'] as const satisfies readonly AppEnvVar[]

declare const __SLATE_E2E_BUILD__: boolean | undefined

/** True only in a bundle built with `electron-vite build --mode e2e` (electron.vite.config.ts). */
export function isE2EBuild(): boolean {
  return typeof __SLATE_E2E_BUILD__ !== 'undefined' && __SLATE_E2E_BUILD__ === true
}

/** Run first thing in main, so every later reader of `process.env` sees the hooks gone. */
export function scrubTestHooks(env: NodeJS.ProcessEnv, packaged: boolean, e2eBuild = false): void {
  if (!packaged) return
  for (const name of TEST_HOOK_VARS) delete env[name]
  if (!e2eBuild) for (const name of E2E_BUILD_VARS) delete env[name]
}

/** `scrubTestHooks` on this process's own environment. */
export function scrubProcessTestHooks(packaged: boolean): void {
  scrubTestHooks(process.env, packaged, isE2EBuild())
}

/**
 * The one way main reads an environment variable (lint rule `slate/env-through-test-hooks`). The
 * name must be in one of the lists above, so a new variable is a decision made here, in review.
 */
export function env(name: EnvVar): string | undefined {
  return process.env[name]
}

/** A copy of the documented variables only, for a pure function that takes an `env` record. */
export function envSnapshot(): Readonly<Partial<Record<EnvVar, string>>> {
  const out: Partial<Record<EnvVar, string>> = {}
  for (const name of [...TEST_HOOK_VARS, ...APP_ENV_VARS, ...PLATFORM_ENV_VARS]) {
    const value = process.env[name]
    if (value !== undefined) out[name] = value
  }
  return Object.freeze(out)
}
