// @ts-check
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { allowlist, matchesAny, ROOT } from './paths.mjs'
import plugin, { CUSTOM, slateRules } from './plugin.mjs'
import { MAIN_PROCESS } from './sanctioned.mjs'
import { at, ruleTester } from './ruleTester.mjs'

const rule = /** @type {any} */ (plugin.rules?.['no-personal-identifiers'])
const err = [{ messageId: 'identifier' }]
const MAIN = 'packages/desktop/src/main/x.ts'
const SYNC = 'packages/sync/src/engine.ts'

ruleTester().run('slate/no-personal-identifiers', rule, {
  valid: [
    // The pseudonymous device name (workstream C) and the other os functions.
    at(MAIN, "declare const deviceId: string\nexport const name = `Device ${deviceId.slice(0, 8)}`"),
    at(MAIN, "import { homedir, platform, tmpdir } from 'node:os'\nexport const p = [homedir(), platform(), tmpdir()]"),
    at(MAIN, "import os from 'node:os'\nexport const p = os.platform()"),
    // A URL's hostname is not the machine's.
    at(MAIN, "export const h = new URL('https://graph.microsoft.com').hostname"),
    // A local object with the same member names.
    at(MAIN, 'declare const info: { hostname(): string }\nexport const h = info.hostname()'),
    // Outside the main process, in tests, and in the allowlisted file.
    at('packages/desktop/src/renderer/src/x.ts', "export const h = 'hostname'"),
    at('packages/desktop/src/main/sync/syncService.test.ts', "import { hostname } from 'node:os'\nexport const h = hostname()"),
    at('packages/desktop/src/main/sync/syncService.ts', "import { hostname } from 'node:os'\nexport const h = hostname()"),
  ],
  invalid: [
    // syncService.ts before GDPR-03: the hostname as the device record and the commit author.
    { ...at(MAIN, "import { hostname, platform } from 'node:os'\nexport const name = hostname() + platform()"), errors: err },
    { ...at(MAIN, "import { hostname as h } from 'os'\nexport const name = h()"), errors: err },
    { ...at(MAIN, "import { userInfo } from 'node:os'\nexport const who = userInfo().username"), errors: err },
    { ...at(MAIN, "import { networkInterfaces } from 'node:os'\nexport const nics = networkInterfaces()"), errors: err },
    { ...at(MAIN, "import os from 'node:os'\nexport const name = os.hostname()"), errors: err },
    { ...at(MAIN, "import * as os from 'os'\nexport const who = os.userInfo()"), errors: err },
    { ...at(MAIN, "import * as os from 'os'\nexport const nics = os['networkInterfaces']()"), errors: err },
    { ...at(MAIN, "import * as os from 'os'\nexport const name = os[`hostname`]()"), errors: err },
    // An alias: of the function, of the module object, and a destructuring.
    { ...at(MAIN, "import os from 'node:os'\nconst h = os.hostname\nexport const name = h()"), errors: err },
    { ...at(MAIN, "import os from 'node:os'\nconst o = os\nexport const name = o.hostname()"), errors: err },
    { ...at(MAIN, "import os from 'node:os'\nconst { hostname } = os\nexport const name = hostname()"), errors: err },
    { ...at(MAIN, "import os from 'node:os'\nconst { ...all } = os\nexport const name = all.hostname()"), errors: err },
    // require and dynamic import.
    { ...at(MAIN, "const os = require('os')\nexport const name = os.hostname()"), errors: err },
    { ...at(MAIN, "const { userInfo } = require('node:os')\nexport const who = userInfo()"), errors: err },
    { ...at(MAIN, "export const name = require('os').hostname()"), errors: err },
    { ...at(MAIN, "export async function name() { return (await import('node:os')).hostname() }"), errors: err },
    { ...at(MAIN, "export async function name() { const { hostname } = await import('node:os'); return hostname() }"), errors: err },
    { ...at(MAIN, "export async function name() { const os = await import('node:os'); return os.hostname() }"), errors: err },
    // A re-export hands it on to a file the rule does not see.
    { ...at(MAIN, "export { hostname } from 'node:os'"), errors: err },
    { ...at(MAIN, "export * from 'node:os'"), errors: err },
    // Every package main loads: sync (the device record), mcp, importer, native.
    { ...at(SYNC, "import { hostname } from 'node:os'\nexport const deviceName = hostname()"), errors: err },
    { ...at('packages/mcp/src/x.ts', "import os from 'os'\nexport const who = os.userInfo().username"), errors: err },
    { ...at('packages/importer/src/x.ts', "import os from 'os'\nexport const who = os.hostname()"), errors: err },
    { ...at('packages/native/index.ts', "import os from 'os'\nexport const who = os.hostname()"), errors: err },
  ],
})

describe('no-personal-identifiers: scope and allowlist', () => {
  const entry = CUSTOM.find((c) => c.name === 'no-personal-identifiers')

  it('is on as an error in eslint.config.mjs (which spreads slateRules)', async () => {
    expect(slateRules['slate/no-personal-identifiers']).toBe('error')
    const config = await import('../../eslint.config.mjs')
    const rules = config.default.flatMap((/** @type {any} */ c) => Object.entries(c.rules ?? {}))
    expect(rules).toContainEqual(['slate/no-personal-identifiers', 'error'])
  })

  it('covers every main-process package, sync included', () => {
    expect(entry?.files).toEqual(expect.arrayContaining([...MAIN_PROCESS]))
    for (const f of ['packages/desktop/src/main/index.ts', 'packages/sync/src/engine.ts', 'packages/mcp/src/tools.ts', 'packages/importer/src/graph.ts', 'packages/native/index.ts']) {
      expect(matchesAny(f, entry?.files), f).toBe(true)
    }
  })

  it('exempts exactly the files of allowlists/personal-identifiers.json, each real', () => {
    const listed = Object.keys(allowlist('personal-identifiers'))
    expect(entry?.allow).toEqual(listed)
    for (const f of listed) expect(existsSync(join(ROOT, f)), f).toBe(true)
  })
})
