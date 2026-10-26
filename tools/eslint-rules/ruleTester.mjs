// @ts-check
import { afterAll, describe, it } from 'vitest'
import { RuleTester, tseslint } from '../lint/index.mjs'
import { ROOT } from './paths.mjs'

// RuleTester reports through the test framework's describe/it.
RuleTester.afterAll = afterAll
RuleTester.describe = describe
RuleTester.it = it
RuleTester.itOnly = it.only

/**
 * A RuleTester that parses TypeScript and TSX like the repo's config. With `typed`, it also builds
 * type information from tools/eslint-rules/fixtures (for rules that read types): a typed case
 * uses `FIXTURE` as its filename, whose contents RuleTester replaces with the case's code.
 */
export function ruleTester({ typed = false } = {}) {
  return new RuleTester({
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        ...(typed ? { project: './tools/eslint-rules/fixtures/tsconfig.json', tsconfigRootDir: ROOT } : {}),
      },
    },
  })
}

/** The file a typed case is parsed as. */
export const FIXTURE = `${ROOT}/tools/eslint-rules/fixtures/file.ts`

/** A case at a repo path (rules scope themselves by path). */
export const at = (/** @type {string} */ filename, /** @type {string} */ code) => ({ filename: `${ROOT}/${filename}`, code })
