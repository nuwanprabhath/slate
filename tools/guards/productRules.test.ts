import { describe, expect, it } from 'vitest'
import { baseCommit, exists, read, readAt } from './repo'

/**
 * The CLAUDE.md product rules are pinned by spec tests that agents cannot quietly bend (red team
 * re-run R3: a product rule broken and its expectation edited to match). They live under a
 * `spec/` folder, which is a guard path (guard-edits, the review gate, CI's Guardrail-Change check),
 * each names its rule in a `@product-rule` header, and the number of expectations in each only grows.
 */
const SPECS: Record<string, { rule: string; was?: string }> = {
  'packages/core/test/spec/plaintext.test.ts': { rule: 'copy-as-plain-text', was: 'packages/core/test/plaintext.test.ts' },
  'packages/editor/test/spec/clipboard.test.ts': { rule: 'copy-as-html-and-default-paste', was: 'packages/editor/test/clipboard.test.ts' },
  'packages/desktop/e2e/spec/clipboard.spec.ts': { rule: 'copy-and-paste', was: 'packages/desktop/e2e/clipboard.spec.ts' },
  'packages/desktop/e2e/spec/formatting.spec.ts': { rule: 'no-auto-formatting', was: 'packages/desktop/e2e/formatting.spec.ts' },
  'packages/desktop/e2e/spec/autobullets.spec.ts': { rule: 'no-auto-formatting', was: 'packages/desktop/e2e/autobullets.spec.ts' },
  'packages/desktop/e2e/spec/perf.spec.ts': { rule: 'performance-budget', was: 'packages/desktop/e2e/perf.spec.ts' },
  'packages/desktop/e2e/spec/perfMeasure.ts': { rule: 'performance-budget', was: 'packages/desktop/e2e/perfMeasure.ts' },
  'packages/desktop/test/spec/redact.test.ts': { rule: 'log-redaction' },
  'packages/editor/test/spec/inputRules.test.ts': { rule: 'no-auto-formatting' },
  'packages/desktop/test/spec/settingsDefaults.test.ts': { rule: 'no-auto-formatting' },
}

export const countExpects = (text: string): number => (text.match(/\bexpect(?:\.\w+)?\s*\(/g) ?? []).length

describe('product-rule spec tests', () => {
  it('each CLAUDE.md product rule has its spec file, which names the rule', () => {
    const problems: string[] = []
    for (const [file, { rule }] of Object.entries(SPECS)) {
      if (!exists(file)) problems.push(`${file} is missing`)
      else if (!read(file).includes(`@product-rule ${rule}`)) problems.push(`${file} needs the header comment \`@product-rule ${rule}\``)
    }
    expect(problems).toEqual([])
  })

  it('the expectation counter sees each form (self-test)', () => {
    expect(countExpects("expect(a).toBe(1)\nexpect.soft(b).toBe(2)\nawait expect(page).toHaveTitle('x')\nexpectation()")).toBe(3)
  })

  const base = baseCommit()
  // Outside a checkout with history there is no base to compare with.
  it.skipIf(base === null)('no spec file has fewer expectations than at the base: a product rule is changed by the maintainer, not by editing its test', () => {
    const shrunk: string[] = []
    for (const [file, { was }] of Object.entries(SPECS)) {
      const before = readAt(base!, file) ?? (was ? readAt(base!, was) : null)
      if (before === null || !exists(file)) continue
      const [b, n] = [countExpects(before), countExpects(read(file))]
      if (n < b) shrunk.push(`${file}: ${String(b)} → ${String(n)} expectations`)
    }
    expect(shrunk.map((s) => `${s}. Restore them; a product rule (CLAUDE.md) changes only with the maintainer, on a guardrail branch`)).toEqual([])
  })
})
