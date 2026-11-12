import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { mergeSettings, sanitizePatch, SCHEMA } from './schema'
import { fcParams } from '../../../test/fuzz'

// F4a property 5: whatever object arrives (over IPC, or stored), only SCHEMA's keys come out, each
// holding a value its own SettingDef accepts, and `__proto__`/`constructor` in the input change nothing.

const KEYS = Object.keys(SCHEMA) as Array<keyof typeof SCHEMA>
const STRICT = { allowLocal: false }

const field: fc.Arbitrary<unknown> = fc.oneof(
  fc.anything({ withTypedArray: true, withNullPrototype: true, withDate: true }),
  fc.constantFrom(true, false, null, 0, 6, 1e9, -1, Number.NaN, 'auto', 'git', 'onedrive', '', 'x'.repeat(101)),
  fc.record({ remoteUrl: fc.constantFrom('https://example.invalid/n.git', 'file:///tmp/r', 'x'), branch: fc.constantFrom('main', '', '-x'), auth: fc.constantFrom('system', 'sudo') }),
)

/** An object with some SCHEMA keys, some others, and own `__proto__`/`constructor` keys (as JSON.parse makes them). */
const patch: fc.Arbitrary<Record<string, unknown>> = fc
  .tuple(
    fc.dictionary(fc.constantFrom(...KEYS), field),
    fc.dictionary(fc.string(), field, { maxKeys: 3 }),
    fc.boolean(),
  )
  .map(([known, other, hostile]) => {
    const out: Record<string, unknown> = { ...other, ...known }
    // Own keys, as JSON.parse and structured clone make them (Object.assign would set the prototype instead).
    if (hostile) {
      for (const [k, x] of Object.entries(JSON.parse('{"__proto__":{"debugLog":true,"polluted":1},"constructor":{"prototype":{"polluted":1}}}') as object))
        Object.defineProperty(out, k, { value: x, enumerable: true, configurable: true, writable: true })
    }
    return out
  })

function wellFormed(out: Record<string, unknown>) {
  expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
  for (const k of Reflect.ownKeys(out)) {
    expect(KEYS as PropertyKey[], String(k)).toContain(k)
    const key = k as keyof typeof SCHEMA
    // A value SettingDef accepts is one its sanitize keeps as it is.
    expect(SCHEMA[key].sanitize(out[key], STRICT), String(k)).toEqual(out[key])
  }
}

describe('F4a: settings come out of the schema well formed', () => {
  it('T-F4A-40: sanitizePatch returns only SCHEMA keys with values their SettingDef accepts', () => {
    fc.assert(
      fc.property(patch, (p) => {
        const out = sanitizePatch(p) as Record<string, unknown>
        wellFormed(out)
        for (const k of Reflect.ownKeys(out)) expect(Object.prototype.hasOwnProperty.call(p, k), String(k)).toBe(true)
      }),
      fcParams,
    )
  })

  it('T-F4A-41: mergeSettings returns every SCHEMA key, each accepted, and ignores __proto__ and constructor', () => {
    fc.assert(
      fc.property(patch, (p) => {
        const out = mergeSettings(p) as unknown as Record<string, unknown>
        wellFormed(out)
        expect(Reflect.ownKeys(out).sort()).toEqual([...KEYS].sort())
        expect(({} as Record<string, unknown>).polluted).toBeUndefined()
      }),
      fcParams,
    )
  })
})
