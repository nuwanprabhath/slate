import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- plain JavaScript with no declaration file; the calls below pin its shape
import { checkReview, conventionalProblems, isGuardFile, reasonTrailers, reviewFileName, reviewTier, riskyAdditions, sensitiveFiles, unlockedFor, unmarkedGuardCommits } from '../../scripts/agents/review-gate.mjs'
// @ts-expect-error -- plain JavaScript with no declaration file
import { parseLog } from '../../scripts/agents/check-guard-commits.mjs'
// @ts-expect-error -- plain JavaScript with no declaration file
import { signUnlockLine } from '../../scripts/agents/unlock.mjs'
// @ts-expect-error -- plain JavaScript with no declaration file
import { needsProductE2e } from '../../scripts/agents/merge-wp.mjs'
import { read } from './repo'

const HEAD = '0123456789abcdef0123456789abcdef01234567'

describe('review gate: which branches need the security review (red team, cross-cutting)', () => {
  const globs = read('tools/guards/security-paths.txt')
  const tiers = { security: globs, architecture: read('tools/guards/architecture-paths.txt'), allowlisted: ['packages/desktop/src/main/blobs.ts'] }
  const tierOf = (changed: string[], diff = '') => (reviewTier({ changed, diff, ...tiers }) as { tier: string }).tier

  it('security review for the vault, db, native, IPC door, preload, CSP, update, guard and manifest paths and allowlisted files', () => {
    for (const f of [
      'packages/desktop/src/main/vault/crypto.ts',
      'packages/desktop/src/main/db/openDatabase.ts',
      'packages/native/src/x.c',
      'packages/desktop/src/main/ipcGuard.ts',
      'packages/desktop/src/preload/rt.ts',
      'packages/desktop/src/shared/csp.ts',
      'packages/desktop/src/main/hardening.ts',
      'packages/desktop/src/main/update/x.ts',
      'packages/desktop/src/renderer/index.html',
      'packages/core/vitest.config.ts',
      'packages/core/package.json',
      'packages/core/tsconfig.json',
      'packages/core/test/spec/plaintext.test.ts',
      'packages/desktop/src/main/blobs.ts',
      'packages/desktop/src/shared/redact.ts',
      'packages/desktop/src/main/log/logger.ts',
    ]) {
      expect(tierOf([f]), f).toBe('security')
    }
  })

  it('architecture review only for other main-process code with nothing risky in it (red team re-run, review volume)', () => {
    for (const f of ['packages/desktop/src/main/idleLabel.ts', 'packages/desktop/src/shared/x.ts', 'packages/sync/src/gitDrive.ts', 'packages/mcp/src/tools.ts']) expect(tierOf([f], '+  export const n = 1'), f).toBe('architecture')
    // A risky line anywhere still means the security review.
    expect(tierOf(['packages/desktop/src/main/idleLabel.ts'], "+++ b/packages/desktop/src/main/idleLabel.ts\n+  const v = process.env.SLATE_X")).toBe('security')
  })

  it('a main-process test file alone needs no review; renderer code needs none', () => {
    expect(tierOf(['packages/desktop/src/main/idleLabel.test.ts'], "+  expect(label()).toBe('x')")).toBe('none')
    expect(tierOf(['packages/desktop/src/renderer/src/App.tsx', 'docs/x.md'])).toBe('none')
  })


  it('flags risky additions anywhere, whatever the path (red team 7a, 4a, 3a, 10a, 9a, 2a)', () => {
    const diff = [
      '+++ b/packages/desktop/src/renderer/src/x.ts',
      "+  spawn('open', [p], { shell: process.platform === 'win32' })",
      '+  void crypto.subtle.encrypt(a, k, d)',
      '+  const v = process.env.SLATE_X',
      "+  it.skip('flaky', () => {})",
      '+  /* eslint slate/no-math-random: off */',
      "+  notesExport: 'pre-unlock',",
      '-  removed lines do not count: process.env',
      ' context lines do not count: child_process',
    ].join('\n')
    expect(riskyAdditions(diff).map((r: { why: string }) => r.why)).toEqual(['child process', 'crypto', 'environment', 'skipped test', 'inline lint comment', 'ungated IPC policy'])
    expect(riskyAdditions('+  const a = 1')).toEqual([])
  })

  it('editor input or paste rule configuration needs review (red team G2-1)', () => {
    for (const line of ['+      enableInputRules: true,', '+      enablePasteRules: true,', "+import Typography from '@tiptap/extension-typography'", '+    addInputRules() {', '+      Space: () => editor.chain().setHeading({ level: 1 }).run(),', '+  c.toggleBulletList()', '+  c.toggleOrderedList()', '+  c.toggleTaskList()', '+  c.toggleBlockquote()', '+  c.setCodeBlock()', '+  handleTextInput(view, from, to, text) {', '+  appendTransaction: (trs, old, state) => null,', '+  plugins: [inputRules({ rules })],']) {
      expect(riskyAdditions(`+++ b/packages/editor/src/BoxEditor.tsx\n${line}`).map((r: { why: string }) => r.why), line).toContain('editor input rules')
    }
  })

  it('taking a key from the ring, unwrapping it, or turning bytes into hex or base64 needs review (red team G2-5, G2-8)', () => {
    for (const line of ["+  const k = ring.get('sync')", "+  const k = this.keyRing.get('mk')", '+  const b = vaultKeyBuffer(k)', "+  log.info('x', { id: buf.toString('hex') })", '+  const s = bytes.toString("base64")', "+  const s = Buffer.from(b).toString('base64url')", "+  log.warn('sync', 'k', { key: kr.get('sync') })", '+  const x = r.get("nameEnc")', "+  const k = holder.get( 'localwrap' )"]) {
      expect(riskyAdditions(`+++ b/packages/desktop/src/main/sync/x.ts\n${line}`).map((r: { why: string }) => r.why), line).toContain('key material')
    }
    expect(riskyAdditions("+  const s = text.toString()\n+  const m = map.get('k')")).toEqual([])
  })

  it('a removed expectation in any test file needs review (red team re-run R3)', () => {
    const diff = ['diff --git a/packages/core/test/x.test.ts b/packages/core/test/x.test.ts', '--- a/packages/core/test/x.test.ts', '+++ b/packages/core/test/x.test.ts', "-    expect(toPlainText(nbsp)).toBe('a b')", "+    expect(toPlainText(nbsp)).toBe('a b')"].join('\n')
    expect(riskyAdditions(diff).map((r: { why: string }) => r.why)).toEqual(['removed expectation'])
    const src = ['+++ b/packages/core/src/x.ts', '-  expect is a word here'].join('\n')
    expect(riskyAdditions(src)).toEqual([])
  })

  it('product-rule spec tests are guard files and security paths (red team re-run R3)', () => {
    for (const f of ['packages/core/test/spec/plaintext.test.ts', 'packages/desktop/e2e/spec/perf.spec.ts', 'packages/editor/test/spec/clipboard.test.ts']) {
      expect(isGuardFile(f), f).toBe(true)
      expect(sensitiveFiles([f], read('tools/guards/security-paths.txt'), []), f).toEqual([f])
    }
    expect(isGuardFile('packages/core/test/page.test.ts')).toBe(false)
  })

  it('lists the No-*-Reason trailers for the lead to judge', () => {
    expect(reasonTrailers('fix: x\n\nNo-Red-Test-Reason: refactor\n---\nfeat: y\n\nNo-Test-Reason: docs only')).toEqual(['No-Red-Test-Reason: refactor', 'No-Test-Reason: docs only'])
  })

  it('re-checks the commit subjects the commit-msg hook should have refused (red team 12b)', () => {
    expect(conventionalProblems(['feat(desktop): a', 'Merge branch main', 'wip', 'fix: b\n\nCo-Authored-By: Claude <x@anthropic.com>'])).toEqual(['not a Conventional Commit: "wip"', 'AI attribution in "fix: b"'])
  })
})

