import { describe, expect, it } from 'vitest'
import { CONSENT_FEATURES, DISCLOSURES } from '../../packages/desktop/src/shared/privacy/consent'
import { egressEntries, GATES, LITERALS } from './egressScan'
import { exists, isTestFile, read, walk } from './repo'

/**
 * The privacy notice (PRIVACY.md, GDPR Art. 13 and 30) says no less than the code does: every table
 * main creates has a retention row, and every consent feature and every host it discloses is named.
 * Adding a table, a feature or an endpoint without the notice fails here; see
 * docs/architecture/golden-paths.md#privacy.
 */

const NOTICE = 'PRIVACY.md'
const PATH = 'docs/architecture/golden-paths.md#privacy'
const notice = (): string => (exists(NOTICE) ? read(NOTICE) : '')

/** `CREATE [VIRTUAL] TABLE [IF NOT EXISTS] name` in source text, each table once. */
export function createdTables(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/\bCREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?([A-Za-z_][A-Za-z0-9_]*)/gi)) out.add(m[1]!)
  return [...out]
}

/** The text of the first Markdown section whose heading mentions retention, up to the next heading at its level or above. */
export function retentionSection(markdown: string): string | null {
  const lines = markdown.split('\n')
  const start = lines.findIndex((l) => /^#{1,6}\s.*retention/i.test(l))
  if (start === -1) return null
  const level = /^#+/.exec(lines[start]!)![0].length
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => {
    const h = /^(#+)\s/.exec(l)
    return h !== null && h[1]!.length <= level
  })
  return (end === -1 ? rest : rest.slice(0, end)).join('\n')
}

/** The name written as code (`name`), so a common word such as "updates" in prose does not count. */
export const namesAsCode = (text: string, name: string): boolean => text.includes(`\`${name}\``)

describe('privacy notice helpers (fixtures)', () => {
  it('finds every created table, virtual ones included', () => {
    const sql = "db.exec(`CREATE TABLE IF NOT EXISTS snapshots (a)\nCREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(text)\ncreate table \"audit\" (b)`)\n// CREATE TABLE snapshots again"
    expect(createdTables(sql).sort()).toEqual(['audit', 'search', 'snapshots'])
    expect(createdTables('CREATE INDEX IF NOT EXISTS i ON t(a)')).toEqual([])
  })

  it('reads the retention section and stops at the next heading', () => {
    const md = '# Privacy\n\n## What stays local\n`audit`\n\n## Retention\n| `snapshots` | forever |\n### Logs\n`logs`\n## Your rights\n`search`\n'
    const s = retentionSection(md)
    expect(s).toContain('`snapshots`')
    expect(s).toContain('`logs`')
    expect(s).not.toContain('`search`')
    expect(s).not.toContain('`audit`')
    expect(retentionSection('# Privacy\nnothing')).toBeNull()
  })

  it('wants a name as code', () => {
    expect(namesAsCode('the `updates` check', 'updates')).toBe(true)
    expect(namesAsCode('checks for updates', 'updates')).toBe(false)
  })
})

describe('PRIVACY.md matches the code', () => {
  it('exists at the repo root', () => {
    expect(exists(NOTICE), `${NOTICE} is the privacy notice the app and README link to; see ${PATH}`).toBe(true)
  })

  it('names every table main creates in its retention section', () => {
    const tables = new Set(walk('packages/desktop/src/main', ['.ts']).filter((f) => !isTestFile(f)).flatMap((f) => createdTables(read(f))))
    const section = retentionSection(notice())
    expect(section, `${NOTICE} needs a section whose heading says "Retention"`).not.toBeNull()
    const missing = [...tables].filter((t) => !namesAsCode(section ?? '', t)).sort()
    expect(missing.map((t) => `table \`${t}\`: add its row to ${NOTICE}'s retention section (what it holds, how long, how it is erased), and cover it in export and erase; see ${PATH}`)).toEqual([])
  })

  it('names every endpoint DISCLOSURES lists', () => {
    const text = notice()
    const missing = Object.entries(DISCLOSURES).flatMap(([f, d]) => d.endpoints.filter((e) => !text.includes(e)).map((e) => `${e} (${f})`))
    expect(missing.map((m) => `${m}: name the host in ${NOTICE}'s row for the flow; see ${PATH}`)).toEqual([])
  })

  it('names every ConsentFeature', () => {
    const text = notice()
    expect(CONSENT_FEATURES.filter((f) => !namesAsCode(text, f)).map((f) => `\`${f}\`: add the flow to ${NOTICE} with its feature name as code (endpoint, data, recipient and country, how to turn it off); see ${PATH}`)).toEqual([])
  })

  it('every egress.json feature is a ConsentFeature or a literal', () => {
    const known = new Set<string>([...CONSENT_FEATURES, ...LITERALS])
    const bad = Object.entries(egressEntries()).filter(([, e]) => !known.has(e.feature))
    expect(bad.map(([file, e]) => `${file}: '${e.feature}' is not a ConsentFeature (shared/privacy/consent.ts) nor ${LITERALS.map((l) => `'${l}'`).join(' or ')}`)).toEqual([])
  })

  it('the gates the egress scanner trusts are the ones A ships', () => {
    const gate = read('packages/desktop/src/main/privacy/gate.ts')
    const consent = read('packages/desktop/src/shared/privacy/consent.ts')
    const exported = (text: string, name: string) => new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${name}\\b`).test(text)
    const missing = [...GATES].filter((g) => !exported(gate, g) && !exported(consent, g))
    expect(missing.map((g) => `${g}: egressScan.ts counts it as a privacy gate, but neither main/privacy/gate.ts nor shared/privacy/consent.ts exports it`)).toEqual([])
  })
})
