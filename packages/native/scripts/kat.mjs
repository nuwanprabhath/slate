#!/usr/bin/env node
// Builds and runs test/kat.c (listing B.1a, T-ZERO-03) against the static libcrypto for this host.
//   (default)  development mode: default provider, no FIPS claim
//   --asan     the same under AddressSanitizer + UndefinedBehaviorSanitizer
//   --fips     through the FIPS provider in fips/<host>, with the config fipsConfig.ts writes
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { fipsModuleFile, fipsOutDir, hostTarget, opensslPrefix, PACKAGE_DIR, writePinHeader } from './lib.mjs'

const { values: args } = parseArgs({ options: { asan: { type: 'boolean', default: false }, fips: { type: 'boolean', default: false } } })
const target = hostTarget()
const prefix = opensslPrefix(target)
if (!existsSync(join(prefix, 'lib', 'libcrypto.a'))) {
  console.error(`kat: build libcrypto first (npm run -w @slate/native build:openssl); ${prefix} is missing`)
  process.exit(1)
}
const outDir = join(PACKAGE_DIR, 'build')
mkdirSync(outDir, { recursive: true })
const bin = join(outDir, args.asan ? 'kat-asan' : 'kat')
const flags = args.asan ? ['-g', '-O1', '-fsanitize=address,undefined', '-fno-sanitize-recover=undefined', '-fno-omit-frame-pointer'] : ['-O2']
const libs = process.platform === 'linux' ? ['-ldl', '-pthread'] : []
// Review H1: no silent narrowing of lengths anywhere (clang adds the explicit 64->32 check).
const strict = ['-Wconversion', ...(process.platform === 'darwin' ? ['-Wshorten-64-to-32'] : [])]
execFileSync(
  'cc',
  ['-std=c11', ...flags, '-Wall', '-Wextra', ...strict, '-Werror', '-DSCC_KAT_BUILD', `-I${join(prefix, 'include')}`, '-Isrc', `-I${writePinHeader(target)}`, 'src/slate_crypto_core.c', 'test/kat.c', join(prefix, 'lib', 'libcrypto.a'), ...libs, '-o', bin],
  { cwd: PACKAGE_DIR, stdio: 'inherit' },
)

const runArgs = []
let tmp = null
if (args.fips) {
  const modulesDir = fipsOutDir(target)
  if (!existsSync(join(modulesDir, fipsModuleFile(target)))) {
    console.error(`kat --fips: ${modulesDir} has no provider; run build:openssl`)
    process.exit(1)
  }
  // The exact text the app writes (packages/desktop/src/main/native/fipsConfig.ts).
  const { fipsConfigText } = await import('../../desktop/src/main/native/fipsConfig.ts')
  tmp = mkdtempSync(join(tmpdir(), 'slate-kat-'))
  const config = join(tmp, 'openssl-fips.cnf')
  writeFileSync(config, fipsConfigText(modulesDir), { mode: 0o600 })
  runArgs.push(config, modulesDir)
}
try {
  execFileSync(bin, runArgs, { stdio: 'inherit', env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=0', UBSAN_OPTIONS: 'print_stacktrace=1' } })
} finally {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
}
