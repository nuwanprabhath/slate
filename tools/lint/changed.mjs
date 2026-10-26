#!/usr/bin/env node
// `npm run lint:changed`: ESLint on the files this branch changed since it left
// ${SLATE_BASE_REF:-main} (committed, staged, unstaged and untracked), plus the dependency-cruiser
// layers on the whole graph (one import can break a layer far from the file that changed).
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const bin = (name) => join(root, 'tools/lint/node_modules/.bin', name)
if (!existsSync(bin('eslint'))) {
  process.stderr.write('lint:changed: the lint toolchain is not installed. Run `npm install` (its postinstall runs `npm ci --prefix tools/lint`).\n')
  process.exit(1)
}
const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout ?? ''
const base = git(['merge-base', 'HEAD', process.env.SLATE_BASE_REF || 'main']).trim()
const files = [
  ...new Set([
    ...(base ? git(['diff', '--name-only', '--diff-filter=d', base]).split('\n') : []),
    ...git(['diff', '--name-only', '--diff-filter=d', 'HEAD']).split('\n'),
    ...git(['ls-files', '--others', '--exclude-standard']).split('\n'),
  ]),
].filter((f) => /\.(ts|tsx|mjs|cjs|js)$/.test(f) && existsSync(join(root, f)))

let status = 0
if (files.length > 0) {
  const r = spawnSync(bin('eslint'), ['--max-warnings', '0', '--no-warn-ignored', ...files], { cwd: root, stdio: 'inherit' })
  status = r.status ?? 1
}
const arch = spawnSync(bin('depcruise'), ['packages', '--config', '.dependency-cruiser.cjs', '--output-type', 'err'], { cwd: root, stdio: 'inherit' })
process.exit(status || (arch.status ?? 1))
