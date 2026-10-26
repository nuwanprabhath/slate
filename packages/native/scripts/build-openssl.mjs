#!/usr/bin/env node
// Builds the two OpenSSL pieces @slate/native needs, per target (audit §4.9):
//  1. libcrypto 3.5.x, static, hidden visibility -> .build/openssl/<target>/{include,lib/libcrypto.a}
//  2. the OpenSSL FIPS Provider from the validated 3.1.2 source (CMVP #4985), built exactly as its
//     Security Policy says (`./Configure enable-fips && make && make install_fips`)
//     -> fips/<target>/{fips.dylib|fips.so, fipsmodule.cnf}, and its SHA-256 into fips-digest.json.
// Each tarball must hash to the pin in deps.lock.json; anything else is refused before extraction.
//
// Usage: node scripts/build-openssl.mjs [--target darwin-arm64|darwin-x64|linux-x64] [--only openssl|fips] [--jobs N]
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import {
  BUILD_DIR,
  buildEnv,
  checkPin,
  configureTarget,
  fipsModuleFile,
  fipsOutDir,
  hostTarget,
  opensslPrefix,
  PACKAGE_DIR,
  patchOpensslArgon2,
  sha256File,
} from './lib.mjs'
import { extractTarball, fetchPinned } from './fetch.mjs'

const { values: args } = parseArgs({
  options: {
    target: { type: 'string', default: hostTarget() },
    only: { type: 'string' },
    jobs: { type: 'string', default: String(cpus().length) },
    offline: { type: 'boolean', default: false },
    'update-pin': { type: 'boolean', default: false },
  },
})
const target = args.target
const cfgTarget = configureTarget(target)
const lock = JSON.parse(readFileSync(join(PACKAGE_DIR, 'deps.lock.json'), 'utf8'))

function run(cmd, argv, cwd) {
  console.log(`$ (${basename(cwd)}) ${cmd} ${argv.join(' ')}`)
  execFileSync(cmd, argv, { cwd, stdio: ['ignore', 'inherit', 'inherit'], env: buildEnv(process.env, target) })
}

const fetchVerified = (dep) => fetchPinned(dep, { offline: args.offline })
const extract = (tarball, into) => extractTarball(tarball, into, run)

/** Cross-compiling darwin-x64 on arm64 needs -arch; Configure's darwin64-x86_64-cc sets it. */
const jobs = `-j${args.jobs}`
const UNREACHABLE_PREFIX = '/nonexistent/slate-openssl'

async function buildLibcrypto() {
  const src = join(BUILD_DIR, target, `openssl-${lock.openssl.version}`)
  const prefix = opensslPrefix(target)
  extract(await fetchVerified(lock.openssl), src)
  // Audit C4: Argon2id at real cost must not need the 1 MiB secure heap (lib.mjs, patchOpensslArgon2).
  const argon2 = join(src, 'providers', 'implementations', 'kdfs', 'argon2.c')
  writeFileSync(argon2, patchOpensslArgon2(readFileSync(argon2, 'utf8')))
  // Review N4: the paths compiled into libcrypto (OPENSSLDIR, MODULESDIR, ENGINESDIR) point at a
  // directory that cannot exist, never at the build machine. scc_preinit/scc_init never consult them
  // anyway (NO_LOAD_CONFIG, explicit provider search path). make install_dev uses DESTDIR to land here.
  run(
    'perl',
    [
      './Configure',
      cfgTarget,
      'no-shared',
      'no-tests',
      'no-apps',
      'no-legacy',
      'no-docs',
      'enable-ec_nistp_64_gcc_128',
      '-fPIC',
      '-fvisibility=hidden',
      `--prefix=${UNREACHABLE_PREFIX}`,
      `--openssldir=${UNREACHABLE_PREFIX}/ssl`,
      '--libdir=lib',
    ],
    src,
  )
  run('make', [jobs, 'build_libs'], src)
  const destdir = join(BUILD_DIR, target, 'destdir')
  rmSync(destdir, { recursive: true, force: true })
  rmSync(prefix, { recursive: true, force: true })
  run('make', ['install_dev', `DESTDIR=${destdir}`], src)
  // A fresh checkout has no .build/openssl yet; rename() does not create parents.
  mkdirSync(dirname(prefix), { recursive: true })
  renameSync(join(destdir, UNREACHABLE_PREFIX), prefix)
  rmSync(destdir, { recursive: true, force: true })
  rmSync(src, { recursive: true, force: true })
}

async function buildFipsProvider() {
  const src = join(BUILD_DIR, target, `openssl-fips-${lock.fipsProvider.version}`)
  const prefix = join(BUILD_DIR, target, 'fips-install')
  extract(await fetchVerified(lock.fipsProvider), src)
  // The Security Policy's procedure, with a private prefix so nothing touches the system.
  run('perl', ['./Configure', 'enable-fips', cfgTarget, `--prefix=${prefix}`, `--openssldir=${join(prefix, 'ssl')}`, '--libdir=lib'], src)
  run('make', [jobs], src)
  rmSync(prefix, { recursive: true, force: true })
  run('make', ['install_fips'], src)
  const moduleName = fipsModuleFile(target)
  const moduleFile = join(prefix, 'lib', 'ossl-modules', moduleName)
  const out = fipsOutDir(target)
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  copyFileSync(moduleFile, join(out, moduleName))
  // L-3 (open): the config is generated here, at build time, and shipped. -self_test_onload leaves
  // out the install indicators, so the module runs its self-tests at every load on every machine.
  run('perl', [join(src, 'util', 'wrap.pl'), join(src, 'apps', 'openssl'), 'fipsinstall', '-module', join(out, moduleName), '-out', join(out, 'fipsmodule.cnf'), '-self_test_onload'], src)
  // Review M4: the pin is an input. A mismatch stops the build unless --update-pin was given on purpose.
  const digestFile = join(PACKAGE_DIR, 'fips-digest.json')
  const actual = { provider: sha256File(join(out, moduleName)), config: sha256File(join(out, 'fipsmodule.cnf')) }
  const pins = checkPin(target, actual, existsSync(digestFile) ? JSON.parse(readFileSync(digestFile, 'utf8')) : {}, args['update-pin'])
  writeFileSync(digestFile, JSON.stringify(pins, null, 2) + '\n')
  console.log(`${moduleName} and fipsmodule.cnf match fips-digest.json: ${JSON.stringify(actual)}`)
  rmSync(src, { recursive: true, force: true })
  rmSync(prefix, { recursive: true, force: true })
}

if (args.only !== 'fips') await buildLibcrypto()
if (args.only !== 'openssl') await buildFipsProvider()
