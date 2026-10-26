// @ts-check
import plugin from './plugin.mjs'
import { at, ruleTester } from './ruleTester.mjs'

const rule = /** @type {any} */ (plugin.rules?.['skip-needs-reason'])
const T = 'packages/core/test/x.test.ts'

ruleTester().run('slate/skip-needs-reason', rule, {
  valid: [
    at(T, "// Waits for the native boundary (C4).\nit.skip('keys stay in native memory', () => {})"),
    at(T, "it.todo('T-STATIC-02 no node:crypto in main/vault (C4)')"),
    at('packages/desktop/e2e/titlebar.spec.ts', "declare const test: { skip(c: boolean, why: string): void }\ntest.skip(process.platform === 'darwin', 'macOS keeps its system menu bar')"),
    at(T, "// Needs the built bundle.\nit.skipIf(true)('relays', () => {})"),
    at('packages/core/src/x.ts', "declare const it: { skip(n: string, f: () => void): void }\nit.skip('not a test file', () => {})"),
    // C11: runIf is a skip with the condition reversed, and says why like skipIf.
    at(T, "declare const linux: boolean\n// /proc is Linux only.\nit.runIf(linux)('reads /proc', () => {})"),
    at(T, "// Waits for C9.\nit.skip.each([1, 2])('n=%i', () => {})"),
  ],
  invalid: [
    { ...at(T, "it.skip('flaky on CI', () => {})"), errors: [{ messageId: 'reason' }] },
    { ...at(T, "describe.skip('vault', () => {})"), errors: [{ messageId: 'reason' }] },
    { ...at(T, "it.todo('later')"), errors: [{ messageId: 'reason' }] },
    { ...at(T, "declare const missing: boolean\nit.skipIf(missing)('relays', () => {})"), errors: [{ messageId: 'reason' }] },
    // C11 bypasses: runIf, a chained skip, a skip taken as a value, and describe.runIf.
    { ...at(T, "declare const linux: boolean\nit.runIf(linux)('reads /proc', () => {})"), errors: [{ messageId: 'reason' }] },
    { ...at(T, "describe.runIf(process.platform === 'linux')('linux', () => {})"), errors: [{ messageId: 'reason' }] },
    { ...at(T, "it.skip.each([1, 2])('n=%i', () => {})"), errors: [{ messageId: 'reason' }] },
    { ...at(T, "declare const linux: boolean\nconst maybe = linux ? it : it.skip\nmaybe('a', () => {})"), errors: [{ messageId: 'reason' }] },
    { ...at(T, "test.concurrent.runIf(true)('a', () => {})"), errors: [{ messageId: 'reason' }] },
    // Review C11: a skip taken by destructuring or computed access.
    { ...at(T, "const { skip } = it\nskip('a', () => {})"), errors: [{ messageId: 'reason' }] },
    { ...at(T, "it['skip']('a', () => {})"), errors: [{ messageId: 'reason' }] },
    // Fix check 2 (C11): a skip on a runner made by .extend, or loaded at run time.
    { ...at('packages/desktop/e2e/x.spec.ts', "import { test as base } from '@playwright/test'\nconst x = base.extend({})\nx.skip('a', async () => {})"), errors: [{ messageId: 'reason' }] },
    { ...at(T, "const { it: t } = await import('vitest')\nt.skip('a', () => {})"), errors: [{ messageId: 'reason' }] },
    // Fix check C11: a skip through a renamed or namespace import is still a skip.
    { ...at(T, "import { it as t } from 'vitest'\nt.skip('a', () => {})"), errors: [{ messageId: 'reason' }] },
    { ...at(T, "import * as v from 'vitest'\nv.it.skip('a', () => {})"), errors: [{ messageId: 'reason' }] },
    { ...at('packages/desktop/e2e/x.spec.ts', "import { test as x } from '@playwright/test'\nx.fixme('a', async () => {})"), errors: [{ messageId: 'reason' }] },
  ],
})