describe('CI backstop: guard-file commits carry Guardrail-Change (red team 9e, 12b)', () => {
  const commits = [
    { sha: 'a', message: 'fix(desktop): x', files: ['packages/desktop/src/main/index.ts'] },
    { sha: 'b', message: 'fix(guards): loosen\n\nGuardrail-Change: G2, approved', files: ['tools/eslint-rules/sanctioned.mjs'] },
    { sha: 'c', message: 'test: x', files: ['packages/core/vitest.config.ts'] },
    { sha: 'd', message: 'chore: y', files: ['tools/guards/allowlists/dependencies.json'] },
    { sha: 'e', message: 'chore: z', files: ['.claude/settings.json'] },
  ]

  it('names the commits that change a guard file without the trailer', () => {
    expect(unmarkedGuardCommits(commits).map((c: { sha: string }) => c.sha)).toEqual(['c', 'e'])
    expect(unmarkedGuardCommits(commits, ['c']).map((c: { sha: string }) => c.sha)).toEqual(['e'])
  })

  it('parses the log format the CI step reads', () => {
    expect(parseLog('\x1eabc\x1ffix: a\n\nGuardrail-Change: x\n\x1f\n\neslint.config.mjs\n')).toEqual([{ sha: 'abc', message: 'fix: a\n\nGuardrail-Change: x\n', files: ['eslint.config.mjs'] }])
  })

  it('the guard file list covers vitest configs and the root manifest (red team 10b, 9i)', () => {
    for (const f of ['packages/core/vitest.config.ts', 'packages/desktop/vitest.main.config.ts', 'vitest.config.ts', 'package.json', 'scripts/agents/merge-wp.mjs', 'tools/guards/vitest.config.mts']) expect(isGuardFile(f), f).toBe(true)
    for (const f of ['packages/core/package.json', 'tools/guards/allowlists/crypto-imports.json', 'packages/desktop/src/main/index.ts']) expect(isGuardFile(f), f).toBe(false)
  })
})

