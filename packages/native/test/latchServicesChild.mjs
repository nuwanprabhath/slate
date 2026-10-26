// Child process for suite2.test.ts (C5 criterion 2): once a fips-140-3 vault sets requireApprovedKeys, the
// non-approved services refuse. The latch is one-way for the process, so it runs here. Prints JSON.
import { createRequire } from 'node:module'
import { join } from 'node:path'

const native = createRequire(import.meta.url)(join(import.meta.dirname, '..', 'prebuilds', `${process.platform}-${process.arch}`, 'slate_native.node'))
native.init('', '', false)
const code = (fn) => {
  try {
    fn()
    return 'ran'
  } catch (e) {
    return e.code ?? String(e)
  }
}

const master = native.keyRandom('master')
const data = native.keyRandom()
const enc = native.keyRandom()
native.requireApprovedKeys()
const out = {
  hkdfLegacy: code(() => native.hkdfLegacy(master, new Uint8Array(0), 'slate/v1/sync')),
  hkdfFromSecret: code(() => native.hkdfFromSecret(new Uint8Array(32).fill(1), new Uint8Array(0), 'slate/v1/quick')),
  argon2id: code(() => native.argon2id(new Uint8Array(8), new Uint8Array(16), 32, 1)),
  argon2idAsync: await native.argon2idAsync(new Uint8Array(8), new Uint8Array(16), 32, 1).then(
    () => 'ran',
    (e) => e.code,
  ),
  aesEcbBlock: code(() => native.aesEcbBlock(data, new Uint8Array(16), true)),
  kbkdf: code(() => native.kbkdf(master, 'slate/v2/sync', new Uint8Array(16))),
  pbkdf2: code(() => native.pbkdf2(new Uint8Array(8), new Uint8Array(16), 1000)),
  nameSiv: code(() => native.nameSivEncode(enc, data, new Uint8Array(16))),
}
process.stdout.write(JSON.stringify(out))
