// Hostile HTML and URLs for the paste and copy paths, and the oracle that says what in a parsed tree could run.
import fc from 'fast-check'

const TAGS = ['p', 'b', 'i', 'a', 'img', 'div', 'span', 'table', 'tr', 'td', 'li', 'ul', 'ol', 'pre', 'code', 'svg', 'math', 'script', 'style', 'iframe', 'object', 'embed', 'form', 'textarea', 'title', 'template', 'noscript', 'select', 'option', 'foreignObject', 'mglyph', 'malignmark', 'annotation-xml', 'base', 'meta', 'link']
const ATTRS = ['href', 'src', 'xlink:href', 'action', 'formaction', 'data', 'style', 'class', 'onerror', 'onload', 'onclick', 'OnMouseOver', 'srcdoc', 'width', 'data-color', 'is', 'id']

const SCHEMES = ['javascript', 'vbscript', 'data', 'file', 'http', 'https', 'mailto', 'slate-image', 'app']

/** A scheme spelt the ways a browser still reads as that scheme: mixed case, split by tab or newline, entity-encoded. */
const schemeSpelling = fc.tuple(fc.constantFrom(...SCHEMES), fc.array(fc.nat(), { maxLength: 4 }), fc.boolean()).map(([scheme, ops, entity]) => {
  let s = [...scheme]
  for (const op of ops) {
    const at = op % (s.length + 1)
    const kind = op % 4
    if (kind === 0) s.splice(at, 0, '\t')
    else if (kind === 1) s.splice(at, 0, '\n')
    else if (kind === 2 && s[at]) s[at] = s[at]!.toUpperCase()
    else if (kind === 3 && s[at] && entity) s[at] = `&#${s[at]!.charCodeAt(0)};`
  }
  if (entity && s[0]) s = [`&#x${s[0].charCodeAt(0).toString(16)};`, ...s.slice(1)]
  return s.join('')
})

export const hostileUrl: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom('', ' ', '\u0001', '\u0000 ', '\t'),
    schemeSpelling,
    fc.constantFrom(':', '&colon;', '&#58;', '%3a'),
    fc.constantFrom('', '//', '//user:pass@', '//evil.example@'),
    fc.constantFrom('alert(1)', 'example.com/', '../../etc/passwd', '%2e%2e%2f%2e%2e%2f', 'text/html,<script>alert(1)</script>', 'abc123', 'a?b=c#d'),
  )
  .map((parts) => parts.join(''))

const attribute = fc.tuple(fc.constantFrom(...ATTRS), fc.oneof(hostileUrl, fc.constantFrom('alert(1)', 'x', '', 'color: red; background: url(javascript:alert(1))')), fc.constantFrom('"', "'", '')).map(([name, value, q]) => (q === '' ? ` ${name}=${value.replace(/[\s>]/g, '')}` : ` ${name}=${q}${value.split(q).join('')}${q}`))

const text = fc.constantFrom('x', '&amp;', '&lt;script&gt;', '&#0;', '&nbsp;', '&#x110000;', '<', '>', '"', ' ', '​', '<!-- c -->', '<!-->', '<![CDATA[x]]>', '--!>', '</', '<?x?>')

/** Tag soup: unclosed and misnested tags, entities, foreign content (svg, math), handler attributes, comments. */
export const hostileHtml: fc.Arbitrary<string> = fc
  .array(
    fc.oneof(
      fc.tuple(fc.constantFrom(...TAGS), fc.array(attribute, { maxLength: 3 }), fc.boolean()).map(([tag, attrs, self]) => `<${tag}${attrs.join('')}${self ? '/' : ''}>`),
      fc.constantFrom(...TAGS).map((tag) => `</${tag}>`),
      text,
    ),
    { maxLength: 24 },
  )
  .map((parts) => parts.join(''))

const SCRIPT_CAPABLE = new Set(['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'base', 'meta', 'link', 'style', 'portal', 'fencedframe'])
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'data', 'poster', 'background', 'srcdoc', 'codebase', 'cite', 'lowsrc', 'dynsrc', 'ping'])

/** The scheme a URL parser reads, after the same normalisation as `urlOf` in packages/editor/src/clipboard.ts. */
function schemeOf(value: string): string | null {
  // eslint-disable-next-line no-control-regex -- the URL standard strips exactly these
  const v = value.replace(/[\t\n\r]/g, '').replace(/^[\u0000- ]+|[\u0000- ]+$/g, '')
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(v)
  return m ? m[1]!.toLowerCase() : null
}

/** What is wrong in a DOM tree: script-capable elements, on* attributes, and addresses whose scheme, read as a URL parser reads it, is not allowed. */
export function unsafeMarkup(root: ParentNode, allowedSchemes: readonly string[] = ['http', 'https', 'mailto']): string[] {
  const allowed = new Set(allowedSchemes.map((s) => s.toLowerCase()))
  const found: string[] = []
  const elements = [...(root instanceof Element ? [root] : []), ...Array.from(root.querySelectorAll('*'))]
  for (const el of elements) {
    const tag = el.localName.toLowerCase()
    if (SCRIPT_CAPABLE.has(tag)) found.push(`<${tag}>`)
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      const local = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name
      if (local.startsWith('on')) found.push(`<${tag} ${name}>`)
      else if (local === 'srcdoc') found.push(`<${tag} srcdoc>`)
      else if (URL_ATTRS.has(local) || local === 'srcset') {
        const urls = local === 'srcset' ? attr.value.split(',').map((c) => c.trim().split(/\s+/)[0] ?? '') : [attr.value]
        for (const url of urls) {
          const scheme = schemeOf(url)
          if (scheme !== null && !allowed.has(scheme)) found.push(`<${tag} ${name}="${scheme}:">`)
        }
      }
    }
  }
  return found
}
