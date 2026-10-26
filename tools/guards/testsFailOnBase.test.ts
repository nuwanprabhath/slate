import { describe, expect, it } from 'vitest'
// @ts-expect-error -- plain JavaScript with no declaration file; the calls below pin its shape
import { caseChanges, caseTitles, newCaseTitles, redOnBase } from '../../.claude/hooks/testsFailOnBase.mjs'

describe('Stop hook: "seen red" needs a NEW test case (red team re-run R3)', () => {
  const base = "it('turns NBSP into a space', () => {\n  expect(toPlainText(x)).toBe('a b')\n})\n"
  const bentExpectation = "it('turns NBSP into a space', () => {\n  expect(toPlainText(x)).toBe('a b')\n})\n"
  const withNewCase = `${base}it('keeps a thin space', () => {\n  expect(toPlainText(y)).toBe('a b')\n})\n`

  it('reads case titles of it, test and their modifiers', () => {
    expect(caseTitles("it('a', f)\ntest.each([1])(\"b\", f)\nit.concurrent(`c`, f)\ndescribe('d', f)")).toEqual(['a', 'b', 'c'])
  })

  it('an edited expectation adds no case; a new it() does', () => {
    expect(newCaseTitles(base, bentExpectation)).toEqual([])
    expect(newCaseTitles(base, withNewCase)).toEqual(['keeps a thin space'])
    expect(newCaseTitles(null, base)).toEqual(['turns NBSP into a space'])
  })

  it('counts as red only when a new case fails on the base, or its file cannot load there', () => {
    const report = (title: string, status: string, fileStatus = 'failed') => ({ testResults: [{ name: '/t/packages/core/test/x.test.ts', status: fileStatus, assertionResults: title ? [{ title, status }] : [] }] })
    const fresh = { 'packages/core/test/x.test.ts': ['keeps a thin space'] }
    expect(redOnBase(report('turns NBSP into a space', 'failed'), fresh)).toBe(false)
    expect(redOnBase(report('keeps a thin space', 'failed'), fresh)).toBe(true)
    expect(redOnBase(report('', '', 'failed'), fresh)).toBe(true)
    expect(redOnBase(report('keeps a thin space', 'passed', 'passed'), fresh)).toBe(false)
  })

  it('a renamed case with an edited expectation is a removed case plus an added one, not a new case (red team G2-3)', () => {
    const renamedAndBent = "it('turns NBSP into a regular space', () => {\n  expect(toPlainText(x)).toBe('a\\u00a0b')\n})\n"
    expect(caseChanges(base, renamedAndBent)).toEqual({ added: ['turns NBSP into a regular space'], removed: ['turns NBSP into a space'] })
    // A pure rename (same body) is neither.
    const renamedOnly = "it('NBSP becomes a space', () => {\n  expect(toPlainText(x)).toBe('a b')\n})\n"
    expect(caseChanges(base, renamedOnly)).toEqual({ added: [], removed: [] })
    expect(caseChanges(base, withNewCase)).toEqual({ added: ['keeps a thin space'], removed: [] })
    // Red needs more added cases failing on the base than cases removed.
    const report = (failed: string[]) => ({ testResults: [{ name: '/t/packages/core/test/x.test.ts', status: 'failed', assertionResults: failed.map((title) => ({ title, status: 'failed' })) }] })
    const fresh = { 'packages/core/test/x.test.ts': ['turns NBSP into a regular space'] }
    expect(redOnBase(report(['turns NBSP into a regular space']), fresh, 1)).toBe(false)
    expect(redOnBase(report(['turns NBSP into a regular space', 'keeps a thin space']), { 'packages/core/test/x.test.ts': ['turns NBSP into a regular space', 'keeps a thin space'] }, 1)).toBe(true)
  })
})
