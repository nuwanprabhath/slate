// @ts-check
import plugin from './plugin.mjs'
import { at, ruleTester } from './ruleTester.mjs'

const rule = /** @type {any} */ (plugin.rules?.['env-through-test-hooks'])
const err = [{ messageId: 'direct' }]

ruleTester().run('slate/env-through-test-hooks', rule, {
  valid: [
    at('packages/desktop/src/main/x.ts', "import { env } from './testHooks'\nexport const weak = env('SLATE_TEST_WEAK_KDF') === '1'"),
    at('packages/desktop/src/main/x.ts', "import { envSnapshot } from './testHooks'\nexport const all = envSnapshot()"),
    at('packages/desktop/src/main/testHooks.ts', 'export const v = process.env.SLATE_TEST_WEAK_KDF'),
    at('packages/desktop/src/main/x.test.ts', 'export const e2e = process.env.SLATE_E2E'),
    at('packages/desktop/e2e/helpers.ts', 'export const e2e = process.env.SLATE_E2E'),
    at('packages/desktop/src/main/x.ts', 'export const p = process.platform'),
  ],
  invalid: [
    // index.ts before phase 10 F1 #6: a weak KDF taken from the environment, obeyed even when packaged.
    { ...at('packages/desktop/src/main/index.ts', "declare const isE2E: boolean\nexport const weakKdf = isE2E && process.env.SLATE_TEST_WEAK_KDF === '1'"), errors: err },
    { ...at('packages/desktop/src/main/onenote/auth.ts', "export const url = process.env['SLATE_GRAPH_URL'] ?? 'https://graph.microsoft.com/v1.0'"), errors: err },
    { ...at('packages/desktop/src/main/x.ts', 'declare const name: string\nexport const v = process.env[name]'), errors: err },
    { ...at('packages/desktop/src/main/x.ts', 'export const { SLATE_TEST_IDLE_MS } = process.env'), errors: err },
    // Red team 3a: the dependency-injection default, an alias, a whole-env read and a computed `env`.
    { ...at('packages/desktop/src/main/x.ts', 'export function debugFlags(vars: NodeJS.ProcessEnv = process.env) { return vars.SLATE_TEST_SKIP_KDF }'), errors: err },
    { ...at('packages/desktop/src/main/x.ts', 'const all = process.env\nexport const v = all.SLATE_INSECURE'), errors: err },
    { ...at('packages/desktop/src/main/x.ts', 'export const n = Object.entries(process.env).length'), errors: err },
    { ...at('packages/desktop/src/main/x.ts', "export const v = process['env']['SLATE_X']"), errors: err },
    { ...at('packages/desktop/src/main/x.ts', 'export const shell = process.env.SHELL'), errors: err },
    // Red team G2-7: destructuring process, and importing it.
    { ...at('packages/sync/src/gitDrive.ts', 'const { env } = process\nexport const v = env.SLATE_SYNC_INSECURE'), errors: err },
    { ...at('packages/sync/src/gitDrive.ts', "import { env } from 'node:process'\nexport const v = env.SLATE_SYNC_INSECURE"), errors: err },
    { ...at('packages/mcp/src/x.ts', "import proc from 'process'\nexport const v = proc.env.SLATE_X"), errors: err },
    // Red team re-run R4: the packages main loads.
    { ...at('packages/sync/src/gitDrive.ts', "export const v = process.env.SLATE_SYNC_FORCE"), errors: err },
    { ...at('packages/mcp/src/x.ts', "export const v = process.env.SLATE_MCP_DEBUG"), errors: err },
  ],
})
