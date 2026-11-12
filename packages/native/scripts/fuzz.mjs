#!/usr/bin/env node
// Builds and runs the fuzz harnesses in fuzz/ against slate_crypto_core.c (KAT build) and the static libcrypto.
//   --smoke                       every harness with fuzz/standalone.c under ASan + UBSan: the corpus, then
//                                 --runs seeded mutations (default 20000, seed --seed, default 0x51a7e)
//   --harness <name> --seconds n  one harness under libFuzzer + ASan + UBSan (Linux clang); exits 2 where the
//                                 fuzzer runtime does not link (Apple's command-line clang)
//   --fips                        through the FIPS provider in fips/<host>, as kat.mjs --fips, so the
//                                 approved-only branches (SCC_ERR_NOT_APPROVED) are reached
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { fipsModuleFile, fipsOutDir, hostTarget, opensslPrefix, PACKAGE_DIR, writePinHeader } from './lib.mjs'

const HARNESSES = ['recovery', 'gcm', 'wrap', 'ops', 'mldsa']
const { values: args } = parseArgs({
  options: {
    smoke: { type: 'boolean', default: false },
    harness: { type: 'string' },
    seconds: { type: 'string', default: '60' },
    runs: { type: 'string', default: '20000' },
    seed: { type: 'string', default: '0x51a7e' },
    fips: { type: 'boolean', default: false },
  },
})
if (!args.smoke && !args.harness) {
  console.error(`fuzz: pass --smoke, or --harness <${HARNESSES.join('|')}> --seconds <n>`)
  process.exit(1)
}
const only = args.harness?.replace(/^fuzz_/, '')
if (only !== undefined && !HARNESSES.includes(only)) {
  console.error(`fuzz: no harness ${args.harness}; there are ${HARNESSES.join(', ')}`)
  process.exit(1)
}

const target = hostTarget()
const prefix = opensslPrefix(target)
if (!existsSync(join(prefix, 'lib', 'libcrypto.a'))) {
  console.error(`fuzz: build libcrypto first (npm run -w @slate/native build:openssl); ${prefix} is missing`)
  process.exit(1)
}
const outDir = join(PACKAGE_DIR, 'build', 'fuzz')
mkdirSync(outDir, { recursive: true })
const libs = process.platform === 'linux' ? ['-ldl', '-pthread'] : []
// kat.mjs's warning set (review H1: no silent narrowing).
const warnings = ['-Wall', '-Wextra', '-Wconversion', ...(process.platform === 'darwin' ? ['-Wshorten-64-to-32'] : []), '-Werror']
const common = ['-std=c11', '-g', '-O1', '-fno-omit-frame-pointer', '-fno-sanitize-recover=undefined', ...warnings, '-DSCC_KAT_BUILD']
const includes = [`-I${join(prefix, 'include')}`, '-Isrc', `-I${writePinHeader(target)}`]

const runArgs = []
let tmp = null
if (args.fips) {
  const modulesDir = fipsOutDir(target)
  if (!existsSync(join(modulesDir, fipsModuleFile(target)))) {
    console.error(`fuzz --fips: ${modulesDir} has no provider; run build:openssl`)
    process.exit(1)
  }
  const { fipsConfigText } = await import('../../desktop/src/main/native/fipsConfig.ts')
  tmp = mkdtempSync(join(tmpdir(), 'slate-fuzz-'))
  const config = join(tmp, 'openssl-fips.cnf')
  writeFileSync(config, fipsConfigText(modulesDir), { mode: 0o600 })
  // One `-flag=value` word each: libFuzzer ignores a flag it does not know, but would read a separate value as a corpus folder.
  runArgs.push(`-slate_fips_config=${config}`, `-slate_fips_modules=${modulesDir}`)
}
// handle_abort: a failed FUZZ_CHECK is reported like any sanitizer error, so the driver's death callback
// writes the input. Leaks are not an oracle here (the secure heap and OpenSSL's caches outlive an input).
const env = { ...process.env, ASAN_OPTIONS: 'detect_leaks=0:handle_abort=1', UBSAN_OPTIONS: 'print_stacktrace=1:halt_on_error=1' }

function build(name, mode) {
  const bin = join(outDir, `fuzz_${name}${mode === 'smoke' ? '-smoke' : ''}`)
  const sanitize = mode === 'smoke' ? '-fsanitize=address,undefined' : '-fsanitize=fuzzer,address,undefined'
  const sources = ['src/slate_crypto_core.c', `fuzz/fuzz_${name}.c`, ...(mode === 'smoke' ? ['fuzz/standalone.c'] : [])]
  const r = spawnSync('cc', [...common, sanitize, ...includes, ...sources, join(prefix, 'lib', 'libcrypto.a'), ...libs, '-o', bin], { cwd: PACKAGE_DIR, encoding: 'utf8' })
  if (r.status !== 0) {
    process.stderr.write(r.stderr ?? '')
    if (mode === 'libfuzzer' && /libclang_rt\.fuzzer|fuzzer.*not found|unsupported option '-fsanitize=fuzzer'/.test(r.stderr ?? '')) {
      console.error('fuzz: this compiler has no libFuzzer runtime (Apple clang does not ship one); use --smoke here, or Linux clang')
      process.exit(2)
    }
    console.error(`fuzz: building fuzz_${name} failed`)
    process.exit(1)
  }
  return bin
}

try {
  if (args.smoke) {
    for (const name of HARNESSES.filter((h) => only === undefined || h === only)) {
      const bin = build(name, 'smoke')
      const crashDir = join(outDir, `crashes-${name}`)
      mkdirSync(crashDir, { recursive: true })
      const r = spawnSync(bin, [join('fuzz', 'corpus', name), '-runs', args.runs, '-seed', args.seed, '-crash_dir', crashDir, ...runArgs], { cwd: PACKAGE_DIR, env, stdio: 'inherit' })
      if (r.status !== 0) {
        console.log(`FAIL fuzz_${name} (exit ${r.status ?? r.signal}; seed ${args.seed})`)
        process.exit(1)
      }
      console.log(`PASS fuzz_${name}`)
    }
  } else {
    const bin = build(only, 'libfuzzer')
    const crashDir = join(outDir, `crashes-${only}`)
    const work = join(outDir, `corpus-${only}`)
    mkdirSync(crashDir, { recursive: true })
    mkdirSync(work, { recursive: true })
    // The evolving corpus goes to build/fuzz/corpus-<name>; the committed one is only read.
    execFileSync(bin, [work, join('fuzz', 'corpus', only), `-max_total_time=${args.seconds}`, '-timeout=10', '-rss_limit_mb=2048', `-artifact_prefix=${crashDir}/`, ...runArgs], { cwd: PACKAGE_DIR, env, stdio: 'inherit' })
    console.log(`PASS fuzz_${only} (${args.seconds} s)`)
  }
} finally {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
}
