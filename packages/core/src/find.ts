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
