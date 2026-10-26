// T-B-07: reads the fuse wire of a built app and fails unless every fuse matches the
// electron-builder configuration it was built with.
// Usage: node scripts/check-fuses.mjs <Slate.app | slate executable> <electron-builder config .cjs>
// The release workflow runs it on each release build with electron-builder.cjs; e2e-packaged runs
// it with electron-builder.e2e.cjs.
import fuses from '@electron/fuses'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const { FuseV1Options, getCurrentFuseWire } = fuses
// @electron/fuses' FuseState (not exported from its entry point): the ASCII '1' and '0' in the wire.
const ENABLE = 49
const DISABLE = 48
const [app, configPath] = process.argv.slice(2)
if (!app || !configPath) {
  console.error('usage: check-fuses.mjs <app> <electron-builder config>')
  process.exit(2)
}

const config = createRequire(import.meta.url)(resolve(configPath))
const wanted = config.electronFuses ?? {}
const wire = await getCurrentFuseWire(resolve(app))
const problems = []
for (const [name, index] of Object.entries(FuseV1Options)) {
  if (typeof index !== 'number') continue
  const key = name[0].toLowerCase() + name.slice(1)
  if (!(key in wanted)) continue
  const state = wire[index]
  const actual = state === ENABLE ? true : state === DISABLE ? false : `state ${state}`
  console.log(`${name}: ${actual === true ? 'Enabled' : actual === false ? 'Disabled' : actual}`)
  if (actual !== wanted[key]) problems.push(`${name} is ${actual}, the config says ${wanted[key]}`)
}
if (problems.length) {
  console.error(`fuses of ${app} do not match ${configPath}:\n  ${problems.join('\n  ')}`)
  process.exit(1)
}
