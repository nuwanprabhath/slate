#!/usr/bin/env node
// Builds the SQLCipher amalgamation that binding.gyp compiles into slate_native.node (audit §4.9, C3):
// the pinned community release tarball -> ./configure && make sqlite3.c (SQLite's autosetup builds its
// own jimsh, so no system Tcl is needed) -> patchSqlcipher() -> .build/sqlcipher/{sqlite3.c,sqlite3.h}.
// The amalgamation is the same for every target. The patched sqlite3.c must hash to
// deps.lock.json's amalgamationSha256, so neither the tarball nor the patch can change unreviewed.
//
// Usage: node scripts/build-sqlcipher.mjs [--offline] [--update-pin]
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parseArgs } from 'node:util'
import { createHash } from 'node:crypto'
import { BUILD_DIR, buildEnv, hostTarget, PACKAGE_DIR, patchSqlcipher, sqlcipherDir } from './lib.mjs'
import { extractTarball, fetchPinned } from './fetch.mjs'

const { values: args } = parseArgs({
  options: {
    offline: { type: 'boolean', default: false },
    'update-pin': { type: 'boolean', default: false },
    // Accepted so build.mjs can pass the same flags to every step; the amalgamation is target-independent.
    target: { type: 'string', default: hostTarget() },
  },
})
const lockFile = join(PACKAGE_DIR, 'deps.lock.json')
const lock = JSON.parse(readFileSync(lockFile, 'utf8'))
const dep = { ...lock.sqlcipher, file: `sqlcipher-${lock.sqlcipher.version}.tar.gz` }

function run(cmd, argv, cwd) {
  console.log(`$ (${basename(cwd)}) ${cmd} ${argv.join(' ')}`)
  execFileSync(cmd, argv, { cwd, stdio: ['ignore', 'inherit', 'inherit'], env: buildEnv(process.env, hostTarget()) })
}

const src = join(BUILD_DIR, `sqlcipher-${dep.version}`)
extractTarball(await fetchPinned(dep, { offline: args.offline }), src, run)
run('./configure', ['--disable-tcl', '--with-tempstore=yes'], src)
run('make', ['sqlite3.c'], src)

const patched = patchSqlcipher(readFileSync(join(src, 'sqlite3.c'), 'utf8'))
const actual = createHash('sha256').update(patched).digest('hex')
if (actual !== dep.amalgamationSha256) {
  if (!args['update-pin']) {
    throw new Error(`patched sqlite3.c hashes to ${actual}, deps.lock.json pins ${dep.amalgamationSha256 || '(nothing)'}; refusing (review, then --update-pin)`)
  }
  lock.sqlcipher.amalgamationSha256 = actual
  writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n')
  console.log(`deps.lock.json: sqlcipher.amalgamationSha256 = ${actual}`)
}
const out = sqlcipherDir()
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'sqlite3.c'), patched)
copyFileSync(join(src, 'sqlite3.h'), join(out, 'sqlite3.h'))
if (!existsSync(join(out, 'sqlite3.h'))) throw new Error('sqlite3.h was not produced')
rmSync(src, { recursive: true, force: true })
console.log(`-> ${out} (SQLCipher ${dep.version}, sqlite3.c sha256=${actual})`)
