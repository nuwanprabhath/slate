export interface FindOptions {
  matchCase: boolean
  wholeWord: boolean
  regex: boolean
}

// Letters, digits, combining marks and `_`, as VS Code's whole-word search treats them.
const WORD_BEFORE = /[\p{L}\p{N}\p{M}_]$/u
const WORD_AFTER = /^[\p{L}\p{N}\p{M}_]/u

/** The query as a global regex, or null when it is empty or not a valid regular expression. */
export function compileQuery(query: string, opts: FindOptions): RegExp | null {
  if (query === '') return null
  const source = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // A pattern whose own groups repeat unboundedly takes exponential time to fail, and the in-page find
  // matches on the renderer thread, so one would freeze the window (`editor/src/find.ts`). Refused like
  // a pattern that will not parse, which the find bar already shows as an error.
  if (opts.regex && (hasNestedUnboundedQuantifier(source) || hasSuperLinearShape(source))) return null
  try {
    return new RegExp(source, opts.matchCase ? 'gu' : 'giu')
  } catch {
    return null
  }
}

/** `[from, to)` ranges of non-empty matches in `text`. */
export function findMatches(text: string, query: string, opts: FindOptions): Array<[number, number]> {
  const re = compileQuery(query, opts)
  return re ? matchAll(text, re, opts.wholeWord) : []
}

/** `findMatches` with a query compiled once, for callers that match many texts. */
export function matchAll(text: string, re: RegExp, wholeWord: boolean): Array<[number, number]> {
  const out: Array<[number, number]> = []
  re.lastIndex = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const from = m.index
    const to = from + m[0].length
    if (to === from) {
      // A zero-length match would never advance; step over one code point.
      re.lastIndex = from + ((text.codePointAt(from) ?? 0) > 0xffff ? 2 : 1)
      continue
    }
    if (wholeWord && (WORD_BEFORE.test(text.slice(Math.max(0, from - 2), from)) || WORD_AFTER.test(text.slice(to, to + 2)))) {
      // Retry from the next character: a later, shorter match may still sit on word boundaries.
      re.lastIndex = from + 1
      continue
    }
    out.push([from, to])
  }
  return out
}

/** A quantifier at `i`, with whether it allows unboundedly many repetitions. */
function quantifierAt(source: string, i: number): { length: number; unbounded: boolean } | null {
  const c = source[i]
  if (c === '*' || c === '+') return { length: source[i + 1] === '?' ? 2 : 1, unbounded: true }
  if (c === '?') return { length: source[i + 1] === '?' ? 2 : 1, unbounded: false }
  if (c !== '{') return null
  const m = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(i))
  if (!m) return null
  const lazy = source[i + m[0].length] === '?' ? 1 : 0
  return { length: m[0].length + lazy, unbounded: m[2] !== undefined && m[3] === '' }
}

/**
 * A repeat of a group that itself repeats unboundedly (`(a+)+`, `(a*)*`). Those patterns take time
 * exponential in the subject's length to fail, so a caller running a user's pattern over stored text
 * refuses them rather than hanging the process.
 */
export function hasNestedUnboundedQuantifier(source: string): boolean {
  const stack: boolean[] = [false]
  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    if (c === '\\') {
      i++
      continue
    }
    if (c === '[') {
      while (i < source.length && source[i] !== ']') i += source[i] === '\\' ? 2 : 1
      continue
    }
    if (c === '(') {
      stack.push(false)
      continue
    }
    const quantifier = quantifierAt(source, c === ')' ? i + 1 : i)
    if (c === ')') {
      const inner = stack.length > 1 ? stack.pop()! : false
      if (quantifier?.unbounded && inner) return true
    }
    if (!quantifier) continue
    if (quantifier.unbounded) stack[stack.length - 1] = true
    i += quantifier.length - (c === ')' ? 0 : 1)
  }
  return false
}

/** What a piece of a pattern can do, over a set of probe characters (bit i is `probes[i]`). */
interface Shape {
  nullable: boolean
  first: bigint
  chars: bigint
  // Consumes unboundedly many characters (`a+`, `.*`, a backreference).
  unbounded: boolean
  // The one length it matches, or null when it can match several (`a{1,6}`, `b?`, `(a|bc)`): a repeat of
  // such a piece can split one text many ways.
  width: number | null
  // Holds an alternation whose branches can start on the same character, or one that can be empty.
  ambiguousAlt: boolean
}

const EMPTY: Shape = { nullable: true, first: 0n, chars: 0n, unbounded: false, width: 0, ambiguousAlt: false }
// A repeat this many times or more of an ambiguous body is refused: `(.*a){3}` is already cubic.
const REPEAT_LIMIT = 3
const BASE_PROBES = 'aAbBzZ09_ -.,!?:;/\\@#\n\t\'"()[]{}éßΩ€😀'

/**
 * A pattern that can take super-linear time to fail (finding M1): overlapping alternation under a
 * repeat (`(a|a)+`, `(a|aa)+`), a repeat of a body that itself consumes unboundedly (`(.*a){12}`),
 * a repeat of a body that can match empty or not (`(a?)*`), and two overlapping unbounded pieces with
 * only optional or swallowable ones between (`a*a*`, `.*\s*`, `a.*b.*c`). It over-refuses on purpose (`(cat|car)+`: both
 * branches start with `c`) and cannot be complete; it is a stopgap until a person's pattern runs
 * where it can be stopped. False for a pattern it cannot parse, which `new RegExp` then refuses.
 */
