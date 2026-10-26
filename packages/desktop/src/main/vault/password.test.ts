import { describe, expect, it } from 'vitest'
import { checkPassword } from './password'
import { secretBytes } from '../../shared/secret'

describe('checkPassword', () => {
  it('needs at least 10 characters after NFC', () => {
    expect(checkPassword(secretBytes('short pw!'), []).ok).toBe(false)
    // Nine code points once composed, ten before.
    expect(checkPassword(secretBytes('café xy q'), []).ok).toBe(false)
    expect(checkPassword(secretBytes('café xyz qq'), []).ok).toBe(true)
  })

  it('refuses common passwords whatever the case', () => {
    const r = checkPassword(secretBytes('Password123'), [])
    expect(r.ok).toBe(false)
    expect(r.reason).toBeTruthy()
    expect(checkPassword(secretBytes('QWERTYUIOP'), []).ok).toBe(false)
    expect(checkPassword(secretBytes('1234567890'), []).ok).toBe(false)
  })

  it('refuses the context strings, case-insensitively', () => {
    expect(checkPassword(secretBytes('Nuwan@Example.com'), ['nuwan@example.com']).ok).toBe(false)
    expect(checkPassword(secretBytes('my notebook vault'), ['My Notebook Vault']).ok).toBe(false)
  })

  it('rates strength 0..4, longer and more varied scoring higher', () => {
    const weak = checkPassword(secretBytes('aaaaaaaaaa'), []).strength
    const strong = checkPassword(secretBytes('purple-Otter-71-rides-a-bike!'), []).strength
    expect(weak).toBeGreaterThanOrEqual(0)
    expect(strong).toBeLessThanOrEqual(4)
    expect(strong).toBeGreaterThan(weak)
    expect(checkPassword(secretBytes('Password123'), []).strength).toBe(0)
  })

  it('C7 criterion 5: takes the password as bytes, refuses bytes that are not UTF-8, and leaves the bytes to their owner', () => {
    expect(checkPassword(new Uint8Array([0xff, 0xfe, 0x70, 0x61, 0x73, 0x73, 0x77, 0x6f, 0x72, 0x64, 0x21, 0x21]), [])).toMatchObject({ ok: false, strength: 0 })
    const pw = secretBytes('purple-Otter-71-rides-a-bike!')
    const copy = Array.from(pw)
    expect(checkPassword(pw, []).ok).toBe(true)
    expect(Array.from(pw)).toEqual(copy)
  })
})
