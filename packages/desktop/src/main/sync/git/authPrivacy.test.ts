import { afterEach, describe, expect, it } from 'vitest'
import type { Settings } from '../../../shared/api'
import { DEFAULT_SETTINGS } from '../../../shared/settings/schema'
import { DISCLOSURES } from '../../../shared/privacy/consent'
import { setPrivacySource } from '../../privacy/gate'
import { DEVICE_FLOW_SCOPE, DEVICE_FLOW_SCOPE_HELP, githubDeviceFlow } from './auth'

const CODE = { device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', interval: 5, expires_in: 900 }

function scripted(bodies: unknown[]) {
  const calls: Array<Record<string, string>> = []
  const fetch = (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body ?? '{}')) as Record<string, string>)
    return new Response(JSON.stringify(bodies.shift()), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

const strict = (granted: boolean): Settings => ({
  ...DEFAULT_SETTINGS,
  gdprStrictMode: true,
  consents: granted ? { githubSignIn: { grantedAt: 1, textVersion: DISCLOSURES.githubSignIn.textVersion, source: 'user' } } : {},
})

afterEach(() => setPrivacySource(() => null))

describe('GDPR-11: GitHub device sign-in', () => {
  it('contacts GitHub only after the githubSignIn consent', async () => {
    setPrivacySource(() => strict(false))
    const gh = scripted([CODE, { access_token: 'gho_x' }])
    await expect(githubDeviceFlow('c', () => {}, { fetch: gh.fetch, sleep: async () => {} })).rejects.toMatchObject({ name: 'ConsentRequired', feature: 'githubSignIn' })
    expect(gh.calls).toEqual([])
  })

  it('asks for the scope it names, once consented', async () => {
    setPrivacySource(() => strict(true))
    const gh = scripted([CODE, { access_token: 'gho_x' }])
    expect(await githubDeviceFlow('c', () => {}, { fetch: gh.fetch, sleep: async () => {} })).toBe('gho_x')
    expect(gh.calls[0]).toMatchObject({ scope: DEVICE_FLOW_SCOPE })
  })

  it('explains in plain words what the repo scope grants', () => {
    expect(DEVICE_FLOW_SCOPE).toBe('repo')
    expect(DEVICE_FLOW_SCOPE_HELP).toMatch(/every repository/i)
  })
})
