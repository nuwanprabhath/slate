import { describe, expect, it } from 'vitest'
import { changeReason, dueMessage, LEDGER, matchPaths, MIN_LINES_FOR_DAYS, nightlyReason, pathReason } from './quality-cadence.mjs'
import { ciVerdict } from './release-ci-gate.mjs'
import { read } from './repo'

// The quality skills ran by memory, and for 0.8.0 (9,400 agent-written lines, security paths, sync, the
// renderer) none of trim-comments, architecture-drift, blast-radius, ui-review's screenshot pass or the
// security review ran before the release. These pin when each is owed and that a release tag waits for it.

describe('when a quality skill is owed a run', () => {
  const every = { lines: 1500, days: 14 }

  it('is owed after its number of changed lines, as 0.8.0 was one squash commit of 9,400', () => {
    expect(changeReason('trim-comments', every, 9400, 1)).toBe('trim-comments: 9400 changed lines since its last run (owed every 1500)')
    expect(changeReason('trim-comments', every, 1499, 1)).toBeNull()
  })

  it('is owed after its number of days only once the code has moved', () => {
    expect(changeReason('trim-comments', every, MIN_LINES_FOR_DAYS, 15)).toBe(`trim-comments: 15 days and ${String(MIN_LINES_FOR_DAYS)} changed lines since its last run (owed every 14 days)`)
    expect(changeReason('trim-comments', every, MIN_LINES_FOR_DAYS - 1, 90)).toBeNull()
  })

  it('a path skill is owed when a file it covers changed, and a plain test file does not count', () => {
    const globs = ['packages/desktop/src/main/vault/**', 'packages/desktop/src/renderer/**']
    const changed = ['packages/desktop/src/main/vault/keyring.ts', 'packages/desktop/src/main/vault/keyring.test.ts', 'packages/desktop/test/spec/redact.test.ts', 'README.md']
    expect(matchPaths(changed, globs)).toEqual(['packages/desktop/src/main/vault/keyring.ts'])
    expect(matchPaths(['packages/desktop/test/spec/x.test.ts'], ['packages/desktop/test/spec/**'])).toEqual(['packages/desktop/test/spec/x.test.ts'])
    expect(pathReason('security-review', [])).toBeNull()
    expect(pathReason('security-review', ['a', 'b', 'c', 'd'])).toBe('security-review: 4 file(s) it covers changed since its last run (a, b, c, …)')
  })

  it('nightly triage is owed by a scheduled nightly that failed after the last triage, as six did from 20 to 26 November', () => {
    const runs = [
      { number: 64, createdAt: '2026-11-26T12:29:18Z', conclusion: 'failure' },
      { number: 63, createdAt: '2026-11-25T12:51:17Z', conclusion: 'success' },
      { number: 60, createdAt: '2026-11-20T11:36:58Z', conclusion: 'failure' },
    ]
    expect(nightlyReason('nightly-triage', runs, '2026-11-25T00:00:00Z')).toMatch(/^nightly-triage: scheduled nightly run #64 \(2026-11-26\) failed since the last triage/)
    expect(nightlyReason('nightly-triage', runs, '2026-11-27T00:00:00Z')).toBeNull()
  })

  it('says how to clear it', () => {
    expect(dueMessage(['a', 'b'])).toContain('Quality skills owed a run: a; b.')
    expect(dueMessage(['a'])).toContain('node tools/guards/quality-cadence.mjs done <name>')
  })
})

describe('a release tag waits for CI on its commit', () => {
  const sha = 'd86d2e01c7cd4aaa'

  it('goes ahead only after CI passed', () => {
    expect(ciVerdict([{ databaseId: 1, status: 'completed', conclusion: 'success' }], sha)).toBeNull()
    expect(ciVerdict([], sha)).toMatch(/CI has not run on d86d2e01/)
    expect(ciVerdict([{ databaseId: 2, status: 'in_progress', conclusion: null }], sha)).toMatch(/still in_progress.*gh run watch 2/)
    expect(ciVerdict([{ databaseId: 3, status: 'completed', conclusion: 'failure' }], sha)).toMatch(/ended "failure"/)
  })

  it('a run no runner picked up says to re-run it, as 0.8.1\'s macOS jobs needed', () => {
    expect(ciVerdict([{ databaseId: 4, status: 'completed', conclusion: 'cancelled' }], sha)).toMatch(/gh run rerun 4 --failed/)
  })
})

describe('the cadence is wired in, and every owed item can be cleared', () => {
  const ledger = JSON.parse(read(LEDGER)) as { skills: Record<string, { every?: unknown; when?: { paths?: string[]; pathsFile?: string; nightly?: boolean }; last: { commit: string; at: string } }> }

  it('the ledger names each skill with a milestone and a last run', () => {
    for (const name of ['trim-comments', 'correct', 'architecture-drift', 'prune-tests', 'security-review', 'blast-radius', 'ui-review', 'nightly-triage'])
      expect(ledger.skills[name], name).toBeDefined()
    for (const [name, skill] of Object.entries(ledger.skills)) {
      expect(skill.every !== undefined || skill.when !== undefined, name).toBe(true)
      expect(skill.last.commit, name).toMatch(/^[0-9a-f]{40}$/)
      expect(Number.isNaN(Date.parse(skill.last.at)), name).toBe(false)
    }
  })

  it('the pre-push hook refuses a release tag until CI passed and nothing is owed, with the main checkout\'s copies', () => {
    const hook = read('.githooks/pre-push')
    expect(hook).toMatch(/node "\$main\/tools\/guards\/release-ci-gate\.mjs" "\$commit" \|\| exit 1/)
    expect(hook).toMatch(/node "\$main\/tools\/guards\/quality-cadence\.mjs" check "\$commit" \|\| exit 1/)
    expect(hook).toContain('SLATE_CADENCE_DEFER')
  })

  it('each session starts by saying what is owed', () => {
    const settings = JSON.parse(read('.claude/settings.json')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
    const start = (settings.hooks.SessionStart ?? []).flatMap((h) => h.hooks.map((c) => c.command))
    expect(start.some((c) => c.includes('tools/guards/quality-cadence.mjs') && c.includes('hook'))).toBe(true)
  })

  it('every skill and the security review end by recording their run', () => {
    const files: Record<string, string> = {
      'trim-comments': '.claude/skills/trim-comments/SKILL.md',
      correct: '.claude/skills/correct/SKILL.md',
      'architecture-drift': '.claude/skills/architecture-drift/SKILL.md',
      'prune-tests': '.claude/skills/prune-tests/SKILL.md',
      'blast-radius': '.claude/skills/blast-radius/SKILL.md',
      'ui-review': '.claude/skills/ui-review/SKILL.md',
      'security-review': 'docs/review/REVIEW.md',
    }
    for (const [name, file] of Object.entries(files)) expect(read(file), file).toContain(`node tools/guards/quality-cadence.mjs done ${name}`)
  })
})
