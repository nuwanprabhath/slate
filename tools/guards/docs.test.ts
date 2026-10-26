import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT, read } from './repo'

/**
 * Audit C13 verification tests: the claims grep (no text says Slate itself is FIPS 140-3 validated or
 * FedRAMP authorized) and a link check of the documents (relative links and anchors resolve). The audit names
 * `npx markdown-link-check`; that package is not an approved dependency, so the same check runs here.
 */
const DOC_ROOTS = ['README.md', 'CHANGELOG.md', 'docs']
/** The audit and the specs argue about the claim and quote the forbidden wording; they are not claims. */
const CLAIM_EXEMPT = new Set(['docs/reviews/compliance_audit.md'])

function markdownFiles(): string[] {
  const out: string[] = []
  const visit = (rel: string): void => {
    const abs = join(ROOT, rel)
    if (!existsSync(abs)) return
    if (rel.endsWith('.md')) return void out.push(rel)
    let entries
    try {
      entries = readdirSync(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const d of entries) if (d.name !== 'node_modules') visit(`${rel}/${d.name}`)
  }
  DOC_ROOTS.forEach(visit)
  return out.sort()
}

/** Lines that claim, without a negation, that Slate itself is validated or authorized. */
const FORBIDDEN: readonly RegExp[] = [
  /slate is fips/i,
  /slate\b[^.\n]{0,40}\b(is|are|was|becomes)\s+((now|fully|a)\s+)*(fips[- ]140-[23][- ])?(fips[- ]validated|validated|fedramp[- ](authori[sz]ed|compliant)|certified)/i,
  /\bfips[- ]140-3[- ]validated\s+(slate|notes app|app|application)\b/i,
]
const NEGATION = /\b(not|never|no|nor|neither|cannot|isn't|is not|without|n't)\b/i

export function claimViolations(file: string, text: string): string[] {
  const bad: string[] = []
  text.split('\n').forEach((line, i) => {
    if (!FORBIDDEN.some((re) => re.test(line))) return
    if (/slate is fips/i.test(line) || !NEGATION.test(line)) bad.push(`${file}:${i + 1}: ${line.trim().slice(0, 100)}`)
  })
  return bad
}

function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-')
}

function anchors(text: string): Set<string> {
  const out = new Set<string>()
  let inFence = false
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    if (inFence) continue
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)?.[1]
    if (heading) out.add(slug(heading.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')))
  }
  return out
}

/** Inline links `[text](target)` outside code fences and inline code. */
export function linksOf(text: string): string[] {
  const out: string[] = []
  let inFence = false
  for (const raw of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const line = raw.replace(/`[^`]*`/g, '')
    for (const m of line.matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) if (m[1]) out.push(m[1])
  }
  return out
}

export function brokenLinks(file: string, text: string, exists: (rel: string) => boolean, readText: (rel: string) => string): string[] {
  const bad: string[] = []
  for (const target of linksOf(text)) {
    if (/^(https?:|mailto:)/i.test(target)) continue
    const [path = '', hash] = target.split('#')
    const rel = path === '' ? file : resolve('/', dirname(file), path).slice(1)
    if (!exists(rel)) {
      bad.push(`${file}: ${target} (no such file ${rel})`)
      continue
    }
    if (hash && rel.endsWith('.md') && !anchors(readText(rel)).has(hash.toLowerCase())) bad.push(`${file}: ${target} (no such heading)`)
  }
  return bad
}

describe('claims (audit §1.2, C13 criterion 2)', () => {
  it('no document says Slate itself is FIPS 140-3 validated or FedRAMP authorized', () => {
    const bad = markdownFiles()
      .filter((f) => !CLAIM_EXEMPT.has(f))
      .flatMap((f) => claimViolations(f, read(f)))
    expect(bad, 'Only the embedded module (CMVP #4985) is validated: say that (README, "What Slate claims about FIPS 140-3")').toEqual([])
  })

  it('the checker refuses a claim and lets a denial through (self-test)', () => {
    expect(claimViolations('x.md', 'Slate is FIPS 140-3 validated.')).toHaveLength(1)
    expect(claimViolations('x.md', 'Slate is FIPS compliant.')).toHaveLength(1)
    expect(claimViolations('x.md', 'Slate is now FedRAMP authorized.')).toHaveLength(1)
    expect(claimViolations('x.md', 'Slate is not "FIPS 140-3 validated".')).toEqual([])
    expect(claimViolations('x.md', 'Slate is not FedRAMP authorized.')).toEqual([])
    expect(claimViolations('x.md', 'The module is FIPS 140-3 validated (CMVP #4985).')).toEqual([])
  })

  it('the README states the audit §1.2 claim word for word, with the certificate number', () => {
    const claim =
      'In the `fips-140-3` profile, every cryptographic operation that protects notes is performed by the OpenSSL FIPS Provider 3.1.2 (CMVP certificate #4985, FIPS 140-3, active, sunset 2030-03-10) in its approved mode. Slate runs a power-up self-test, enters a terminal error state on any failure, and destroys key material at lock.'
    expect(read('README.md')).toContain(`> ${claim}`)
    expect(read('docs/compliance/security-policy.md')).toContain(`> ${claim}`)
    expect(read('docs/reviews/compliance_audit.md')).toContain(`> ${claim}`)
  })
})

describe('docs links (C13 verification)', () => {
  it('every relative link and heading anchor in the README, CHANGELOG and docs resolves', () => {
    const exists = (rel: string): boolean => existsSync(join(ROOT, rel))
    const bad = markdownFiles().flatMap((f) => brokenLinks(f, read(f), exists, (r) => readFileSync(join(ROOT, r), 'utf8')))
    expect(bad, 'fix the link, or the file it points at').toEqual([])
  })

  it('the checker finds a missing file and a missing heading (self-test)', () => {
    const files: Record<string, string> = { 'docs/a.md': '# Title\n', 'docs/b.md': '' }
    const exists = (rel: string): boolean => rel in files
    const text = '[ok](a.md#title) [file](gone.md) [head](a.md#nope) [web](https://x.y/z) `[code](nope.md)`\n```\n[fence](nope.md)\n```'
    expect(brokenLinks('docs/b.md', text, exists, (r) => files[r] ?? '')).toEqual([
      'docs/b.md: gone.md (no such file docs/gone.md)',
      'docs/b.md: a.md#nope (no such heading)',
    ])
  })
})
