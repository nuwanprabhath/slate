// POAM-16 (maintainer decision, review C5): a fips-140-3 vault refuses to unlock while the renderer that holds
// the typed password runs outside Chromium's sandbox; a standard vault is unchanged and only warns.
import { describe, expect, it } from 'vitest'
import { SANDBOX_NOTICE_BODY } from '../../shared/sandboxNotice'
import { checkRendererSandbox, PROFILES, RendererUnsandboxed } from './profile'

describe('the unsandboxed-renderer rule per profile', () => {
  it('refuses a fips-140-3 unlock while the renderer is unsandboxed', () => {
    expect(() => checkRendererSandbox('fips-140-3', false)).toThrow(RendererUnsandboxed)
  })

  it('allows a fips-140-3 unlock once the renderer is sandboxed', () => {
    expect(() => checkRendererSandbox('fips-140-3', true)).not.toThrow()
  })

  it('never refuses a standard vault, sandboxed or not', () => {
    expect(() => checkRendererSandbox('standard', false)).not.toThrow()
    expect(() => checkRendererSandbox('standard', true)).not.toThrow()
    expect(PROFILES.standard.requireSandboxedRenderer).toBe(false)
    expect(PROFILES['fips-140-3'].requireSandboxedRenderer).toBe(true)
  })

  it('says the same thing the notice says, and what to do about it', () => {
    const m = new RendererUnsandboxed().message
    expect(m).toContain(SANDBOX_NOTICE_BODY)
    expect(m).toMatch(/FIPS 140-3/)
    expect(m).toMatch(/\.deb/)
  })
})
