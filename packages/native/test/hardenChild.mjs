// Child process for harden.test.ts (C7, Z-9): hardenProcess changes the whole process (core limit,
// dumpable flag), so it runs here and not in the test's own process. Prints what it found, as JSON.
import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const native = createRequire(import.meta.url)(join(import.meta.dirname, '..', 'prebuilds', `${process.platform}-${process.arch}`, 'slate_native.node'))
const coreLimit = () => spawnSync('/bin/sh', ['-c', 'ulimit -c'], { encoding: 'utf8' }).stdout.trim()
// A non-dumpable process's /proc/<pid> entries belong to root (proc(5), PR_SET_DUMPABLE).
const procOwner = () => (process.platform === 'linux' ? statSync(`/proc/${process.pid}/mem`).uid : null)
const before = { coreLimit: coreLimit(), procOwner: procOwner() }
const hardened = native.hardenProcess()
console.log(JSON.stringify({ hardened, before, after: { coreLimit: coreLimit(), procOwner: procOwner() } }))
