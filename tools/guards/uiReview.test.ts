import { describe, expect, it } from 'vitest'
// @ts-expect-error -- a plain .mjs hook module with JSDoc types, no declaration file
import { uiReviewProblems } from '../../.claude/hooks/uiReview.mjs'
import { git, read } from './repo'

type Problems = (branch: { changed: string[]; trailer: (key: string) => string; allowNow: number; allowBase: number }) => string[]
const check = uiReviewProblems as Problems
const none = () => ''
const withTrailer = (key: string) => (k: string) => (k === key ? 'a reason' : '')

/** The Stop hook's UI rules (.claude/skills/ui-review/SKILL.md): a renderer change is looked at, not only tested. */
describe('the UI part of the definition of done', () => {
  it('blocks a renderer change with no UI scenario', () => {
    const problems = check({ changed: ['packages/desktop/src/renderer/src/lock/lock.css'], trailer: none, allowNow: 0, allowBase: 0 })
    expect(problems.join('\n')).toContain('no UI scenario')
  })

  it('passes it with a scenario added or changed, or a No-UI-Review-Reason trailer', () => {
    const renderer = 'packages/desktop/src/renderer/src/lock/LockScreen.tsx'
    expect(check({ changed: [renderer, 'packages/desktop/e2e/ui/lock.ui.spec.ts'], trailer: none, allowNow: 0, allowBase: 0 })).toEqual([])
    expect(check({ changed: [renderer], trailer: withTrailer('No-UI-Review-Reason'), allowNow: 0, allowBase: 0 })).toEqual([])
  })

  it('ignores renderer files that are not drawn (a .ts module) and other packages', () => {
    expect(check({ changed: ['packages/desktop/src/renderer/src/layout.ts', 'packages/core/src/x.tsx'], trailer: none, allowNow: 0, allowBase: 0 })).toEqual([])
  })

  it('blocks a new data-ui-allow without a UI-Allow-Reason trailer', () => {
    expect(check({ changed: [], trailer: none, allowNow: 2, allowBase: 1 }).join('\n')).toContain('UI audit exception added')
    expect(check({ changed: [], trailer: withTrailer('UI-Allow-Reason'), allowNow: 2, allowBase: 1 })).toEqual([])
    expect(check({ changed: [], trailer: none, allowNow: 1, allowBase: 1 })).toEqual([])
  })

  it('blocks a change to the audit or reviewUi without a UI-Gate-Change trailer', () => {
    expect(check({ changed: ['packages/desktop/e2e/ui/audit.ts'], trailer: none, allowNow: 0, allowBase: 0 }).join('\n')).toContain('UI audit changed')
    expect(check({ changed: ['packages/desktop/e2e/ui/review.ts'], trailer: withTrailer('UI-Gate-Change'), allowNow: 0, allowBase: 0 })).toEqual([])
  })

  it('is wired into the Stop hook', () => {
    const hook = read('.claude/hooks/definition-of-done.mjs')
    expect(hook).toContain("from './uiReview.mjs'")
    expect(hook).toMatch(/problems\.push\(\.\.\.uiReviewProblems\(/)
  })

  it('the scenarios run in the normal e2e suite (Playwright finds e2e/ui)', () => {
    expect(read('packages/desktop/playwright.config.ts')).toMatch(/testDir: 'e2e'/)
  })
})

/** The ui-review skill was once lost to a `.gitignore` line (`ui-review/`) while CLAUDE.md pointed at it. */
describe('skills CLAUDE.md names', () => {
  it('are tracked by git, not only present on one disk', () => {
    const named = [...new Set(read('CLAUDE.md').match(/\.claude\/skills\/[\w./-]+\.md/g) ?? [])]
    expect(named).toContain('.claude/skills/ui-review/SKILL.md')
    const tracked = new Set(git(['ls-files', '--', '.claude/skills']).split('\n'))
    expect(named.filter((p) => !tracked.has(p))).toEqual([])
  })
})
