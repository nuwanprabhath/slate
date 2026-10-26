#!/usr/bin/env node
// Criterion 1: slate_native.node exports exactly napi_register_module_v1 and
// node_api_module_get_api_version_v1. Any other defined export (a libcrypto or scc_* symbol) fails.
//
// Usage: node scripts/check-exports.mjs [path/to/slate_native.node ...]  (default: this host's prebuild)
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { buildKind, checkExports, exportedSymbols, forbiddenStrings, hostTarget, prebuildPath } from './lib.mjs'

const files = process.argv.slice(2)
if (files.length === 0) files.push(prebuildPath(hostTarget()))
let failed = false
for (const file of files) {
  if (!existsSync(file)) {
    console.error(`check:exports: ${file} does not exist (build it with \`npm run -w @slate/native build\`)`)
    failed = true
    continue
  }
  // The file's format decides the nm flavour, so a Linux build can be checked from CI on Linux only.
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux'
  const nm = platform === 'darwin' ? execFileSync('nm', ['-gU', file], { encoding: 'utf8' }) : execFileSync('nm', ['-D', '--defined-only', file], { encoding: 'utf8' })
  const r = checkExports(exportedSymbols(nm, platform))
  const binary = readFileSync(file)
  const kind = buildKind(binary)
  if (kind !== 'release') {
    failed = true
    console.error(`check:exports FAILED ${file}: build kind is ${kind ?? 'unmarked'}, not release`)
  }
  const testOnly = forbiddenStrings(binary)
  if (testOnly.length) {
    failed = true
    console.error(`check:exports FAILED ${file}: test-only code present (${testOnly.join(', ')})`)
  }
  if (r.ok) console.log(`check:exports OK ${file}: exactly napi_register_module_v1, node_api_module_get_api_version_v1`)
  else {
    failed = true
    console.error(`check:exports FAILED ${file}`)
    if (r.extra.length) console.error(`  unexpected exports (${r.extra.length}): ${r.extra.slice(0, 20).join(', ')}${r.extra.length > 20 ? ', …' : ''}`)
    if (r.missing.length) console.error(`  missing: ${r.missing.join(', ')}`)
  }
}
process.exit(failed ? 1 : 0)
