// Child process for sqlite.test.ts (C4): requireApprovedKeys is one-way for the whole process, so it is
// exercised here and not in the test's own process. Prints what each step returned, as JSON.
// Usage: node latchChild.mjs <dir>
import { createRequire } from 'node:module'
import { join } from 'node:path'
import createDatabase from '../sqlite/database.js'

const [dir] = process.argv.slice(2)
const native = createRequire(import.meta.url)(join(import.meta.dirname, '..', 'prebuilds', `${process.platform}-${process.arch}`, 'slate_native.node'))
native.init('', '', false)
const Database = createDatabase(() => native.sqlite, false)
const code = (fn) => {
  try {
    return fn()
  } catch (e) {
    return e.code ?? String(e)
  }
}

// A standard-profile LK: unwrapped under an HKDF (non-approved) local-wrap KEK, so it carries bit 31.
const aad = new Uint8Array(0)
const wrap = native.hkdfLegacy(native.keyRandom('master'), new Uint8Array(0), 'slate/v1/local-wrap', 'kek')
const sealed = native.gcmSealKey(wrap, native.keyRandom('db'), null, aad)
const lk = native.gcmOpenKey(wrap, sealed.subarray(0, 12), aad, sealed.subarray(12), 'db')
const out = { approvedBit: (lk & 0x80000000) !== 0, before: native.status().approvedKeysOnly }
const a = new Database(join(dir, 'before.db'))
out.keyBefore = code(() => a.keyWithHandle(lk))
a.close()
out.latch = native.requireApprovedKeys()
out.after = native.status().approvedKeysOnly
const b = new Database(join(dir, 'after.db'))
out.keyAfter = code(() => b.keyWithHandle(lk))
out.rekeyAfter = code(() => b.rekeyWithHandle(lk))
b.close()
process.stdout.write(JSON.stringify(out))
