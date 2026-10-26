import { describe, expect, it } from 'vitest'
import { globToRegExp } from '../eslint-rules/paths.mjs'
import { read, walk } from './repo'

/** The hooks and gates that run the checks stay wired: removing one is as good as deleting the check. */
describe('agent hooks (.claude/settings.json)', () => {
  const settings = JSON.parse(read('.claude/settings.json')) as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>> }
  const commands = (event: string) => (settings.hooks[event] ?? []).flatMap((h) => h.hooks.map((c) => ({ matcher: h.matcher ?? '', command: c.command })))

  it('guard-edits runs before every edit and shell command', () => {
    const pre = commands('PreToolUse').find((c) => c.command.includes('guard-edits.mjs'))
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'Read']) expect(pre?.matcher.split('|'), tool).toContain(tool)
  })

  it('lint-edited runs after every edit, and the definition of done at every stop', () => {
    expect(commands('PostToolUse').some((c) => c.command.includes('lint-edited.mjs') && /Edit/.test(c.matcher) && /Write/.test(c.matcher))).toBe(true)
    expect(commands('Stop').some((c) => c.command.includes('definition-of-done.mjs'))).toBe(true)
    expect(commands('SubagentStop').some((c) => c.command.includes('definition-of-done.mjs'))).toBe(true)
  })
})

describe('the Stop hook covers every check', () => {
  const hook = read('.claude/hooks/definition-of-done.mjs')

  it('runs typecheck, lint:changed and guards', () => {
    for (const script of ['typecheck', 'lint:changed', 'guards']) expect(hook, script).toMatch(new RegExp(`\\[\\s*'run',\\s*'${script}'`))
  })

  it('names the security-sensitive paths for review', () => {
    expect(hook).toContain('tools/guards/security-paths.txt')
    expect(hook).toContain('security-reviewer')
  })
})

describe('git hooks and CI', () => {
  it('pre-commit lints the staged files', () => {
    expect(read('.githooks/pre-commit')).toMatch(/eslint/)
  })

  it('CI has a lint job running npm run lint and npm run guards', () => {
    const ci = read('.github/workflows/ci.yml')
    expect(ci).toMatch(/^ {2}lint:/m)
    expect(ci).toContain('npm run lint')
    expect(ci).toContain('npm run guards')
    expect(ci).toContain('node scripts/agents/check-guard-commits.mjs')
  })
})

describe('tools/guards/security-paths.txt', () => {
  const globs = read('tools/guards/security-paths.txt')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'))
  const files = [...walk('packages', ['.ts', '.tsx', '.json', '.html', '.cjs'], (rel) => /\/(out|dist|release|test-results)$/.test(rel)), ...walk('tools', ['.ts', '.mjs', '.json', '.txt']), ...walk('.claude', ['.mjs', '.json', '.md'])]

  it('covers the vault, the IPC door, the preload, the CSP, the guard files and the build config', () => {
    const covered = (f: string) => globs.some((g) => globToRegExp(g).test(f))
    for (const f of [
      'packages/desktop/src/main/vault/crypto.ts',
      'packages/desktop/src/main/ipcGuard.ts',
      'packages/desktop/src/preload/index.ts',
      'packages/desktop/src/renderer/index.html',
      'packages/desktop/electron-builder.cjs',
      'tools/eslint-rules/sanctioned.mjs',
      'tools/guards/allowlists/dependencies.json',
      '.claude/hooks/guard-edits.mjs',
      'packages/native/src/binding.c',
    ]) {
      expect(covered(f), f).toBe(true)
    }
    expect(covered('packages/desktop/src/renderer/src/App.tsx')).toBe(false)
  })

  it('every glob still matches something (except packages/native, which C2 adds)', () => {
    // Root files and folders this walk does not visit are left out; so is packages/native until C2.
    // C8 adds hardening.ts and secretStorage.ts (audit B-1, B-5); they are reviewed from their first commit.
    const future = new Set(['packages/desktop/src/main/hardening.ts', 'packages/desktop/src/main/secretStorage.ts'])
    const stale = globs.filter((g) => g.includes('/') && !future.has(g) && !g.startsWith('packages/native') && !/^(\.github|\.githooks|scripts)\//.test(g) && !files.some((f) => globToRegExp(g).test(f)))
    expect(stale).toEqual([])
  })
})
