import { describe, expect, it } from 'vitest'
import { E2E_BUILD_VARS, scrubTestHooks, TEST_HOOK_VARS } from './testHooks'

const hooks = {
  SLATE_TEST_WEAK_KDF: '1',
  SLATE_TEST_ENCRYPT_PASSWORD: 'pw',
  SLATE_TEST_IDLE_MS: '3000',
  SLATE_TEST_CRASH_AT: 'migration:copy',
  // C5: the e2e hook's test vault in the fips-140-3 profile.
  SLATE_TEST_PROFILE: 'fips-140-3',
  SLATE_GRAPH_URL: 'http://127.0.0.1:1/',
  // C12: the fake update feed trusts a key it made itself; a release build must never pick it.
  SLATE_FAKE_UPDATE: 'deb',
  // T-POST-13: a packaged build ignores the self-test corruption hook (C6 reads it).
  SLATE_TEST_SELFTEST_CORRUPT: 'kat:aes-gcm',
  // T-POST-12: the same, applied to the self-tests after start-up only.
  SLATE_TEST_SELFTEST_CORRUPT_ON_DEMAND: '1',
  // C12 N2 (C8): the e2e fakes (Microsoft sign-in, theme generator, backup path) are test hooks too.
  SLATE_FAKE_AUTH: '1',
  SLATE_FAKE_CLAUDE_THEME: '1',
  SLATE_E2E_BACKUP_PATH: '/tmp/backup.one',
  // C7: the T-ZERO e2e probes (a full GC, a heap snapshot) never exist in a packaged app.
  SLATE_TEST_EXPOSE_GC: '1',
  SLATE_TEST_HEAP_SNAPSHOT: '1',
}

describe('test hooks (§15)', () => {
  it('are dropped from a packaged app, whatever else is set, even the packaged e2e build', () => {
    const env: NodeJS.ProcessEnv = { ...hooks, SLATE_E2E: '1', HOME: '/home/me' }
    scrubTestHooks(env, true, true)
    for (const name of Object.keys(hooks)) expect(env[name], name).toBeUndefined()
    expect(env.HOME).toBe('/home/me')
    expect(env.SLATE_E2E).toBe('1')
  })

  it('a packaged release also ignores SLATE_E2E and SLATE_E2E_SHOW (C12 N2: SLATE_E2E=1 turned off update checks)', () => {
    const env: NodeJS.ProcessEnv = { SLATE_E2E: '1', SLATE_E2E_SHOW: '1', SLATE_USER_DATA: '/d' }
    scrubTestHooks(env, true)
    expect(env).toEqual({ SLATE_USER_DATA: '/d' })
    expect([...E2E_BUILD_VARS]).toEqual(['SLATE_E2E', 'SLATE_E2E_SHOW'])
  })

  it('stay in a development build', () => {
    const env: NodeJS.ProcessEnv = { ...hooks }
    scrubTestHooks(env, false)
    expect(env).toEqual(hooks)
  })

  it('cover every hook the main process reads', () => {
    expect([...TEST_HOOK_VARS].sort()).toEqual(Object.keys(hooks).sort())
  })
})