describe('review gate: the review file', () => {
  it('names the file after the branch with slashes as dashes', () => {
    expect(reviewFileName('phase11/g1')).toBe('phase11-g1.md')
  })

  it('accepts Reviewed: or Commit: naming the branch head, with the verdict last', () => {
    expect(checkReview(`Reviewed: ${HEAD}\n\nVERDICT: APPROVE\n`, HEAD)).toBeNull()
    expect(checkReview(`**Commit:** \`${HEAD.slice(0, 12)}\`\n\nVERDICT: APPROVE`, HEAD)).toBeNull()
    expect(checkReview(null, HEAD)).toMatch(/no review/)
    expect(checkReview(`Reviewed: ${HEAD}\nVERDICT: CHANGES`, HEAD)).toMatch(/VERDICT: APPROVE/)
    expect(checkReview('Reviewed: deadbeef00\n\nVERDICT: APPROVE', HEAD)).toMatch(/branch head/)
    expect(checkReview('VERDICT: APPROVE', HEAD)).toMatch(/Reviewed/)
  })
})

describe('review gate: signed guardrail unlock (G2 item 3)', () => {
  const lead = generateKeyPairSync('ed25519')
  const agent = generateKeyPairSync('ed25519')
  const pub = lead.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const leadPem = lead.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const agentPem = agent.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const WT = '/repo/.claude/worktrees/agent-1'
  const ctx = (branch: string, worktree = WT, firstCommit = 'x') => ({ branch, worktree, firstCommit })

  it('a line signed with the lead key unlocks that branch in that worktree or at that first commit', () => {
    const text = `${signUnlockLine(leadPem, 'phase11/g2', WT) as string}\n${signUnlockLine(leadPem, 'phase11/g3', HEAD) as string}\n`
    expect(unlockedFor(text, ctx('phase11/g2'), pub)).toBe(true)
    expect(unlockedFor(text, ctx('phase11/g3', '/elsewhere', HEAD), pub)).toBe(true)
  })

  it('refuses an unsigned line, a bare name, a line signed by another key, and a copied signature (red team re-run: computed unlock write)', () => {
    const forged = signUnlockLine(agentPem, 'phase11/c8', WT) as string
    const copied = (signUnlockLine(leadPem, 'phase11/g2', WT) as string).replace('phase11/g2', 'phase11/c8')
    for (const text of [`phase11/c8 ${WT}`, 'phase11/c8', forged, copied]) expect(unlockedFor(text, ctx('phase11/c8'), pub), text).toBe(false)
  })

  it('a rename or another worktree does not carry the unlock (red team 9g)', () => {
    expect(unlockedFor(signUnlockLine(leadPem, 'phase11/g2', WT), ctx('phase11/g2', '/repo/.claude/worktrees/agent-9'), pub)).toBe(false)
  })

  it('nothing is unlocked without the lead public key (fail closed)', () => {
    expect(unlockedFor(signUnlockLine(leadPem, 'phase11/g2', WT), ctx('phase11/g2'), null)).toBe(false)
  })
})

describe('merge-wp: the product-rule e2e specs (red team G2-1)', () => {
  it('runs them when editor, core or renderer code changes', () => {
    expect(needsProductE2e(['packages/editor/src/BoxEditor.tsx'])).toBe(true)
    expect(needsProductE2e(['packages/core/src/plaintext.ts'])).toBe(true)
    expect(needsProductE2e(['packages/desktop/src/renderer/src/App.tsx'])).toBe(true)
    expect(needsProductE2e(['packages/desktop/src/main/index.ts', 'docs/x.md'])).toBe(false)
  })
})
