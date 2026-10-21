// "A test that fails without the change and passes with it" (CLAUDE.md, Definition of done),
// checked rather than claimed. The branch's changed unit tests run against the branch BASE's
// packages/*/src in a throwaway worktree; at least one must fail. A test that cannot even load on
// the base (it imports what the change added) counts as failing.
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** Returns a problem string, or null when shown red on base (or the check does not apply). */
export function testsFailOnBase({ root, base, changed, git }) {
  if (!base) return null
  const src = changed.filter((f) => /^packages\/(core|editor|mcp|importer)\/src\//.test(f) && !f.endsWith('.css'))
  const tests = changed.filter((f) => /^packages\/(core|editor|mcp|importer)\/test\/.*\.test\.tsx?$/.test(f))
  if (src.length === 0 || tests.length === 0) return null
  if (git(['log', '--format=%(trailers:key=No-Red-Test-Reason,valueonly)', `${base}..HEAD`]).trim() !== '') return null

  const dir = mkdtempSync(join(tmpdir(), 'slate-red-on-base-'))
  const tree = join(dir, 'tree')
  try {
    if (spawnSync('git', ['worktree', 'add', '--detach', '--quiet', tree, base], { cwd: root }).status !== 0) return null
    for (const t of tests) {
      mkdirSync(dirname(join(tree, t)), { recursive: true })
      cpSync(join(root, t), join(tree, t))
    }
    // The branch's installed packages, except the workspace links: those must point at the
    // base's own packages, or the "old" code would be the branch's.
    const nm = join(tree, 'node_modules')
    mkdirSync(nm)
    for (const entry of readdirSync(join(root, 'node_modules'))) {
      if (entry !== '@slate') symlinkSync(join(root, 'node_modules', entry), join(nm, entry))
    }
    mkdirSync(join(nm, '@slate'))
    for (const p of readdirSync(join(tree, 'packages'))) {
      const manifest = join(tree, 'packages', p, 'package.json')
      if (!existsSync(manifest)) continue
      const name = JSON.parse(readFileSync(manifest, 'utf8')).name
      if (typeof name === 'string' && name.startsWith('@slate/')) symlinkSync(join(tree, 'packages', p), join(nm, name))
    }
    const r = spawnSync('node', [join(root, 'node_modules/vitest/vitest.mjs'), 'run', ...tests], { cwd: tree, encoding: 'utf8' })
    if (r.status !== 0) return null
    return `── tests pass without the change ──\nEvery changed unit test (${tests.slice(0, 4).join(', ')}) also passes on the base's packages/*/src (${base.slice(0, 8)}), so none of them proves the change.\nWrite a test that states the new behaviour, see it fail on the old code, then make it pass. For a pure refactor, say why in a commit trailer: \`No-Red-Test-Reason: <why>\`.`
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', tree], { cwd: root })
    rmSync(dir, { recursive: true, force: true })
    spawnSync('git', ['worktree', 'prune'], { cwd: root })
  }
}
