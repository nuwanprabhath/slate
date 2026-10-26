// Child process for sqlite.test.ts (review R-M1): closes connections from the module's error state at
// the moments the binding is mid-statement or mid-iteration. A crash shows as a non-zero exit or signal.
// Usage: node poisonChild.mjs <iter|log|logexec> <dir>
import { createRequire } from 'node:module'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import createDatabase from '../sqlite/database.js'

const [mode, dir] = process.argv.slice(2)
const native = createRequire(import.meta.url)(join(import.meta.dirname, '..', 'prebuilds', `${process.platform}-${process.arch}`, 'slate_native.node'))
native.init('', '', false)
const Database = createDatabase(() => native.sqlite, false)
const out = []
const attempt = (label, fn) => {
  try {
    out.push([label, 'ok', fn()])
  } catch (e) {
    out.push([label, 'threw', String(e.message)])
  }
}

if (mode === 'iter') {
  const db = new Database(join(dir, 'a.db'))
  db.keyWithHandle(native.keyRandom('db'))
  db.exec('CREATE TABLE t(v); INSERT INTO t VALUES (1),(2),(3)')
  const it = db.prepare('SELECT v FROM t').iterate()
  attempt('first', () => it.next().value)
  native.zeroizeAll()
  attempt('next', () => it.next())
  attempt('again', () => it.next())
  attempt('open', () => db.open)
}
if (mode === 'paused') {
  // Review C3 FC-L1 (C6): an iterator paused across the error state must not keep its connection open,
  // and with it SQLCipher's key: the connection closes at once, and the iterator then only ends.
  const db = new Database(join(dir, 'd.db'))
  db.keyWithHandle(native.keyRandom('db'))
  db.exec('CREATE TABLE t(v); INSERT INTO t VALUES (1),(2),(3)')
  const it = db.prepare('SELECT v FROM t').iterate()
  attempt('first', () => it.next().value)
  native.enterErrorState()
  attempt('open', () => db.open)
  attempt('next', () => it.next())
  attempt('return', () => it.return().done)
  attempt('openAfter', () => db.open)
}
if (mode === 'log') {
  let fired = false
  const db = new Database(join(dir, 'b.db'), { verbose: () => { if (!fired) { fired = true; native.zeroizeAll() } } })
  db.keyWithHandle(native.keyRandom('db'))
  attempt('run', () => db.prepare('CREATE TABLE t(v)').run().changes)
  attempt('open', () => db.open)
}
if (mode === 'logexec') {
  let fired = false
  const db = new Database(join(dir, 'c.db'), { verbose: () => { if (!fired) { fired = true; native.enterErrorState() } } })
  db.keyWithHandle(native.keyRandom('db'))
  attempt('exec', () => db.exec("CREATE TABLE t(v); INSERT INTO t VALUES ('after')"))
  attempt('open', () => db.open)
}
attempt('files', () => readdirSync(dir).map((f) => [f, statSync(join(dir, f)).size]))
process.stdout.write(JSON.stringify(out))
