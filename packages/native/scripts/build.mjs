#!/usr/bin/env node
// OpenSSL + FIPS provider, the SQLCipher amalgamation, then the addon, for one target: `npm run -w @slate/native build -- --target darwin-x64`.
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { hostTarget, PACKAGE_DIR } from './lib.mjs'

const { values } = parseArgs({ options: { target: { type: 'string', default: hostTarget() }, jobs: { type: 'string' } } })
const jobs = values.jobs ? ['--jobs', values.jobs] : []
const run = (script, extra = []) => execFileSync(process.execPath, [join(PACKAGE_DIR, 'scripts', script), '--target', values.target, ...extra], { stdio: 'inherit' })
run('build-openssl.mjs', jobs)
run('build-sqlcipher.mjs')
run('build-addon.mjs')
