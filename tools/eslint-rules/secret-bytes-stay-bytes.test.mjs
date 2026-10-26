// @ts-check
import secretBytesStayBytes from './secret-bytes-stay-bytes.mjs'
import { FIXTURE, ruleTester } from './ruleTester.mjs'

const SB =
  'declare const secretBytesBrand: unique symbol\n' +
  'type SecretBytes = Uint8Array & { readonly [secretBytesBrand]?: true }\n' +
  'type VaultSecret = { password: SecretBytes } | { recoveryKey: SecretBytes }\n'
const typed = (/** @type {string} */ code) => ({ filename: FIXTURE, code: SB + code })
const text = [{ messageId: 'text' }]

// The rule with types: what the review found the name-based T-STATIC-01 check missed (review C7 L2).
ruleTester({ typed: true }).run('slate/secret-bytes-stay-bytes (types)', /** @type {any} */ (secretBytesStayBytes), {
  valid: [
    // The sanctioned hand-offs: a SecretBytes parameter, a VaultSecret, zeroing, the module (its own copy), IPC.
    typed('declare function derive(p: SecretBytes): void\ndeclare function zeroSecret(...s: Array<SecretBytes | null>): void\nexport const f = (pw: SecretBytes) => { derive(pw); zeroSecret(pw) }'),
    typed('declare function join(s: VaultSecret): void\nexport const f = (pw: SecretBytes) => join({ password: pw })'),
    typed('interface SlateNative { argon2idAsync(p: Uint8Array): number }\ndeclare const native: SlateNative\nexport const f = (pw: SecretBytes) => native.argon2idAsync(new Uint8Array(pw))'),
    typed("declare const ipcRenderer: { invoke(channel: string, ...args: any[]): Promise<unknown> }\nexport const f = (pw: SecretBytes) => ipcRenderer.invoke('x', pw)"),
    // The module gets the bytes, a copy of them, or their length; public bytes become text freely.
    typed('export const n = (pw: SecretBytes) => `${pw.length} bytes`'),
    typed("declare const salt: Uint8Array\nexport const s = new TextDecoder().decode(salt) + Buffer.from(salt).toString('hex')"),
  ],
  invalid: [
    // header.ts proveSecret taking a VaultSecret, decoding its member.
    { ...typed("export const f = (secret: VaultSecret) => 'password' in secret ? new TextDecoder().decode(secret.password) : ''"), errors: text },
    // Through a copy, and by character codes.
    { ...typed('export const f = (pw: SecretBytes) => new TextDecoder().decode(new Uint8Array(pw))'), errors: text },
    { ...typed('export const f = (pw: SecretBytes) => String.fromCharCode(...pw)'), errors: text },
    { ...typed('export const f = (pw: SecretBytes) => String.fromCharCode(...pw.subarray(0, 4))'), errors: text },
    { ...typed("export const f = (pw: SecretBytes) => Buffer.from(pw).toString('utf8')"), errors: [{ messageId: 'text' }, { messageId: 'text' }] },
    { ...typed('export const f = (pw: SecretBytes) => pw.toString()'), errors: text },
    { ...typed('export const f = (pw: SecretBytes) => String(pw)'), errors: text },
    { ...typed('export const f = (pw: SecretBytes) => JSON.stringify(pw)'), errors: text },
    { ...typed('export const f = (pw: SecretBytes) => `${pw}`'), errors: text },
    { ...typed("export const f = (pw: SecretBytes) => 'pw: ' + pw"), errors: text },
    // Re-review C7 L: a helper or a wider type loses the brand, so the hand-off itself is reported.
    { ...typed('const asText = (b: Uint8Array) => new TextDecoder().decode(b)\nexport const f = (pw: SecretBytes) => asText(pw)'), errors: text },
    { ...typed('export const f = (pw: SecretBytes) => { const raw: Uint8Array = pw; return raw.length }'), errors: text },
    { ...typed('let raw: Uint8Array = new Uint8Array(0)\nexport const f = (pw: SecretBytes) => { raw = pw }'), errors: text },
    { ...typed('export const f = (pw: SecretBytes) => String.fromCodePoint(...pw)'), errors: text },
    { ...typed("export const f = (pw: SecretBytes) => Array.from(pw, (x) => String.fromCharCode(x)).join('')"), errors: text },
    { ...typed("export const f = (pw: SecretBytes) => pw.join(',')"), errors: text },
    { ...typed('export const f = (pw: SecretBytes) => String.fromCharCode.apply(null, Array.from(pw))'), errors: text },
    { ...typed('export const f = (pw: SecretBytes) => [...pw].length'), errors: text },
    // A copy handed to a helper that is not the module is the same hole as the secret itself.
    { ...typed('declare function derive(p: Uint8Array): number\nexport const f = (pw: SecretBytes) => derive(new Uint8Array(pw))'), errors: text },
    // A passwordBytes result, under an innocent name.
    { ...typed('declare function passwordBytes(a: unknown): SecretBytes | null\nexport const f = (a: unknown) => { const x = passwordBytes(a); return x ? new TextDecoder().decode(x) : null }'), errors: text },
  ],
})