export function hasSuperLinearShape(source: string): boolean {
  const probes = [...new Set([...BASE_PROBES, ...source])]
  const ALL = (1n << BigInt(probes.length)) - 1n
  const leaf = (src: string): Shape => {
    let mask = ALL
    try {
      const re = new RegExp(`^(?:${src})$`, 'iu')
      mask = 0n
      probes.forEach((p, n) => {
        if (re.test(p)) mask |= 1n << BigInt(n)
      })
    } catch {
      // An escape this walk does not know: assume it matches anything.
    }
    return { nullable: false, first: mask, chars: mask, unbounded: false, width: 1, ambiguousAlt: false }
  }
  let i = 0
  let danger = false
  let broken = false

  const parseAlt = (): Shape => {
    const branches = [parseSeq()]
    while (source[i] === '|') {
      i++
      branches.push(parseSeq())
    }
    if (branches.length === 1) return branches[0] ?? EMPTY
    let ambiguous = branches.some((b) => b.ambiguousAlt || b.nullable)
    branches.forEach((a, n) => {
      for (const b of branches.slice(n + 1)) if ((a.first & b.first) !== 0n) ambiguous = true
    })
    return {
      nullable: branches.some((b) => b.nullable),
      first: branches.reduce((m, b) => m | b.first, 0n),
      chars: branches.reduce((m, b) => m | b.chars, 0n),
      unbounded: branches.some((b) => b.unbounded),
      width: branches.every((b) => b.width !== null && b.width === branches[0]?.width) ? (branches[0]?.width ?? null) : null,
      ambiguousAlt: ambiguous,
    }
  }

  const parseSeq = (): Shape => {
    const items: Shape[] = []
    while (i < source.length && source[i] !== '|' && source[i] !== ')' && !broken) items.push(parseQuantified())
    items.forEach((a, n) => {
      if (!a.unbounded) return
      for (const b of items.slice(n + 1)) {
        if (b.unbounded && (a.chars & b.chars) !== 0n) danger = true
        // A piece the first one cannot swallow (`@` after `\w+`) ends the ambiguity; one it can (`b` after `.*`) does not.
        if (!b.nullable && (a.chars & b.chars) === 0n) break
      }
    })
    let first = 0n
    for (const it of items) {
      first |= it.first
      if (!it.nullable) break
    }
    return {
      nullable: items.every((it) => it.nullable),
      first,
      chars: items.reduce((m, it) => m | it.chars, 0n),
      unbounded: items.some((it) => it.unbounded),
      width: items.reduce<number | null>((w, it) => (w === null || it.width === null ? null : w + it.width), 0),
      ambiguousAlt: items.some((it) => it.ambiguousAlt),
    }
  }

  const parseQuantified = (): Shape => {
    const body = parseAtom()
    const bounds = /^(?:([*+?])|\{(\d+)(?:(,)(\d*))?\})\??/.exec(source.slice(i))
    if (!bounds) return body
    i += bounds[0].length
    const min = bounds[1] === '+' ? 1 : bounds[1] ? 0 : Number(bounds[2])
    const max = bounds[1] === '?' ? 1 : bounds[1] ? Infinity : bounds[3] === undefined ? min : bounds[4] === '' ? Infinity : Number(bounds[4])
    if (max >= REPEAT_LIMIT && body.chars !== 0n && (body.width === null || body.unbounded || body.ambiguousAlt || body.nullable)) danger = true
    return {
      nullable: min === 0 || body.nullable,
      first: body.first,
      chars: body.chars,
      unbounded: body.unbounded || (max === Infinity && body.chars !== 0n),
      width: body.width === 0 ? 0 : body.width === null || min !== max ? null : body.width * min,
      ambiguousAlt: body.ambiguousAlt,
    }
  }

  const parseAtom = (): Shape => {
    const rest = source.slice(i)
    const c = rest[0]
    if (c === '(') {
      const head = /^\((?:\?(?::|=|!|<=|<!|<[^>=!]*>))?/.exec(rest)?.[0] ?? '('
      if (rest[1] === '?' && head === '(') {
        broken = true
        return EMPTY
      }
      i += head.length
      const inner = parseAlt()
      if (source[i] !== ')') {
        broken = true
        return EMPTY
      }
      i++
      // A lookaround consumes nothing; its own body was still checked.
      return ['(?=', '(?!', '(?<=', '(?<!'].includes(head) ? EMPTY : inner
    }
    if (c === '[') {
      const m = /^\[\^?(?:\\[\s\S]|[^\]\\])*\]/.exec(rest)
      if (!m) {
        broken = true
        return EMPTY
      }
      i += m[0].length
      return leaf(m[0])
    }
    if (c === '^' || c === '$' || /^\\[bB]/.test(rest)) {
      i += c === '\\' ? 2 : 1
      return EMPTY
    }
    const ref = /^\\(?:[1-9]\d*|k<[^>]*>)/.exec(rest)
    if (ref) {
      i += ref[0].length
      return { nullable: true, first: ALL, chars: ALL, unbounded: true, width: null, ambiguousAlt: false }
    }
    if (c === '\\') {
      const esc = /^\\(?:[pP]\{[^}]*\}|u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|c[A-Za-z]|[\s\S])/.exec(rest)?.[0] ?? '\\'
      i += esc.length
      return leaf(esc)
    }
    if (/^[*+?{]/.test(rest) && quantifierAt(source, i)) {
      broken = true
      return EMPTY
    }
    const cp = String.fromCodePoint(rest.codePointAt(0) ?? 0)
    i += cp.length
    return leaf(cp === '.' ? '.' : cp.replace(/[*+?^${}()|[\]\\/]/g, '\\$&'))
  }

  while (i < source.length && !broken) {
    parseAlt()
    if (source[i] === ')') broken = true
  }
  return danger && !broken
}
