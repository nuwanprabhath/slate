import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../shared/settings/schema'
import { DISCLOSURES } from '../../shared/privacy/consent'
import { CH } from '../../shared/ipc'
import { ConsentRequired, setPrivacySource } from '../privacy/gate'
import { registerThemeIpc } from './ipc'

vi.mock('electron', () => ({ app: { getGPUFeatureStatus: () => ({}) }, nativeTheme: { shouldUseDarkColors: true } }))

afterEach(() => setPrivacySource(() => null))

function setup() {
  const handlers = new Map<string, (...a: unknown[]) => unknown>()
  const ipc = { handle: (c: string, h: (...a: unknown[]) => unknown) => void handlers.set(c, h), on: () => undefined }
  const run = vi.fn().mockResolvedValue('{}')
  const find = vi.fn().mockResolvedValue('/bin/claude')
  registerThemeIpc(ipc as never, { open: () => null, preunlock: () => null }, false, { runner: { run, cancel() {} } as never, findClaude: find })
  return { call: (c: string, ...a: unknown[]) => handlers.get(c)!({}, ...a) as Promise<unknown>, run, find }
}
const strict = (granted: boolean) =>
  setPrivacySource(() => ({ ...DEFAULT_SETTINGS, gdprStrictMode: true, consents: granted ? { claudeTheme: { grantedAt: 1, textVersion: DISCLOSURES.claudeTheme.textVersion, source: 'user' } } : {} }))

describe('Claude themes need consent (GDPR-16)', () => {
  it('without consent: availability is false and `claude` is not looked for', async () => {
    strict(false)
    const { call, find } = setup()
    expect(await call(CH.themesClaude)).toBe(false)
    expect(find).not.toHaveBeenCalled()
  })

  it('without consent: generate is refused before anything runs', async () => {
    strict(false)
    const { call, run, find } = setup()
    await expect(call(CH.themesGenerate, 'calm blue', null)).rejects.toBeInstanceOf(ConsentRequired)
    expect(run).not.toHaveBeenCalled()
    expect(find).not.toHaveBeenCalled()
  })

  it('with consent: availability asks for `claude`', async () => {
    strict(true)
    const { call, find } = setup()
    expect(await call(CH.themesClaude)).toBe(true)
    expect(find).toHaveBeenCalledTimes(1)
  })
})
