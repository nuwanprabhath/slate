export type LinkInput = { href: string } | { error: string }

const SAFE_SCHEMES = new Set(['http', 'https', 'mailto'])
// "example.com:8080/x" is a host and port, not a scheme.
const HOST_PORT = /^[^/?#:]+:\d+(?:[/?#]|$)/
const DOMAIN_OR_PATH = /^(?:localhost|[\w-]+(?:\.[\w-]+)+)(?::\d+)?(?:[/?#]\S*)?$/i

/**
 * Turns what the user typed into a link target. Browsers ignore tabs and newlines inside a
 * scheme, so `java\tscript:` is checked as `javascript:`.
 */
export function normalizeLinkInput(raw: string): LinkInput {
  const text = raw.trim()
  if (!text) return { error: 'Enter a web address' }
  const squashed = text.replace(/[\s\u0000-\u001f]/g, '')
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(squashed)
  if (scheme && !HOST_PORT.test(squashed)) {
    if (!SAFE_SCHEMES.has(scheme[1].toLowerCase())) return { error: `Links can't use ${scheme[1].toLowerCase()}:` }
    return { href: text }
  }
  if (!DOMAIN_OR_PATH.test(text)) return { error: 'Enter a web address' }
  return { href: `https://${text}` }
}

/** Whether pasted text is exactly one http(s) or mailto URL, the case that links a selection. */
export function isSingleUrl(text: string): boolean {
  const t = text.trim()
  return /^(?:https?:\/\/|mailto:)\S+$/i.test(t)
}
