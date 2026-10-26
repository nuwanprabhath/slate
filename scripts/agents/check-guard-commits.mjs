#!/usr/bin/env node
// CI backstop for the guard-edits hook, which cannot sandbox Bash fully: every non-merge commit
// since the branch left ${SLATE_BASE_REF:-main} that changes a guard file must carry a
// `Guardrail-Change: <why>` trailer, which only a branch the lead unlocked writes (CLAUDE.md,
// Guardrails). Runs in the CI lint job; merge-wp separately refuses guard changes from a branch
// that is not unlocked.
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GUARDRAIL_TRAILER, unmarkedGuardCommits } from './review-gate.mjs'

// Phase 11 G1 built the guard layer before this check existed; its commits predate the trailer.
const EXEMPT = [
  '6ad180888a5911e8d86503b23d6250052fe5c9ce', 'd19a9f8f6bc667a3c1b38d2b095d69797a41d99e', '14e8a513e208a355a1bc2e63d920fa08fb84082c',
  '421d951b1c716563b294d6f47f14b06f087d1f7a', '0e17c4025c4485d967f307367350c6a733377e42', '6e489fd754a65dff64414d38c8a320b9c1c86c1c',
  '033588f4fb3de382baa6adc3c8fe98bc796527a5', 'fd41bde191ca9270e3f99f4fe5018ebe81725e61', 'b4626034b5e880cb0f92235eb29f0ceb81cf3333',
  '2a85013c87fba1efef1ba583de8b6122e154393d', '8a920da2f81e2dc375cfab2a0445a0feb47ee02b', '246298ddafe5c33dbf08883ce42f9c557b37c70e',
  'cd70eb7abcb92a892d7f4994aaac47e4202d58f9', '330cbc82b59b3e779f242e14424f087fb97d1af0', '12aac0683b981ff8c6ff10048724c50e64720739',
  'e5b5a5dd5a75055b8e0d4e46fbe8e6be822b69f4', '5ce1fb7b4d9348eff3ad70e2ce6810730d586c6d', '043d4f015ef4340efc46161631ed90c23f40cd2a',
  'd06bebf1a7159c91d520cc3e559713aca268ba10', '03a3dca20ebc5239239fb350cd919b2f659572d3',
]

/** Parses `git log --no-merges --format=%x1e%H%x1f%B%x1f --name-only`. */
export function parseLog(text) {
  return text
    .split('\x1e')
    .filter((chunk) => chunk.trim() !== '')
    .map((chunk) => {
      const [sha = '', message = '', files = ''] = chunk.split('\x1f')
      return { sha: sha.trim(), message, files: files.split('\n').map((f) => f.trim()).filter(Boolean) }
    })
}

function main() {
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
  const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout ?? ''
  const base = git(['merge-base', 'HEAD', process.env.SLATE_BASE_REF || 'main']).trim()
  if (!base) {
    process.stderr.write('check-guard-commits: no merge base; fetch the base branch (fetch-depth: 0).\n')
    process.exit(1)
  }
  const bad = unmarkedGuardCommits(parseLog(git(['log', '--no-merges', '--format=%x1e%H%x1f%B%x1f', '--name-only', `${base}..HEAD`])), EXEMPT)
  if (bad.length === 0) process.exit(0)
  process.stderr.write(
    `check-guard-commits: these commits change guard files without a "${GUARDRAIL_TRAILER} <why>" trailer, so they did not come from a branch unlocked for guardrail work:\n` +
      bad.map((c) => `  ${c.sha.slice(0, 12)} ${c.message.split('\n')[0]} (${c.files.filter(Boolean).slice(0, 4).join(', ')})`).join('\n') +
      '\nUse the accepted path the failing check names instead, or ask the maintainer to unlock the branch (CLAUDE.md, Guardrails).\n',
  )
  process.exit(1)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
