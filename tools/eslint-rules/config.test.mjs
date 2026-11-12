// @ts-check
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ESLint } from '../lint/index.mjs'
import { ROOT } from './paths.mjs'
import { CUSTOM } from './plugin.mjs'

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

/**
 * `slate/secret-bytes-stay-bytes` keeps a typed secret out of text. Its sanctioned homes are a design
 * decision, so each one is named here: a home that grows silently is how a rule like this stops meaning
 * anything. Two were added for T-ZERO-09 (POAM-10), when main stopped keeping a generated recovery key
 * as a string it could not zero, which left exactly two places that must take the bytes.
 */
describe('secret-bytes-stay-bytes: the sanctioned homes', () => {
  const entry = CUSTOM.find((c) => c.name === 'secret-bytes-stay-bytes')

  it('is exactly these three files, and each one is real', () => {
    expect(entry?.allow).toEqual([
      // The password policy needs the text of a password being set (review C7 L2).
      'packages/desktop/src/main/vault/password.ts',
      // A displayed recovery key has to be text, and in this window it may be: the process exits after unlock (Z-6).
      'packages/desktop/src/renderer/src/vault/secretText.ts',
      // The file the person asked Slate to save the key to; a secret reaches no other file sink.
      'packages/desktop/src/main/recoverySave.ts',
    ])
    for (const f of entry?.allow ?? []) expect(existsSync(join(ROOT, f)), f).toBe(true)
  })

  it('still covers the files around each home', () => {
    // The exemption is one file, not its folder: shared/secret.ts and the save handler next door are
    // covered, and that is what stops the conversion drifting back towards main.
    const files = entry?.files ?? []
    expect(files).toContain('packages/desktop/src/{main,preload,renderer,shared}/**/*.{ts,tsx}')
    for (const near of ['packages/desktop/src/shared/secret.ts', 'packages/desktop/src/main/index.ts', 'packages/desktop/src/main/vault/recoveryFile.ts']) {
      expect(entry?.allow).not.toContain(near)
    }
  })
})
