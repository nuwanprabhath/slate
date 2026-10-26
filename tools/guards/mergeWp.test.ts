import { describe, expect, it } from 'vitest'
// @ts-expect-error -- plain JavaScript with no declaration file; the calls below pin its shape
import { checkReview, sensitiveFiles } from '../../scripts/agents/merge-wp.mjs'
import { read } from './repo'

const HEAD = '0123456789abcdef0123456789abcdef01234567'
const review = (body: string) => checkReview(body, HEAD) as string | null

describe('merge-wp: the review gate', () => {
  it('accepts a review of the branch head that ends in VERDICT: APPROVE', () => {
    expect(review(`# Security review\n\nCommit: ${HEAD.slice(0, 12)}\n\nNo findings.\n\nVERDICT: APPROVE\n`)).toBeNull()
    expect(review(`**Commit:** \`${HEAD}\`\n\nVERDICT: APPROVE`)).toBeNull()
  })

  it('refuses a missing review, a CHANGES verdict, a verdict not on the last line, and a review of another commit', () => {
    expect(review(null as unknown as string)).toMatch(/no review/)
    expect(review(`Commit: ${HEAD}\n\nVERDICT: CHANGES\n`)).toMatch(/VERDICT: APPROVE/)
    expect(review(`Commit: ${HEAD}\nVERDICT: APPROVE\n\nOne more thing: fix the IPC sender check.\n`)).toMatch(/last line/)
    expect(review('VERDICT: APPROVE')).toMatch(/Reviewed/)
    expect(review('Commit: deadbeef00\n\nVERDICT: APPROVE')).toMatch(/branch head/)
  })

  it('finds the security-sensitive files a branch changed', () => {
    const changed = ['packages/desktop/src/main/vault/crypto.ts', 'packages/desktop/src/renderer/src/App.tsx', 'eslint.config.mjs', 'docs/x.md']
    expect(sensitiveFiles(changed, read('tools/guards/security-paths.txt'))).toEqual(['packages/desktop/src/main/vault/crypto.ts', 'eslint.config.mjs'])
  })

  it('never pushes', () => {
    expect(read('scripts/agents/merge-wp.mjs')).not.toMatch(/['"]push['"]/)
  })
})
