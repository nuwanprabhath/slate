import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import * as v from './ipcValidators'
import { fcParams } from '../../test/fuzz'

// F4a property 4: every validator is total (never throws, whatever the renderer sends) and, when it
// accepts, the value is within the caps it names.

const STRICT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const input: fc.Arbitrary<unknown> = fc.oneof(
  { weight: 4, arbitrary: fc.anything({ withTypedArray: true, withMap: true, withSet: true, withNullPrototype: true, withBigInt: true, withDate: true }) },
  { weight: 1, arbitrary: fc.uuid().map((u) => fc.constantFrom(u, `page:${u}`, `notebook:${u}`, `user:${u}`, `section:${u}`)).chain((a) => a) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constantFrom('error', 'unhandledrejection', 'x'), name: fc.string(), frames: fc.array(fc.string()) }) },
  { weight: 1, arbitrary: fc.record({ remoteUrl: fc.string(), branch: fc.string(), auth: fc.constantFrom(...v.GIT_AUTH_MODES, 'sudo') }) },
  { weight: 1, arbitrary: fc.array(fc.nat({ max: 1200 }), { maxLength: 20 }) },
  { weight: 1, arbitrary: fc.uint8Array({ maxLength: 16 }) },
)

const total = (name: string, check: (x: unknown) => boolean) =>
  it(`T-F4A-1${name}: never throws`, () => {
    fc.assert(
      fc.property(input, (x) => {
        expect(typeof check(x)).toBe('boolean')
      }),
      fcParams,
    )
  })

/** Each validator, and what an accepted value must satisfy beyond its type. */
const CASES: Array<[string, (x: unknown) => boolean, (x: unknown) => boolean]> = [
  ['isId', v.isId, (x) => typeof x === 'string' && STRICT_UUID.test(x)],
  ['isDocId', v.isDocId, (x) => typeof x === 'string' && /^(page|notebook):/.test(x) && STRICT_UUID.test(x.slice(x.indexOf(':') + 1))],
  ['isSavedThemeId', v.isSavedThemeId, (x) => typeof x === 'string' && STRICT_UUID.test(x.slice('user:'.length))],
  ['isDocPrefix', v.isDocPrefix, (x) => x === '' || x === 'page:' || x === 'notebook:'],
  ['isText', (x) => v.isText(x), (x) => typeof x === 'string' && x.length <= v.MAX_STRING],
  ['isText(MAX_PATH)', (x) => v.isText(x, v.MAX_PATH), (x) => typeof x === 'string' && x.length <= v.MAX_PATH],
  ['isBool', v.isBool, (x) => typeof x === 'boolean'],
  ['isObject', v.isObject, (x) => typeof x === 'object' && x !== null && !Array.isArray(x)],
  ['isCount', (x) => v.isCount(x), (x) => Number.isInteger(x) && (x as number) >= 1 && (x as number) <= v.MAX_ROWS],
  ['isBytes', (x) => v.isBytes(x, 8), (x) => x instanceof Uint8Array && x.byteLength <= 8],
  ['isAnyBytes', v.isAnyBytes, (x) => x instanceof Uint8Array],
  ['isOneOf', (x) => v.isOneOf(v.RESOLVE_CHOICES, x), (x) => (v.RESOLVE_CHOICES as readonly unknown[]).includes(x)],
  ['isTextList', (x) => v.isTextList(x, 4, 3), (x) => Array.isArray(x) && x.length <= 3 && x.every((s) => typeof s === 'string' && s.length <= 4)],
  ['optional', (x) => v.optional(x, v.isBool), (x) => x === undefined || typeof x === 'boolean'],
  [
    'isRendererErrorReport',
    v.isRendererErrorReport,
    (x) => {
      const r = x as Record<string, unknown>
      return Object.keys(r).length === 3 && typeof r.name === 'string' && r.name.length <= 200 && Array.isArray(r.frames) && r.frames.length <= 100 && r.frames.every((f) => typeof f === 'string' && f.length <= v.MAX_PATH)
    },
  ],
  ['isSettingsPatch', v.isSettingsPatch, (x) => typeof x === 'object' && x !== null],
  [
    'isGitSettings',
    v.isGitSettings,
    (x) => {
      const g = x as Record<string, unknown>
      return typeof g.remoteUrl === 'string' && g.remoteUrl.length <= v.MAX_PATH && typeof g.branch === 'string' && g.branch.length <= 200 && (v.GIT_AUTH_MODES as readonly unknown[]).includes(g.auth)
    },
  ],
  [
    'isSyncConfig',
    v.isSyncConfig,
    (x) => {
      const c = x as Record<string, unknown>
      return (c.provider === null || (v.SYNC_PROVIDERS as readonly unknown[]).includes(c.provider)) && (c.token === undefined || (typeof c.token === 'string' && c.token.length <= 500))
    },
  ],
  ['isMenuPath', v.isMenuPath, (x) => Array.isArray(x) && x.length >= 1 && x.length <= 16 && x.every((i) => Number.isInteger(i) && i >= 0 && i < 1000)],
]

describe('F4a: the IPC validators are total and keep their caps', () => {
  CASES.forEach(([name, check], i) => total(`${i.toString().padStart(2, '0')} ${name}`, check))

  it('T-F4A-30: an accepted value is within the caps the validator names', () => {
    fc.assert(
      fc.property(input, (x) => {
        for (const [name, check, within] of CASES) if (check(x)) expect(within(x), name).toBe(true)
      }),
      fcParams,
    )
  })

  it('T-F4A-31: a value one past each cap is refused', () => {
    expect(v.isText('x'.repeat(v.MAX_STRING + 1))).toBe(false)
    expect(v.isBytes(new Uint8Array(9), 8)).toBe(false)
    expect(v.isTextList(new Array<string>(v.MAX_LIST + 1).fill(''))).toBe(false)
    expect(v.isCount(v.MAX_ROWS + 1)).toBe(false)
  })
})
