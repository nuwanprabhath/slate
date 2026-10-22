import { describe, expect, it } from 'vitest'
import { redact, redactString } from './redact'

describe('redactString', () => {
  it('rewrites the given home directory to ~', () => {
    expect(redactString('open /Users/ann/notes/a.db', { home: '/Users/ann' })).toBe('open ~/notes/a.db')
  })
  it("rewrites any other account's home too", () => {
    expect(redactString('from /home/bob/x and "/Users/cy/y"')).toBe('from ~/x and "~/y"')
  })
  it('strips GitHub tokens', () => {
    expect(redactString(`t ghp_${'a'.repeat(30)}`)).toBe('t [redacted-github-token]')
    expect(redactString(`t github_pat_${'A1_'.repeat(12)}`)).toBe('t [redacted-github-token]')
  })
  it('strips bearer headers', () => {
    expect(redactString('Authorization: Bearer abcdefgh12345')).not.toContain('abcdefgh12345')
  })
  it('strips passwords in URLs', () => {
    const out = redactString('fatal: unable to access https://user:pass123@github.com/o/r.git')
    expect(out).toBe('fatal: unable to access https://[redacted]@github.com/o/r.git')
  })
  it('strips key=value secrets', () => {
    expect(redactString('token=abcd1234 password: "hunter22"')).toBe('token=[redacted] password=[redacted]')
  })
  it('strips API keys and JWTs', () => {
    expect(redactString(`k sk-${'x'.repeat(20)}`)).toBe('k [redacted-api-key]')
    expect(redactString(`j eyJ${'a'.repeat(12)}.${'b'.repeat(12)}.${'c'.repeat(12)}`)).toBe('j [redacted-jwt]')
  })
  it('truncates long strings', () => {
    const out = redactString('x'.repeat(600))
    expect(out.length).toBeLessThan(600)
    expect(out).toContain('[+88 chars]')
  })
})

describe('redact', () => {
  it('walks objects and arrays', () => {
    expect(redact({ a: ['/Users/ann/x'], n: 1, u: undefined })).toEqual({ a: ['~/x'], n: 1 })
  })
  it('describes errors by name and redacted message only', () => {
    expect(redact(new Error('bad /home/bob/x'))).toEqual({ name: 'Error', message: 'bad ~/x' })
  })
  it('cuts cycles and caps long arrays', () => {
    const a: Record<string, unknown> = {}
    a.self = a
    expect(redact(a)).toEqual({ self: '[circular]' })
    expect((redact(Array.from({ length: 60 }, (_, i) => i)) as unknown[]).length).toBe(51)
  })
  it('describes functions rather than serialising them', () => {
    expect(redact(() => 1)).toBe('[function]')
  })
})
