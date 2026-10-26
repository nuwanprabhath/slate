// @ts-check
import { afterAll, describe, expect, it } from 'vitest'
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
  if (typed) typedProgramSanity()
  return new RuleTester({
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true }, ...(typed ? TYPED : {}) },
    },
  })
}

/** The parser options of a typed case. */
const TYPED = { project: './tools/eslint-rules/fixtures/tsconfig.json', tsconfigRootDir: ROOT }

/**
 * The typed rules skip quietly when they get no types (a plain `eslint` run on a file outside a
 * project), so a typed RuleTester whose program is wrong would pass every `invalid` case as 0 errors
 * only by failing them, or worse, pass `valid` cases vacuously. This registers, in every file that
 * builds a typed RuleTester, a test that the program parsed the case's own code (not the fixture
 * on disk) and resolved `Buffer` from @types/node and `Database` from @slate/native.
 */
function typedProgramSanity() {
  describe('typed RuleTester: the program has real types', () => {
    it('parses the case code and resolves Buffer (@types/node) and Database (@slate/native)', () => {
      const code = "import type { Database } from '@slate/native'\nexport declare const b: Buffer\nexport declare const db: Database\n"
      const parsed = tseslint.parser.parseForESLint(code, { ...TYPED, filePath: FIXTURE, ecmaFeatures: { jsx: true } })
      const services = /** @type {any} */ (parsed.services)
      expect(services?.program, 'typescript-eslint built no program for the typed cases').toBeTruthy()
      expect(services.program.getSourceFile(FIXTURE)?.text, 'the program read the fixture from disk, not the case code').toBe(code)
      const checker = services.program.getTypeChecker()
      /** @param {any} sym */
      const files = (sym) => (sym?.getDeclarations() ?? []).map((/** @type {any} */ d) => d.getSourceFile().fileName.split('\\').join('/'))
      /** Where the type of a declared variable is declared. @param {any} id */
      const typeDeclaredIn = (id) => files(checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(id)).getSymbol())
      /** Where an imported name is declared. @param {any} id */
      const importDeclaredIn = (id) => files(checker.getAliasedSymbol(checker.getSymbolAtLocation(services.esTreeNodeToTSNodeMap.get(id))))
      const body = /** @type {any[]} */ (parsed.ast.body)
      const buffer = body[1].declaration.declarations[0].id
      const database = body[0].specifiers[0].local
      expect(typeDeclaredIn(buffer).some((f) => f.includes('/node_modules/@types/node/')), 'Buffer did not resolve from @types/node').toBe(true)
      expect(importDeclaredIn(database).some((f) => f.includes('/packages/native/')), 'Database did not resolve from @slate/native').toBe(true)
    })
  })
}

/** The file a typed case is parsed as. */
export const FIXTURE = `${ROOT}/tools/eslint-rules/fixtures/file.ts`

/** A case at a repo path (rules scope themselves by path). */
export const at = (/** @type {string} */ filename, /** @type {string} */ code) => ({ filename: `${ROOT}/${filename}`, code })
