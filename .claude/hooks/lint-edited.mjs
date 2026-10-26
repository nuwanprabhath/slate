#!/usr/bin/env node
// PostToolUse (Edit|Write|MultiEdit): lint the one file the agent just changed and hand any error
// straight back, so a slate/* rule is met while the file is open, not at commit or stop time.
// Exit 2 = feedback to the agent. Skipped when the lint toolchain is not installed.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

let input
try {
  input = JSON.parse(readFileSync(0, 'utf8'))
} catch {
  process.exit(0)
}
const file = input?.tool_input?.file_path
if (typeof file !== 'string' || !/\.(ts|tsx|mjs)$/.test(file) || !existsSync(file)) process.exit(0)

// The checkout (main or a worktree) that owns the file: the nearest folder with eslint.config.mjs.
let root = dirname(file)
while (!existsSync(join(root, 'eslint.config.mjs'))) {
  const up = dirname(root)
  if (up === root) process.exit(0)
  root = up
}
const rel = relative(root, file)
if (rel.startsWith('..') || /(^|\/)(node_modules|out|dist|release|\.claude\/worktrees)\//.test(rel)) process.exit(0)
const eslint = join(root, 'tools/lint/node_modules/.bin/eslint')
if (!existsSync(eslint)) process.exit(0)

// Untyped (SLATE_LINT_FAST, see eslint.config.mjs) to stay well under the hook's time budget; the
// type-aware rules run in lint:changed at stop time.
const r = spawnSync(eslint, ['--max-warnings', '0', '--no-warn-ignored', rel], { cwd: root, encoding: 'utf8', timeout: 20_000, env: { ...process.env, SLATE_LINT_FAST: '1' } })
if (r.status === 0 || r.error) process.exit(0)
process.stderr.write(`Lint failed for ${rel}. Fix it now; each slate/* message names the accepted path:\n${r.stdout}${r.stderr}`)
process.exit(2)
