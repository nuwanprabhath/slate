import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { redact, redactString } from './redact'
import { fcParams, fcRuns } from '../../test/fuzz'

// F4e: properties of log redaction (shared/redact.ts) over generated credentials, noise and graphs.
// The generators are exported for FX-3, which reuses them to measure how redactString's cost grows
// with input size (M3).

export interface Secret {
  /** The whole credential as written. */
  full: string
  /** The part that must not survive: what follows the prefix, or the value of a pair. */
  body: string
  /** Pieces of the body that must also be gone (a PEM block's lines). */
  parts?: string[]
}

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/_-'
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
/** Characters a `password=` value may hold: anything but whitespace, `"`, `&`, `,` and `}`. */
const VALUE_CHARS = `${ALNUM}!#$%'()*+-./:;<=>?@[\\]^_\`{|~`

/** A string over `alphabet`, one character a unit so fast-check shrinks it character by character. */
export const chars = (alphabet: string, min: number, max: number): fc.Arbitrary<string> =>
  fc.string({ unit: fc.constantFrom(...alphabet.split('')), minLength: min, maxLength: max })

const prefixed = (prefix: string | fc.Arbitrary<string>, alphabet: string, min: number, max: number): fc.Arbitrary<Secret> =>
  fc.tuple(typeof prefix === 'string' ? fc.constant(prefix) : prefix, chars(alphabet, min, max)).map(([p, body]) => ({ full: p + body, body }))

const segment = chars('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-', 10, 40)

