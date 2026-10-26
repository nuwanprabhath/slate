// @ts-check
import plugin from './plugin.mjs'
import keyBytesStayPut from './key-bytes-stay-put.mjs'
import { at, FIXTURE, ruleTester } from './ruleTester.mjs'

const KB = "declare const keyBytes: unique symbol\ntype KeyBytes = Buffer & { readonly [keyBytes]: true }\ndeclare const ring: { get(n: string): KeyBytes }\n"
const typed = (/** @type {string} */ code) => ({ filename: FIXTURE, code })
const copy = [{ messageId: 'copy' }]

// The rule itself, with types: KeyBytes values and decipher output count whatever they are called.
ruleTester({ typed: true }).run('slate/key-bytes-stay-put (types)', /** @type {any} */ (keyBytesStayPut), {
  valid: [
    // Ciphertext and AAD assembly, text decoding, a non-key copy.
    typed("import { createCipheriv } from 'node:crypto'\ndeclare const k: Buffer, iv: Buffer, p: Buffer, header: Buffer\nconst c = createCipheriv('aes-256-gcm', k, iv)\nexport const ct = Buffer.concat([header, c.update(p), c.final()])"),
    typed("declare const key: string\nexport const b = Buffer.from(key, 'hex')"),
    typed('declare const stdout: Uint8Array\nexport const t = Buffer.from(stdout)'),
    typed(`${KB}const k = ring.get('lk')\nconst dst = Buffer.alloc(k.length)\nk.copy(dst)`),
  ],
  invalid: [
    // vault/crypto.ts gcmOpen before the review fix: the unwrapped MK/LK went through Buffer.concat.
    { ...typed("import { createDecipheriv } from 'node:crypto'\ndeclare const k: Buffer, iv: Buffer, ct: Buffer\nconst d = createDecipheriv('aes-256-gcm', k, iv)\nexport const pt = Buffer.concat([d.update(ct), d.final()])"), errors: copy },
    // A KeyBytes value under an innocent name, and straight from the ring.
    { ...typed(`${KB}const material = ring.get('mk')\nexport const c = Buffer.concat([material, Buffer.alloc(1)])`), errors: copy },
    { ...typed(`${KB}export const c = Buffer.from(ring.get('prefs'))`), errors: copy },
    { ...typed(`${KB}const material = ring.get('lk')\nexport const c = Buffer.copyBytesFrom(material)`), errors: copy },
    { ...typed(`${KB}const material = ring.get('lk')\nexport const c = Uint8Array.from(material)`), errors: copy },
    // Key-named operands, and the computed spelling.
    { ...typed("declare const mk: Buffer, salt: Buffer\nexport const c = Buffer.concat([mk, salt])"), errors: copy },
    { ...typed("declare const lk: Buffer\nexport const c = Buffer['from'](lk)"), errors: copy },
  ],
})

// Its scope: main, outside tests.
ruleTester().run('slate/key-bytes-stay-put (scope)', /** @type {any} */ (plugin.rules?.['key-bytes-stay-put']), {
  valid: [
    at('packages/desktop/src/main/vault/x.test.ts', 'declare const mk: Buffer\nexport const c = Buffer.concat([mk])'),
    at('packages/core/src/x.ts', 'declare const key: Uint8Array\nexport const c = Uint8Array.from(key)'),
  ],
  invalid: [{ ...at('packages/desktop/src/main/sync/x.ts', 'declare const kSync: Buffer, key: Buffer\nexport const c = Buffer.concat([key, kSync])'), errors: copy }],
})
