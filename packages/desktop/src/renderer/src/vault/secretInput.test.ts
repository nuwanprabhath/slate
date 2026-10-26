import { describe, expect, it } from 'vitest'
import { peekSecret, sendSecrets, submitSecret, takeSecret } from './secretInput'

describe('a typed secret leaves the page once, as bytes (Z-5, B.19)', () => {
  it('takeSecret reads the field once as NFC UTF-8 and clears it', () => {
    const field = { value: 'café password' }
    const bytes = takeSecret(field)
    expect(field.value).toBe('')
    expect(new TextDecoder().decode(bytes!)).toBe('café password')
    expect(takeSecret(field)).toBeNull()
    expect(takeSecret(null)).toBeNull()
  })

  it('peekSecret leaves the field as it is', () => {
    const field = { value: 'a new password' }
    expect(Array.from(peekSecret(field)!)).toEqual(Array.from(new TextEncoder().encode('a new password')))
    expect(field.value).toBe('a new password')
    expect(peekSecret({ value: '' })).toBeNull()
  })

  it('submitSecret sends the bytes and zeroes them when the call settles, also when it fails', async () => {
    let sent: Uint8Array | null = null
    const field = { value: 'correct horse battery' }
    const result = await submitSecret(field, async (s) => {
      sent = s
      expect(s.some((b) => b !== 0)).toBe(true)
      return 'ok'
    })
    expect(result).toBe('ok')
    expect(field.value).toBe('')
    expect(Array.from(sent!).every((b) => b === 0)).toBe(true)

    let failed: Uint8Array | null = null
    await expect(
      submitSecret({ value: 'another one' }, async (s) => {
        failed = s
        throw new Error('ipc broke')
      }),
    ).rejects.toThrow('ipc broke')
    expect(Array.from(failed!).every((b) => b === 0)).toBe(true)
    expect(await submitSecret({ value: '' }, async () => 'never')).toBeNull()
  })

  it('sendSecrets zeroes every secret of a call (a current and a new password)', async () => {
    const a = takeSecret({ value: 'current password' })
    const b = takeSecret({ value: 'next password' })
    await sendSecrets([a, b, null], async () => {})
    expect([...a!, ...b!].every((x) => x === 0)).toBe(true)
  })
})