/** One generator per `SECRETS` row (same order), then the base64 rule. */
export const SECRET_SHAPES: Record<string, fc.Arbitrary<Secret>> = {
  'API key': prefixed(fc.constantFrom('sk-ant-', 'sk-'), `${ALNUM}_-`, 16, 80),
  'github_pat_': prefixed('github_pat_', `${ALNUM}_`, 16, 80),
  'gh[pousr]_ token': prefixed(fc.constantFrom('ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_'), ALNUM, 16, 60),
  'GitLab token': prefixed('glpat-', `${ALNUM}_-`, 16, 60),
  JWT: fc.tuple(segment, segment, segment).map(([a, b, c]) => ({ full: `eyJ${a}.${b}.${c}`, body: `eyJ${a}.${b}.${c}` })),
  'Bearer / Basic header': fc
    .tuple(fc.constantFrom('Bearer', 'Basic', 'bearer', 'BASIC', 'BeArEr'), fc.constantFrom(' ', '  ', '\t'), chars(`${ALNUM}._~+/=-`, 8, 64))
    .map(([scheme, gap, body]) => ({ full: scheme + gap + body, body })),
  'password= pair': fc
    .tuple(
      fc.constantFrom('api_key', 'api-key', 'apikey', 'secret', 'password', 'passwd', 'token', 'auth', 'PASSWORD', 'Token'),
      fc.constantFrom('=', ':', ' = ', ': ', ' :'),
      fc.constantFrom('', '"'),
      chars(VALUE_CHARS, 6, 40),
    )
    .map(([key, sep, quote, body]) => ({ full: `${key}${sep}${quote}${body}${quote}`, body })),
  'scheme://user:password@': fc
    .tuple(fc.constantFrom('https', 'http', 'ssh', 'git+ssh', 'ftp'), chars(`${ALNUM}-_.`, 1, 20), chars(VALUE_CHARS.replace(/\//g, '').replace(/@/g, ''), 6, 30), chars('abcdefghijklmnopqrstuvwxyz.', 3, 20))
    .map(([scheme, user, body, host]) => ({ full: `${scheme}://${user}:${body}@${host}`, body })),
  AWS: chars('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 16, 16).map((tail) => ({ full: `AKIA${tail}`, body: `AKIA${tail}` })),
  Slack: prefixed(fc.constantFrom('xoxa-', 'xoxb-', 'xoxp-', 'xoxo-', 'xoxs-', 'xoxr-'), `${ALNUM}-`, 10, 40),
  npm: prefixed('npm_', ALNUM, 30, 60),
  'PEM private key': fc
    .tuple(fc.constantFrom('RSA ', 'EC ', 'OPENSSH ', 'ENCRYPTED ', ''), fc.array(chars(`${ALNUM}+/=`, 16, 64), { minLength: 1, maxLength: 8 }))
    .map(([label, lines]) => {
      const inner = lines.join('\n')
      return { full: `-----BEGIN ${label}PRIVATE KEY-----\n${inner}\n-----END ${label}PRIVATE KEY-----`, body: inner, parts: lines }
    }),
  // 32+ hex digits, but never exactly 40 (a git object id).
  hex: fc
    .tuple(fc.oneof(fc.integer({ min: 32, max: 39 }), fc.integer({ min: 41, max: 128 })), fc.constantFrom('0123456789abcdef', '0123456789ABCDEF', '0123456789abcdefABCDEF'))
    .chain(([n, alphabet]) => chars(alphabet, n, n))
    .map((body) => ({ full: body, body })),
  // Meets `looksLikeBase64`: 43+ characters need an upper and a lower case letter; 22 to 42 need all three classes.
  base64: fc.oneof(
    fc
      .tuple(chars(BASE64_CHARS, 41, 200), fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')), fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), fc.constantFrom('', '=', '=='))
      .map(([mid, up, low, pad]) => `${up}${low}${mid}${pad}`),
    fc
      .tuple(chars(BASE64_CHARS, 19, 39), fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')), fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), fc.constantFrom(...'0123456789'.split('')))
      .map(([mid, up, low, digit]) => `${up}${low}${digit}${mid}`),
  ).map((body) => ({ full: body, body })),
}

/**
 * Noise that cannot extend or break a secret: it holds no character any rule's run can contain, so
 * the secret keeps its `\b` boundaries. Words stand in for log prose.
 */
const words = fc.constantFrom('sync', 'failed', 'error:', 'at', 'remote', 'push', 'page', 'opened', 'fatal:', 'could', 'not', 'read', 'from')
const punct = fc.string({ unit: fc.constantFrom(...' \n\t"\'()[]{}<>;!?|*'.split('')), maxLength: 8 })
export const noise: fc.Arbitrary<string> = fc.array(fc.oneof(words, punct), { maxLength: 8 }).map((xs) => xs.join(' '))

/** A secret with noise either side, and the separators that keep it a token of its own. */
export const placed = (secret: fc.Arbitrary<Secret>): fc.Arbitrary<{ text: string; secret: Secret }> =>
  fc.tuple(noise, secret, noise).map(([pre, s, post]) => ({ text: `${pre} ${s.full} ${post}`, secret: s }))

/** Text in the shapes redaction must leave alone. */
export const harmless: fc.Arbitrary<string> = fc
  .array(
    fc.oneof(
      fc.uuid(),
      fc.uuid().map((u) => u.toUpperCase()),
      chars('0123456789abcdef', 40, 40),
      chars('abcdefghijklmnopqrstuvwxyz', 1, 20),
      words,
    ),
    { minLength: 1, maxLength: 20 },
  )
  .map((xs) => xs.join(' '))

/** Anything a log call might be handed, plus cycles and byte containers hung off it. */
class Holder {
  public readonly label = 'holder'
  constructor(public inner: unknown) {}
  get derived(): string {
    return 'derived'
  }
}
class FailedPush extends Error {}

const byteContainers: (() => unknown)[] = [
  () => new Uint8Array([1, 2, 3]),
  () => new TextEncoder().encode('ghp_aaaaaaaaaaaaaaaaaaaa'),
  () => new Float64Array([1.5]),
  () => new BigInt64Array(2),
  () => new DataView(new ArrayBuffer(4)),
  () => new ArrayBuffer(8),
  () => new SharedArrayBuffer(8),
]

export function deepChain(depth: number, leaf: unknown): unknown {
  let node = leaf
  for (let i = 0; i < depth; i++) node = i % 2 === 0 ? [node] : { next: node }
  return node
}

export const graph: fc.Arbitrary<unknown> = fc.oneof(
  fc.anything({ withTypedArray: true, withMap: true, withSet: true, withNullPrototype: true, withBigInt: true, withDate: true, withSparseArray: true, withBoxedValues: true }),
  fc
    .tuple(fc.anything({ withTypedArray: true, withMap: true, withSet: true, withBigInt: true }), fc.constantFrom(...byteContainers.keys()), fc.string(), fc.boolean())
    .map(([any, which, message, nest]) => {
      const root: Record<string, unknown> = { any, bytes: byteContainers[which]!(), err: new FailedPush(message, { cause: new Error(message) }) }
      root['self'] = root
      root['list'] = [root, any, byteContainers[which]!()]
      root['map'] = new Map<unknown, unknown>([[root, byteContainers[which]!()]])
      root['set'] = new Set<unknown>([root, byteContainers[which]!()])
      root['holder'] = new Holder(root)
      root['fn'] = () => message
      root['sym'] = Symbol(message)
      return nest ? [root, { root }] : root
    }),
  fc.tuple(fc.integer({ min: 1, max: 1000 }), fc.constantFrom(...byteContainers.keys()), chars(ALNUM, 16, 40)).map(([depth, which, token]) => deepChain(depth, { bytes: byteContainers[which]!(), token: `ghp_${token}` })),
)

/** Every byte container reachable in `value`, found without recursion (a depth-1000 result must not overflow us). */
export function holdsBytes(value: unknown): boolean {
  const seen = new Set<unknown>()
  const stack: unknown[] = [value]
  while (stack.length > 0) {
    const v = stack.pop()
    if (typeof v !== 'object' || v === null || seen.has(v)) continue
    if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer || v instanceof SharedArrayBuffer) return true
    seen.add(v)
    stack.push(...Object.values(v), Object.getPrototypeOf(v))
  }
  return false
}

const MAX_SUFFIX = '…[+99999 chars]'.length

describe('T-F4E-01: no credential survives, wherever it sits', () => {
  for (const [name, shape] of Object.entries(SECRET_SHAPES)) {
    it(`${name}: the body is gone`, () => {
      fc.assert(
        fc.property(placed(shape), ({ text, secret }) => {
          const out = redactString(text)
          expect(out, `redactString(${JSON.stringify(text)})`).not.toContain(secret.body)
          for (const part of secret.parts ?? []) expect(out).not.toContain(part)
        }),
        fcParams,
      )
    })
  }

  it('every shape at once, in one string', () => {
    fc.assert(
      fc.property(fc.array(placed(fc.oneof(...Object.values(SECRET_SHAPES))), { minLength: 1, maxLength: 6 }), (items) => {
        const out = redactString(items.map((i) => i.text).join('\n'))
        for (const { secret } of items) expect(out).not.toContain(secret.body)
      }),
      fcParams,
    )
  })
})

describe('T-F4E-02: output length', () => {
  it('is at most 512 characters plus the truncation suffix, for any input up to 4 KiB', () => {
    const big = fc.oneof(
      fc.string({ unit: 'binary', maxLength: 4096 }),
      fc.string({ unit: 'grapheme-ascii', maxLength: 4096 }),
      fc.array(placed(fc.oneof(...Object.values(SECRET_SHAPES))), { maxLength: 40 }).map((xs) => xs.map((x) => x.text).join(' ').slice(0, 4096)),
      fc.integer({ min: 0, max: 4096 }).map((n) => 'a'.repeat(n)),
    )
    fc.assert(
      fc.property(big, (input) => {
        const out = redactString(input)
        expect(out.length).toBeLessThanOrEqual(512 + MAX_SUFFIX)
        if (out.length > 512) expect(out.slice(512)).toMatch(/^…\[\+\d{1,5} chars\]$/)
      }),
      fcParams,
    )
  })
})

describe('T-FX3-02: the scan bound (M3) leaves no kept secret unredacted', () => {
  it('a secret starting anywhere in the kept 512 characters, before a 32 KiB tail, is gone', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 511 }), fc.oneof(...Object.values(SECRET_SHAPES)), (at, secret) => {
        const out = redactString(`${' '.repeat(at)}${secret.full} ${'sync failed '.repeat(2800)}`)
        expect(out).toMatch(/…\[\+\d+ chars\]$/)
        expect(out).not.toContain(secret.body)
        for (const part of secret.parts ?? []) expect(out).not.toContain(part)
      }),
      fcRuns(4),
    )
  })
})

