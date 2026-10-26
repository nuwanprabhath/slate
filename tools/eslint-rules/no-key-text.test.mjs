// @ts-check
import { FIXTURE, ruleTester } from './ruleTester.mjs'
import noKeyText from './no-key-text.mjs'

const K = "type KeyBytes = Omit<Uint8Array, 'toString'> & { readonly toString: never; readonly __k: true }\ndeclare const mk: KeyBytes\n"
const typed = (/** @type {string} */ code) => ({ filename: FIXTURE, code })

ruleTester({ typed: true }).run('slate/no-key-text', /** @type {any} */ (noKeyText), {
  valid: [
    typed(`${K}export const n = mk.length\nexport const s = \`\${mk.length} bytes\``),
    typed('declare const name: string\nexport const s = `${name}` + String(name)'),
  ],
  invalid: [
    // Red team re-run 5a: the key through a template, String(), JSON and concatenation.
    { ...typed(`${K}export const s = \`master key \${mk}\``), errors: [{ messageId: 'text' }] },
    { ...typed(`${K}export const s = String(mk)`), errors: [{ messageId: 'text' }] },
    { ...typed(`${K}export const s = JSON.stringify({ mk })`), errors: [{ messageId: 'text' }] },
    { ...typed(`${K}export const s = 'k=' + mk`), errors: [{ messageId: 'text' }] },
  ],
})
