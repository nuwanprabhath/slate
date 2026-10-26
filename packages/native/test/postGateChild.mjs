// Child process for postGate.test.ts (C6, audit S-1/S-2/S-6): the self-test gate and the error state are
// one-way for the process, so each scenario runs in its own process. Prints JSON.
// Usage: node postGateChild.mjs <gated|failed|ungated>
import { createRequire } from 'node:module'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createDatabase from '../sqlite/database.js'

const native = createRequire(import.meta.url)(join(import.meta.dirname, '..', 'prebuilds', `${process.platform}-${process.arch}`, 'slate_native.node'))
const mode = process.argv[2]
const code = (fn) => {
  try {
    fn()
    return 'ran'
  } catch (e) {
    return e.code ?? String(e)
  }
}
const out = {}
if (mode !== 'ungated') native.postGate()
native.init('', '', false)
out.beforePost = code(() => native.randomBytes(4))
out.keyBeforePost = code(() => native.keyRandom('db'))
out.passedBefore = native.status().postPassed
out.begin = code(() => native.postBegin())
out.inPost = code(() => native.randomBytes(4))
if (mode === 'failed') {
  // A connection keyed during the session: the failed self-test must close it and zeroise its key.
  const Database = createDatabase(() => native.sqlite, false)
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'slate-postgate-')), 'a.db'))
  db.keyWithHandle(native.keyRandom('db'))
  db.exec('CREATE TABLE t(v)')
  out.end = code(() => native.postEnd(false))
  out.dbOpen = db.open
  out.liveHandles = native.status().liveHandles
} else {
  out.end = code(() => native.postEnd(true))
}
out.afterPost = code(() => native.randomBytes(4))
out.passedAfter = native.status().postPassed
out.errorState = native.status().errorState
out.beginAgain = code(() => {
  native.postBegin()
  native.postEnd(true)
})
process.stdout.write(JSON.stringify(out))
