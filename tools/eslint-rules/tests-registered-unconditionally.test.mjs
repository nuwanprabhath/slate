// @ts-check
import plugin from './plugin.mjs'
import { at, ruleTester } from './ruleTester.mjs'

const rule = /** @type {any} */ (plugin.rules?.['tests-registered-unconditionally'])
const T = 'packages/core/test/x.test.ts'
const M = 'packages/desktop/src/main/x.test.ts'
const E = 'packages/desktop/e2e/x.spec.ts'
const D = 'declare const cond: boolean, it: any, test: any, describe: any\n'
const err = [{ messageId: 'unconditional' }]

ruleTester().run('slate/tests-registered-unconditionally', rule, {
  valid: [
    at(T, D + "it('a', () => {})\ndescribe('b', () => { it('c', () => {}) })"),
    // Parametrised tests are legitimate.
    at(T, D + "for (const n of [1, 2]) it(`n=${n}`, () => {})\ndescribe('b', () => { for (const x of ['y']) test(x, () => {}) })"),
    at(T, D + "it.each([1, 2])('n=%i', () => {})"),
    // Inside a test body or a hook, a condition is ordinary test logic.
    at(T, D + "it('a', () => { if (cond) test.skip() })"),
    at(E, D + "test('a', async () => { if (cond) { test.info() } })"),
    // Playwright's conditional skip is registered unconditionally and counted by the skip ratchet.
    at(E, D + "test.skip(cond, 'macOS only')"),
    // Not a test file.
    at('packages/core/src/x.ts', D + "if (cond) it('a', () => {})"),
    // C11: a loop or forEach over a full list is parametrisation; a list built by filter is left to review.
    at(T, D + "const CASES = [1, 2]\nfor (const c of CASES) it(`c=${c}`, () => {})\nCASES.forEach((c) => it(`d=${c}`, () => {}))"),
    at(T, D + "const CASES = [1, 2].filter((c) => c > 0)\ndescribe('b', () => { for (const c of CASES) it(`c=${c}`, () => {}) })"),
    // Conditions inside a test body or hook stay ordinary logic, a helper without a condition is fine, and a
    // condition in a helper that registers nothing (a step) is not a test.
    at(T, D + "declare const beforeAll: any\nbeforeAll(() => { if (cond) test.skip() })\nconst reg = (n: string) => it(n, () => {})\nreg('a')"),
    at(E, D + "test('a', async () => { const s = async () => { if (cond) await test.step('x', async () => {}) }; await s() })"),
    // The condition is the test of a ternary, not what it chooses.
    at(T, D + "it(cond ? 'a' : 'b', () => {})"),
    // Playwright fixtures extend a renamed base and register nothing with it.
    at('packages/desktop/e2e/fixtures.ts', "import { test as base } from '@playwright/test'\nexport const test = base.extend({})"),
    // An indexed loop over a full list, and an early return inside a test body.
    at(T, D + "const C = [1, 2]\nfor (let i = 0; i < C.length; i++) it(`i=${i}`, () => {})"),
    at(T, D + "it('a', () => { if (cond) return; test.skip() })"),
    // A property or type member named like a runner is not the runner.
    at(T, D + "const r: { test: string } = { test: 'x' }\nit('a', () => { void r.test })"),
  ],
  invalid: [
    // Review M-R1 of phase11/c8: a test that silently does not exist until a fixture appears.
    { ...at(E, D + "if (cond) test('C8 criterion 3', async () => {})"), errors: err },
    { ...at(T, D + "cond && it('a', () => {})"), errors: err },
    { ...at(T, D + "cond ? it('a', () => {}) : it.skip('a', () => {})"), errors: [...err, ...err] },
    { ...at(M, D + "describe('b', () => { if (cond) { it('c', () => {}) } })"), errors: err },
    { ...at(T, D + "switch (process.platform) { case 'darwin': describe('mac', () => {}) }"), errors: err },
    { ...at(T, D + "try { it.only('a', () => {}) } catch {}"), errors: err },
    { ...at(T, D + "if (cond) it.each([1])('n=%i', () => {})"), errors: err },
    { ...at(E, D + "if (cond) test.describe('x', () => {})"), errors: err },
    // C11 (C8 review residual): loops over conditional lists, directly or through a const.
    { ...at(T, D + "for (const c of cond ? [1, 2] : []) it(`c=${c}`, () => {})"), errors: [{ messageId: 'conditionalLoop' }] },
    { ...at(T, D + "const CASES = cond ? [1, 2] : []\ndescribe('b', () => { for (const c of CASES) it(`c=${c}`, () => {}) })"), errors: [{ messageId: 'conditionalLoop' }] },
    { ...at(T, D + "const CASES = (cond && [1, 2]) || []\nCASES.forEach((c) => it(`c=${c}`, () => {}))"), errors: [{ messageId: 'conditionalLoop' }] },
    { ...at(T, D + ";(cond ? [1] : []).map((c) => describe(`c=${c}`, () => {}))"), errors: [{ messageId: 'conditionalLoop' }] },
    // A runner chosen by a condition.
    { ...at(T, D + "const maybe = cond ? it : it.skip\nmaybe('a', () => {})"), errors: [{ messageId: 'chosenRunner' }, { messageId: 'chosenRunner' }] },
    { ...at(T, D + ";(cond && describe)('x', () => {})"), errors: [{ messageId: 'chosenRunner' }] },
    // A helper that registers under a condition.
    { ...at(T, D + "function maybe(n: string, f: () => void) { if (cond) it(n, f) }\nmaybe('a', () => {})"), errors: [{ messageId: 'helper' }] },
    { ...at(E, D + "const linuxOnly = (n: string, f: () => Promise<void>) => cond && test(n, f)\nlinuxOnly('a', async () => {})"), errors: [{ messageId: 'helper' }] },
    // Review C11: an early exit before the registration, in a helper or a describe body.
    { ...at(T, D + "function maybe(n: string, f: () => void) { if (!cond) return; it(n, f) }\nmaybe('a', () => {})"), errors: [{ messageId: 'helper' }] },
    { ...at(T, D + "describe('x', () => { if (!cond) return; it('a', () => {}) })"), errors: err },
    { ...at(T, D + "describe('x', () => { if (!cond) { throw new Error('no') } it('a', () => {}) })"), errors: err },
    // A conditional list handed to .each.
    { ...at(T, D + "it.each(cond ? [1] : [])('n=%i', () => {})"), errors: [{ messageId: 'conditionalLoop' }] },
    { ...at(T, D + "const CASES = cond ? [[1]] : []\ndescribe.each(CASES)('x %i', () => {})"), errors: [{ messageId: 'conditionalLoop' }] },
    // let, spread and slice of a conditional list.
    { ...at(T, D + "let CASES = cond ? [1] : []\nfor (const c of CASES) it(`c=${c}`, () => {})"), errors: [{ messageId: 'conditionalLoop' }] },
    { ...at(T, D + "for (const c of [...(cond ? [1] : [])]) it(`c=${c}`, () => {})"), errors: [{ messageId: 'conditionalLoop' }] },
    { ...at(T, D + "for (const c of (cond ? [1] : []).slice()) it(`c=${c}`, () => {})"), errors: [{ messageId: 'conditionalLoop' }] },
    // Indexed and while loops.
    { ...at(T, D + "for (let i = 0; i < (cond ? 1 : 0); i++) it(`i=${i}`, () => {})"), errors: [{ messageId: 'conditionalLoop' }] },
    { ...at(T, D + "while (cond) { it('a', () => {}); break }"), errors: [{ messageId: 'whileLoop' }] },
    { ...at(T, D + "do { it('a', () => {}) } while (cond)"), errors: [{ messageId: 'whileLoop' }] },
    // A runner picked by index, held in a value, or reached by computed access.
    { ...at(T, D + ";[it, () => {}][cond ? 0 : 1]('a', () => {})"), errors: [{ messageId: 'aliasRunner' }] },
    { ...at(T, D + "declare const R: any\nR[cond ? 'yes' : 'no']('a', () => {})"), errors: [{ messageId: 'computedRunner' }] },
    { ...at(T, D + "const t = it\nt('a', () => {})"), errors: [{ messageId: 'aliasRunner' }] },
    { ...at(T, D + "const { skip } = it\nskip('a', () => {})"), errors: [{ messageId: 'aliasRunner' }] },
    { ...at(T, D + "it['skip']('a', () => {})"), errors: [{ messageId: 'computedRunner' }] },
    // Fix check C11: a runner imported under another name or through a namespace, and what it then hides.
    { ...at(T, "import { it as t } from 'vitest'\nt('a', () => {})"), errors: [{ messageId: 'renamedRunner' }] },
    { ...at(E, "import { test as x } from '@playwright/test'\nx('a', async () => {})"), errors: [{ messageId: 'renamedRunner' }] },
    { ...at(E, "import { test as base } from '@playwright/test'\nexport const test = base.extend({})\nbase.skip('a', async () => {})"), errors: [{ messageId: 'renamedRunner' }, { messageId: 'extendOutsideFixtures' }] },
    // Fix check 2 (C11): a runner made by .extend under another name, or loaded at run time.
    { ...at(E, "import { test } from '@playwright/test'\ndeclare const c: boolean\nconst x = test.extend({})\nif (c) x('a', async () => {})"), errors: [{ messageId: 'extendOutsideFixtures' }, { messageId: 'unconditional' }] },
    { ...at(E, "import { test as base } from '@playwright/test'\nconst x = base.extend({})\nx.skip('a', async () => {})"), errors: [{ messageId: 'renamedRunner' }, { messageId: 'extendOutsideFixtures' }] },
    { ...at(T, "declare const c: boolean\nconst { it: t } = await import('vitest')\nif (c) t('a', () => {})"), errors: [{ messageId: 'dynamicRunnerImport' }, { messageId: 'unconditional' }] },
    { ...at(T, "declare const c: boolean, require: any\nconst { it: t } = require('vitest')\nif (c) t('a', () => {})"), errors: [{ messageId: 'dynamicRunnerImport' }, { messageId: 'unconditional' }] },
    { ...at('packages/desktop/e2e/fixtures.ts', "import { test as base } from '@playwright/test'\ndeclare const c: boolean\nexport const test = base.extend({})\nconst x = test.extend({})\nif (c) x('a', async () => {})"), errors: [{ messageId: 'extendOutsideFixtures' }, { messageId: 'unconditional' }] },
    { ...at(E, "import { describe as d } from './fixtures'\nd('a', () => {})"), errors: [{ messageId: 'renamedRunner' }] },
    { ...at(T, "import * as v from 'vitest'\nv.it('a', () => {})"), errors: [{ messageId: 'renamedRunner' }] },
    { ...at(T, "declare const cond: boolean\nimport { it as t } from 'vitest'\nif (cond) t('a', () => {})"), errors: [{ messageId: 'renamedRunner' }, { messageId: 'unconditional' }] },
    { ...at(T, "declare const cond: boolean\nimport * as v from 'vitest'\nif (cond) v.describe('a', () => {})"), errors: [{ messageId: 'renamedRunner' }, { messageId: 'unconditional' }] },
  ],
})
