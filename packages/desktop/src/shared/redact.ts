/**
 * What a diagnostic log is allowed to contain.
 *
 * A log people are asked to send to someone else is a privacy decision before it is a debugging
 * tool. Nothing is logged unless it was passed as a structured field, and every string field goes
 * through this. Page text, box text, titles and search queries are never passed in the first
 * place: no amount of scrubbing makes a notebook safe to hand over, so it is simply not written.
 *
 * What this removes from the things that *are* written:
 *
 * - **The user's name**, which is in nearly every path: `/Users/ann/x` becomes `~/x`.
 * - **Credentials**, in the shapes they take: API keys, GitHub tokens (`ghp_`, `github_pat_`),
 *   bearer headers, `password=`/`token=` pairs, JWTs and `https://user:pass@` remotes (a failed
 *   git command echoes the remote back).
 * - **Anything very long**, truncated.
 *
 * Pure and in `shared/` so both processes redact identically.
 */

/** Longer than this and a field is a payload, not a diagnostic. */
const MAX_STRING = 512

/**
 * Secret shapes, checked before path rewriting so a token containing a slash is not mangled into
 * something that no longer matches. Each is deliberately narrow: a rule that redacts too much
 * makes the log useless, and a log nobody can read gets turned off.
 */
const SECRETS: { pattern: RegExp; as: string }[] = [
  { pattern: /\b(sk-ant-|sk-)[A-Za-z0-9_-]{16,}/g, as: '[redacted-api-key]' },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{16,}/g, as: '[redacted-github-token]' },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, as: '[redacted-github-token]' },
  { pattern: /\bglpat-[A-Za-z0-9_-]{16,}/g, as: '[redacted-gitlab-token]' },
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, as: '[redacted-jwt]' },
  { pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, as: '$1 [redacted]' },
  { pattern: /\b(api[-_]?key|secret|password|passwd|token|auth)\s*[=:]\s*("?)[^\s"&,}]{4,}\2/gi, as: '$1=[redacted]' },
  // `scheme://user:password@host`: a git remote, or a git failure that echoes one back.
  { pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, as: '$1[redacted]@' },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, as: '[redacted-aws-key]' },
  { pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, as: '[redacted-slack-token]' },
  { pattern: /\bnpm_[A-Za-z0-9]{30,}/g, as: '[redacted-npm-token]' },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, as: '[redacted-private-key]' },
  // Raw key material written out as text (audit Z-2): 32+ hex digits is a 128-bit key or more. A run
  // of exactly 40 is a git object id, which the sync log names on purpose.
  { pattern: /\b(?![0-9a-f]{40}\b)[0-9a-f]{32,}\b/gi, as: '[redacted-hex]' },
]

/**
 * A base64 or base64url run long enough for a 128-bit key (22+ characters). A run of 43+ (256 bits)
 * needs two of upper case, lower case and digits; a shorter one needs all three, or `=` padding, so
 * identifiers, words, UUIDs and lower-case paths stay readable. The thresholds are pinned by
 * packages/desktop/test/spec/redact.test.ts.
 */
const BASE64_RUN = /[A-Za-z0-9+\/_-]{22,}={0,2}/g
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const looksLikeBase64 = (run: string): boolean => {
  if (UUID.test(run)) return false
  const classes = [/[A-Z]/, /[a-z]/, /[0-9]/].filter((re) => re.test(run)).length
  return run.replace(/=+$/, '').length >= 43 ? classes >= 2 : classes === 3 || run.endsWith('=')
}

/** `/Users/someone/...` and `/home/someone/...`, whoever they are. */
const HOME_LIKE = /(^|[\s"'(=])(\/(?:Users|home)\/[^/\s"')]+)/g

export interface RedactOptions {
  /** The running user's home directory, rewritten to `~` wherever it appears. */
  home?: string | undefined
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Redacts one string: secrets first, then home directories, then length. */
export function redactString(value: string, { home }: RedactOptions = {}): string {
  let out = value
  for (const { pattern, as } of SECRETS) out = out.replace(pattern, as)
  out = out.replace(BASE64_RUN, (run) => (looksLikeBase64(run) ? '[redacted-base64]' : run))
  if (home !== undefined && home !== '') out = out.replace(new RegExp(escapeRe(home), 'g'), '~')
  // Any other account's home directory too: a path from a synced device is still somebody's name.
  out = out.replace(HOME_LIKE, '$1~')
  return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}…[+${String(out.length - MAX_STRING)} chars]` : out
}

/**
 * Redacts a whole structured value, recursively. Anything that is not a string, number, boolean
 * or null is described rather than serialised: an unknown object is where something unintended
 * would hide. Cycles are cut rather than thrown on.
 */
export function redact(value: unknown, options: RedactOptions = {}, seen = new Set<unknown>()): unknown {
  if (typeof value === 'string') return redactString(value, options)
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (value === undefined) return undefined
  if (value instanceof Error) return { name: value.name, message: redactString(value.message, options) }
  if (typeof value !== 'object') return `[${typeof value}]`
  // Bytes are never written, whatever they hold: a KeyRing key in a state object would otherwise
  // be walked as `{ "0": 154, … }` (red team final F-1).
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)) return '[bytes]'
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  if (Array.isArray(value)) {
    const items = value.slice(0, 50).map((v) => redact(v, options, seen))
    return value.length > 50 ? [...items, `[+${String(value.length - 50)} more]`] : items
  }
  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined) continue
    out[key] = redact(v, options, seen)
  }
  return out
}
