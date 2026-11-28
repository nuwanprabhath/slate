import { describe, expect, it } from 'vitest'
import { EXPORTED_TABLES } from '../../packages/desktop/src/main/privacy/export'
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

/** Each row of the retention table: the names it writes as code, and its Export cell (null when the table has no such column). */
export function retentionRows(section: string): Array<{ names: string[]; export: string | null }> {
  const rows = section.split('\n').filter((l) => l.trimStart().startsWith('|'))
  const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
  if (rows.length < 2) return []
  const col = cells(rows[0]!).findIndex((h) => /^export$/i.test(h))
  return rows.slice(2).map((l) => {
    const c = cells(l)
    return { names: [...l.matchAll(/`([^`]+)`/g)].map((m) => m[1]!), export: col === -1 ? null : (c[col] ?? '') }
  })
}

/** "exported" (with detail after a colon) or "not exported: <why>". */
export const exportSays = (cell: string | null): 'exported' | 'not exported' | null =>
  cell === null ? null : /^exported\b/.test(cell) ? 'exported' : /^not exported: \S/.test(cell) ? 'not exported' : null

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

  it('reads each retention row\'s Export cell, and wants "exported" or "not exported: <why>"', () => {
    const md = '| Data | Where | Export |\n| --- | --- | --- |\n| Notes | `snapshots` | exported: as Markdown |\n| Notices | `notices` | not exported |\n'
    expect(retentionRows(md)).toEqual([{ names: ['snapshots'], export: 'exported: as Markdown' }, { names: ['notices'], export: 'not exported' }])
    expect(retentionRows('| Data | Where |\n| --- | --- |\n| Notes | `snapshots` |\n')).toEqual([{ names: ['snapshots'], export: null }])
    expect(exportSays('exported')).toBe('exported')
    expect(exportSays('not exported: rebuilt from the notes')).toBe('not exported')
    expect(exportSays('not exported')).toBeNull()
    expect(exportSays('')).toBeNull()
    expect(exportSays(null)).toBeNull()
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

  it('says for every retention row whether Export carries it, and why not (GDPR Art. 15 and 20)', () => {
    const rows = retentionRows(retentionSection(notice()) ?? '')
    expect(rows.length).toBeGreaterThan(0)
    const bad = rows.filter((r) => exportSays(r.export) === null)
    expect(bad.map((r) => `${r.names.map((n) => `\`${n}\``).join(', ')}: give the row an Export cell that says "exported" or "not exported: <why>" in ${NOTICE}'s retention table; see ${PATH}`)).toEqual([])
  })

  it('a table PRIVACY.md calls exported is one export.ts writes, and no other', () => {
    const tables = new Set(walk('packages/desktop/src/main', ['.ts']).filter((f) => !isTestFile(f)).flatMap((f) => createdTables(read(f))))
    const rows = retentionRows(retentionSection(notice()) ?? '')
    const said = new Map(rows.flatMap((r) => r.names.filter((n) => tables.has(n)).map((n) => [n, exportSays(r.export)] as const)))
    const exported = new Set(Object.keys(EXPORTED_TABLES))
    const problems = [
      ...[...said].filter(([t, s]) => s === 'exported' && !exported.has(t)).map(([t]) => `\`${t}\`: ${NOTICE} says exported, but main/privacy/export.ts does not write it; write it there and add it to EXPORTED_TABLES, or say "not exported: <why>"`),
      ...[...exported].filter((t) => said.get(t) !== 'exported').map((t) => `\`${t}\`: main/privacy/export.ts writes it (EXPORTED_TABLES), so its ${NOTICE} retention row must say "exported"`),
    ]
    expect(problems).toEqual([])
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
