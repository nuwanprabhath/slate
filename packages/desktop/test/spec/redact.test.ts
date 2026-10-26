// @product-rule log-redaction (CLAUDE.md, Guardrails: key bytes are never logged). A guarded spec:
// its expectations only grow, and only the maintainer changes the thresholds it pins.
import { describe, expect, it } from 'vitest'
import type { LogFields } from '../../src/main/log/logger'
import type { KeyHandle } from '@slate/native'
import { redact, redactString } from '../../src/shared/redact'

describe('log redaction thresholds (red team G2-4)', () => {
  it('strips a 128-bit key written as 32 hex digits, and a 256-bit one as 64', () => {
    expect(redactString(`k ${'a1'.repeat(16)} end`)).toBe('k [redacted-hex] end')
    expect(redactString(`k ${'b2'.repeat(32)} end`)).toBe('k [redacted-hex] end')
  })

  it('strips a 128-bit key written as base64, padded or not, and as base64url', () => {
    const key = Buffer.from('0f1e2d3c4b5a69788796a5b4c3d2e1f0', 'hex')
    for (const text of [key.toString('base64'), key.toString('base64').replace(/=+$/, ''), key.toString('base64url')]) {
      expect(redactString(`qu ${text} end`), text).not.toContain(text)
    }
  })

  it('strips a 256-bit key written as base64', () => {
    const b64 = Buffer.alloc(32, 7).toString('base64')
    expect(redactString(`k ${b64}`)).not.toContain(b64)
  })

  it('keeps what is not key material: a git object id, a UUID, short hex, words and paths', () => {
    for (const s of ['commit 0123456789abcdef0123456789abcdef01234567', 'page 3f2b9c1e-4d5a-4e7b-9c1d-2e3f4a5b6c7d', 'short 0123456789abcdef0123456789abcde', 'checkPreunlockTampered', 'packages/desktop/src/main/vault/keyring.ts']) {
      expect(redactString(s), s).toBe(s)
    }
  })
})

describe('log fields never carry key bytes (red team final F-1)', () => {
  it('writes bytes of any kind, at any depth, as [bytes]', () => {
    // Key bytes as code outside the module would hold them (C4: the KeyRing itself holds only handles).
    const key = Buffer.alloc(32, 9)
    expect(redact({ key })).toEqual({ key: '[bytes]' })
    expect(redact({ state: { sync: key } })).toEqual({ state: { sync: '[bytes]' } })
    expect(redact([new Uint8Array(4), new ArrayBuffer(4), new DataView(new ArrayBuffer(4)), Buffer.alloc(2)])).toEqual(['[bytes]', '[bytes]', '[bytes]', '[bytes]'])
    expect(JSON.stringify(redact({ deep: [{ k: Buffer.from([154, 86]) }] }))).not.toContain('154')
  })

  it('a KeyRing key is not a log field, directly or nested (type)', () => {
    // C4: KeyRing.get returns a KeyHandle, a number naming a key in the module's secure heap. It holds no
    // key bytes, and LogFields still refuses it, so a key never becomes a log field even by mistake.
    const key = 0x1234 as KeyHandle
    // @ts-expect-error -- a key handle is not a LogValue
    const direct: LogFields = { key }
    // @ts-expect-error -- nor nested inside one
    const nested: LogFields = { state: { sync: key } }
    expect(JSON.stringify(redact(direct))).not.toMatch(/[0-9a-f]{32}|[A-Za-z0-9+/]{43}=/)
    expect(JSON.stringify(redact(nested))).not.toMatch(/[0-9a-f]{32}|[A-Za-z0-9+/]{43}=/)
  })
})
