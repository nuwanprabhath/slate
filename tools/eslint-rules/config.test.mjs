// @ts-check
import { describe, expect, it } from 'vitest'
import { ESLint } from '../lint/index.mjs'
import { ROOT } from './paths.mjs'

/**
 * The repo's own eslint.config.mjs, run on snippets: the comment rules that stop an agent writing
 * its way past a guard rule. A plain .mjs path keeps it untyped and fast.
 */
const eslint = new ESLint({ cwd: ROOT })
const rulesHit = async (/** @type {string} */ code) => {
  const [result] = await eslint.lintText(code, { filePath: `${ROOT}/tools/zz-config-probe.mjs` })
  return (result?.messages ?? []).map((m) => m.ruleId)
}

describe('eslint.config.mjs: comments cannot switch a guard off', () => {
  it('refuses an inline config comment, even with a reason (red team 9a)', async () => {
    expect(await rulesHit('/* eslint slate/no-math-random: off, slate/log-through-logger: 0 -- reason */\nexport const x = 1\n')).toContain('@eslint-community/eslint-comments/no-use')
    expect(await rulesHit('/* global fetch */\nexport const x = 1\n')).toContain('@eslint-community/eslint-comments/no-use')
    expect(await rulesHit('/* eslint-env node */\nexport const x = 1\n')).toContain('@eslint-community/eslint-comments/no-use')
  })

  it('refuses a block disable and a disable of a guard rule', async () => {
    expect(await rulesHit('/* eslint-disable */\nexport const x = 1\n')).toEqual(expect.arrayContaining(['@eslint-community/eslint-comments/no-use']))
    expect(await rulesHit('// eslint-disable-next-line slate/no-shell-option -- it is fine\nexport const x = { shell: true }\n')).toContain('@eslint-community/eslint-comments/no-restricted-disable')
  })

  it('accepts a line disable of an ordinary rule that says why', async () => {
    expect(await rulesHit('// eslint-disable-next-line no-control-regex -- control characters are what it strips\nexport const re = /[\\u0000-\\u001f]/\n')).toEqual([])
  })
})
