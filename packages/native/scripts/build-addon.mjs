#!/usr/bin/env node
// Builds slate_native.node for a target with node-gyp, against the static libcrypto from
// build-openssl.mjs, copies it to prebuilds/<target>/ and runs the symbol-export check on it.
// N-API only, so one build serves Node and every Electron version alike.
//
// Usage: node scripts/build-addon.mjs [--target <platform-arch>] [--if-deps]
//   --if-deps: exit quietly when libcrypto has not been built (npm install on a fresh checkout).
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { buildEnv, configureTarget, hostTarget, opensslPrefix, PACKAGE_DIR, prebuildPath, sqlcipherDir, writePinHeader } from './lib.mjs'

const { values: args } = parseArgs({ options: { target: { type: 'string', default: hostTarget() }, 'if-deps': { type: 'boolean', default: false } } })
const target = args.target
configureTarget(target)
const libcrypto = join(opensslPrefix(target), 'lib', 'libcrypto.a')
const amalgamation = join(sqlcipherDir(), 'sqlite3.c')
const missing = [libcrypto, amalgamation].find((f) => !existsSync(f))
if (missing) {
  const msg = `@slate/native: ${missing} is missing; run \`npm run -w @slate/native build\` first`
  if (args['if-deps']) {
    console.log(`${msg} (skipping the addon; the app cannot open notes without it)`)
    process.exit(0)
  }
  console.error(msg)
  process.exit(1)
}

// The committed provider pin, compiled in (review M4); binding.gyp adds .build/pin/<target> to the includes.
writePinHeader(target)
const nodeGyp = createRequire(import.meta.url).resolve('node-gyp/bin/node-gyp.js')
const arch = target.split('-')[1]
// Re-review note: node-gyp honours CFLAGS/CPPFLAGS (e.g. -DSCC_KAT_BUILD); it sees only the allow-listed environment.
execFileSync(process.execPath, [nodeGyp, 'rebuild', `--arch=${arch}`], { cwd: PACKAGE_DIR, stdio: 'inherit', env: buildEnv(process.env, target) })
const out = prebuildPath(target)
mkdirSync(dirname(out), { recursive: true })
copyFileSync(join(PACKAGE_DIR, 'build', 'Release', 'slate_native.node'), out)
console.log(`-> ${out}`)
execFileSync(process.execPath, [join(PACKAGE_DIR, 'scripts', 'check-exports.mjs'), out], { stdio: 'inherit' })