describe('T-F4E-03: harmless text passes through', () => {
  it('UUIDs, git ids and ordinary words are unchanged', () => {
    fc.assert(
      fc.property(harmless, (text) => {
        expect(redactString(text)).toBe(text)
      }),
      fcParams,
    )
  })
})

describe('T-F4E-04: redact(graph)', () => {
  it('terminates without throwing and holds no byte container', () => {
    fc.assert(
      fc.property(graph, (value) => {
        const out = redact(value)
        expect(holdsBytes(out)).toBe(false)
      }),
      { ...fcParams, numRuns: Math.max(200, Math.floor(fcParams.numRuns / 4)) },
    )
  })

  it('redacts a secret at the bottom of a depth-1000 chain', () => {
    fc.assert(
      fc.property(chars(ALNUM, 16, 40), (token) => {
        const out = redact(deepChain(1000, { token: `ghp_${token}` }))
        expect(JSON.stringify(out)).not.toContain(token)
      }),
      { ...fcParams, numRuns: Math.max(20, Math.floor(fcParams.numRuns / 40)) },
    )
  })

  it('detects a byte container when one is present (the walker is not vacuous)', () => {
    expect(holdsBytes({ a: [new Uint8Array(1)] })).toBe(true)
    expect(holdsBytes({ a: [new ArrayBuffer(1)] })).toBe(true)
    expect(holdsBytes({ a: ['x', { b: 1 }] })).toBe(false)
  })
})

describe('T-F4E-05: idempotence (candidate)', () => {
  it('redacting redacted text changes nothing', () => {
    // Open finding F4E-1: a result that was truncated is not a fixed point (the second pass sees the
    // suffix's length and rewrites the count), so inputs here stay short enough not to truncate.
    const any = fc.oneof(
      fc.string({ unit: 'binary', maxLength: 200 }),
      fc.array(placed(fc.oneof(...Object.values(SECRET_SHAPES))), { maxLength: 2 }).map((xs) => xs.map((x) => x.text).join(' ').slice(0, 200)),
    )
    fc.assert(
      fc.property(any, (input) => {
        const once = redactString(input)
        expect(redactString(once)).toBe(once)
      }),
      fcParams,
    )
  })
})
