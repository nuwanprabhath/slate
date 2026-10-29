import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TEST_HOOK_VARS } from './testHooks'

/**
 * Audit §6.8 (T-STATIC): source checks over src/main. The ids are in the test titles so
 * `grep -r T-STATIC-04` finds them. The ones whose subject does not exist yet are `todo`s naming the
 * work package that adds them.
 */
const MAIN = __dirname

interface InventoryKey {
  id: string
  keyName?: string
  derivation: unknown
  gcmCallSites?: string[]
  uses?: string[]
  status?: string
  owner: string
}
/** `docs/compliance/key-inventory.json` (SC-12): what C10 keeps in step with the code. */
const inventory = (): { keys: InventoryKey[] } => JSON.parse(readFileSync(join(MAIN, '../../../../docs/compliance/key-inventory.json'), 'utf8')) as { keys: InventoryKey[] }

function sources(dir: string = MAIN): string[] {
  const out: string[] = []
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, d.name)
    if (d.isDirectory()) out.push(...sources(path))
    else if (d.name.endsWith('.ts') && !/\.(test|d)\.ts$/.test(d.name) && d.name !== 'testSetup.ts') out.push(path)
  }
  return out
}

const REPO = join(MAIN, '../../../..')
/** Every file that runs in the main process: all of src/main and the packages it loads (red team re-run R4; `MAIN_PROCESS`). */
const mainProcessSources = (): string[] => [...sources(), ...['sync', 'mcp', 'importer'].flatMap((p) => sources(join(REPO, 'packages', p, 'src'))), join(REPO, 'packages/native/index.ts')]

/** INV-PQ-7: the TLS group settings, which only `tlsPolicy.ts` may touch. */
const TLS_GROUP_SETTING = /\b(?:ecdhCurve|DEFAULT_ECDH_CURVE)\b/

/** The audit's identifier pattern for key material (§6.8, T-STATIC-01). */
const KEY_NAME = /(^|_)(mk|lk|kek|key|secret|qu|password)($|[A-Z_])/i

/**
 * Key-named operands of the Z-2 operations, by text (the audit asks for the compiler API; TypeScript 7
 * ships none, so this reads the source, line by line, without comments). A `.get('<name>')` call on
 * a key ring counts as key material too.
 */
function keyTextUses(source: string): string[] {
  const text = source.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '')
  const last = (expr: string) => expr.split('.').pop() ?? ''
  const out: string[] = []
  // A key's public metadata (keyId, keyName, keyPath, keyCount) names the key, not its bytes.
  const keyed = (expr: string) => KEY_NAME.test(last(expr)) && !/(Id|Ids|Name|Names|Path|Count|Kind|Version|Pem)$/.test(last(expr))
  for (const m of text.matchAll(/Buffer\.from\(\s*([\w.]+)\s*[,)]/g)) if (keyed(m[1]!)) out.push(last(m[1]!))
  for (const m of text.matchAll(/Buffer\.concat\(\s*\[([^\]]*)\]/g)) for (const part of m[1]!.split(',').map((p) => p.trim())) if (/^[\w.]+$/.test(part) && keyed(part)) out.push(last(part))
  for (const m of text.matchAll(/([\w.]+)\.toString\(/g)) if (keyed(m[1]!)) out.push(last(m[1]!))
  for (const m of text.matchAll(/\$\{\s*([\w.]+)\s*\}/g)) if (keyed(m[1]!)) out.push(last(m[1]!))
  for (const m of text.matchAll(/\.get\((['"])(mk|lk|kek|\w*key\w*)\1\)\s*\.toString\(|\$\{[^}]*\.get\((['"])(mk|lk|kek|\w*key\w*)\3\)/gi)) out.push(`get('${m[2] ?? m[4]!}')`)
  return [...new Set(out)]
}

/** Each node:crypto import in `source` (static, `* as`, require or dynamic import), by what it takes. */
function cryptoImports(source: string): string[] {
  const text = source.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '')
  const out: string[] = []
  for (const m of text.matchAll(/import\s+(?:type\s+)?([^'";]*?)\s+from\s+['"](?:node:)?crypto['"]/g)) {
    const named = /\{([^}]*)\}/.exec(m[1]!)
    out.push(...(named ? named[1]!.split(',').map((n) => n.trim()).filter((n) => n !== '') : [m[1]!.trim()]))
  }
  for (const _ of text.matchAll(/require\(\s*['"](?:node:)?crypto['"]\s*\)/g)) out.push('require')
  for (const _ of text.matchAll(/import\(\s*['"](?:node:)?crypto['"]\s*\)/g)) out.push('import()')
  for (const _ of text.matchAll(/getBuiltinModule['"\x60]?\]?\s*\(\s*['"](?:node:)?crypto['"]\s*\)/g)) out.push('getBuiltinModule')
  return out
}

/**
 * Key-named parameters, fields and properties declared as bytes (Buffer, Uint8Array, the old KeyBytes),
 * also inside a Map or an array: after C4 a key crosses the vault, sync and database APIs as a KeyHandle.
 */
function byteKeyDeclarations(source: string): string[] {
  const text = source.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '')
  const keyName = /^(mk|lk|kek|keys?|k[A-Z]\w*|\w*Key|secret|qu)$/
  const out: string[] = []
  for (const m of text.matchAll(/\b(\w+)\??\s*:\s*((?:Map<[^>]*>|[\w<>[\], |]*?)(?:Buffer|Uint8Array|ArrayBuffer|KeyBytes)\b[^,;)={\n]*)/g)) {
    const [name, type] = [m[1]!, m[2]!.trim()]
    if (!keyName.test(name)) continue
    if (/^(Map<[^>]*\b(Buffer|Uint8Array|ArrayBuffer|KeyBytes)\b[^>]*>|(Buffer|Uint8Array|ArrayBuffer|KeyBytes)\b)/.test(type)) out.push(`${name}: ${type.replace(/\s*\|\s*null$/, '')}`)
  }
  return out
}

/**
 * C7 criterion 2: names that hold a typed secret in main. In index.ts, every name bound from
 * `passwordBytes(…)`, `secretOf(…)` or `bytesOf(…)` and every parameter of a handler on a `CH.vault*`
 * channel; in any file, a parameter or field typed `SecretBytes`.
 */
function secretNames(source: string): string[] {
  const text = source.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '')
  const names = new Set<string>()
  for (const m of text.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(?:passwordBytes|secretOf|bytesOf)\(/g)) names.add(m[1]!)
  for (const m of text.matchAll(/ipc\.handle\(\s*CH\.vault\w*\s*,\s*(?:busy\.guard\(\s*)?(?:async\s*)?\(([^)]*)\)/g)) {
    // The first parameter is the IPC event; the rest are what the page sent.
    for (const p of m[1]!.split(',').slice(1)) {
      const name = p.split(':')[0]!.trim()
      if (name !== '' && !name.startsWith('_')) names.add(name)
    }
  }
  // vaultIpc.ts: every parameter of a `secretHandler(…)` is what the page sent.
  for (const m of text.matchAll(/secretHandler\(\s*(?:async\s*)?\(([^)]*)\)/g)) {
    for (const p of m[1]!.split(',')) {
      const name = p.split(':')[0]!.trim()
      if (name !== '') names.add(name)
    }
  }
  for (const m of text.matchAll(/\b(\w+)\??\s*:\s*SecretBytes\b/g)) names.add(m[1]!)
  return [...names]
}

/** Each string conversion of a secret name: TextDecoder `.decode`, `.toString`, `String()`, a template, `JSON.stringify`, `+ ''`, `Buffer.from`. */
function secretStringConversions(source: string, names: string[]): string[] {
  const text = source.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '')
  const out: string[] = []
  for (const n of names) {
    const forms: Array<[string, RegExp]> = [
      ['decode', new RegExp(`\\.decode\\(\\s*${n}\\b`)],
      ['toString', new RegExp(`\\b${n}\\s*\\.\\s*toString\\(`)],
      ['String()', new RegExp(`\\bString\\(\\s*${n}\\b`)],
      ['template', new RegExp(`\\$\\{\\s*${n}\\b`)],
      ['JSON.stringify', new RegExp(`JSON\\.stringify\\(\\s*${n}\\b`)],
      ['concatenation', new RegExp(`\\b${n}\\s*\\+\\s*['"\x60]|['"\x60]\\s*\\+\\s*${n}\\b`)],
      ['Buffer.from', new RegExp(`Buffer\\.from\\(\\s*${n}\\b`)],
    ]
    for (const [form, re] of forms) if (re.test(text)) out.push(`${n}: ${form}`)
  }
  return out
}

/**
 * C7 criterion 5: the one place a typed secret becomes a string, at set or change time, for the password
 * policy (password.ts, annotated there as the Z-11 residual).
 */
const SECRET_TO_TEXT_RESIDUAL: Record<string, string[]> = { 'vault/password.ts': ['pw: decode'] }

function keyTextAllowlist(): Record<string, string[]> {
  const raw = JSON.parse(readFileSync(join(MAIN, '../../../../tools/guards/allowlists/key-text.json'), 'utf8')) as Record<string, { names?: string[] } | string>
  return Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith('$')).map(([k, v]) => [k, typeof v === 'string' ? [] : (v.names ?? [])]))
}

describe('T-STATIC source checks (audit §6.8)', () => {
  it('T-STATIC-04: every SLATE_TEST_* variable read in src/main is listed in TEST_HOOK_VARS (testHooks.ts)', () => {
    const hooks = new Set<string>(TEST_HOOK_VARS)
    const unlisted: string[] = []
    for (const file of sources()) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/(?:process\.env\.|process\.env\[['"]|env\(['"]|env\.)(SLATE_TEST_[A-Z0-9_]*)/g)) {
        if (!hooks.has(m[1]!)) unlisted.push(`${relative(MAIN, file)}: ${m[1]!}`)
      }
    }
    expect(unlisted).toEqual([])
  })

  it('T-STATIC-04: nothing but testHooks.ts reads process.env, so every hook read is visible as env()', () => {
    const direct = sources()
      .filter((f) => !f.endsWith('/testHooks.ts'))
      .filter((f) => /\bprocess\s*(?:\.\s*env\b|\[\s*['"`]env['"`]\s*\])/.test(readFileSync(f, 'utf8').replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '')))
    expect(direct.map((f) => relative(MAIN, f))).toEqual([])
  })

  it('T-STATIC-04: the check sees a hook read through env() and through process.env', () => {
    const re = /(?:process\.env\.|process\.env\[['"]|env\(['"]|env\.)(SLATE_TEST_[A-Z0-9_]*)/g
    expect(Array.from("env('SLATE_TEST_NEW') process.env.SLATE_TEST_OLD".matchAll(re), (m) => m[1])).toEqual(['SLATE_TEST_NEW', 'SLATE_TEST_OLD'])
  })

  it('T-STATIC-01: no Buffer.from, Buffer.concat, .toString or template literal on a key anywhere in the main process', () => {
    const allowed = keyTextAllowlist()
    const found: string[] = []
    for (const file of mainProcessSources()) {
      const rel = relative(REPO, file).split('\\').join('/')
      for (const name of keyTextUses(readFileSync(file, 'utf8'))) if (!allowed[rel]?.includes(name)) found.push(`${rel}: ${name}`)
    }
    expect(found.map((f) => `${f}: keep key bytes in one owner and zero them (audit Z-1..Z-3); never copy or stringify them`)).toEqual([])
  })

  it('T-ZERO-08: no forbidden copy or text of a key in vault/, sync/, db/ or services.ts beyond the reviewed residuals (Z-12)', () => {
    const boundary = sources().filter((f) => /^((vault|sync|db)\/|services\.ts$)/.test(relative(MAIN, f).split('\\').join('/')))
    // The scan really covers the boundary: each part of it is in the list.
    for (const part of ['vault/', 'sync/', 'db/', 'services.ts']) expect(boundary.some((f) => relative(MAIN, f).split('\\').join('/').startsWith(part)), part).toBe(true)
    const found = boundary.flatMap((f) => keyTextUses(readFileSync(f, 'utf8')).map((n) => `${relative(MAIN, f).split('\\').join('/')}: ${n}`))
    // Quick unlock's QU string for safeStorage (accepted in the standard profile), and a SQL list named like a key.
    expect(found.filter((f) => f !== 'vault/quickUnlock.ts: qu' && f !== 'vault/migration.ts: ENGINE_KEYS')).toEqual([])
  })

  it('T-STATIC-01: the check sees each forbidden operation (self-test)', () => {
    expect(keyTextUses("const a = Buffer.from(mk)\nconst b = Buffer.concat([lk, x])\nconst c = kek.toString('hex')\nconst d = `${secret.password}`")).toEqual(['mk', 'lk', 'kek', 'password'])
    expect(keyTextUses("log.info('x', `${ring.get('mk').toString('hex')}`)")).toEqual(["get('mk')"])
    expect(keyTextUses('const n = Buffer.from(name)\nconst s = count.toString()')).toEqual([])
    expect(keyTextUses('const s = `signed by ${keyId}`')).toEqual([])
  })
  it('T-STATIC-01 (C7 criterion 2): no main-process code turns a typed secret into a string; checkPassword is the one residual', () => {
    const found: string[] = []
    for (const file of sources()) {
      const rel = relative(MAIN, file).split('\\').join('/')
      const text = readFileSync(file, 'utf8')
      const names = secretNames(text)
      for (const c of secretStringConversions(text, names)) if (!SECRET_TO_TEXT_RESIDUAL[rel]?.includes(c)) found.push(`${rel}: ${c}`)
    }
    expect(found.map((f) => `${f}: a password or recovery key stays bytes from IPC to the module (audit Z-5, C7)`)).toEqual([])
    // The handlers that take a secret all go through passwordBytes in vaultIpc.ts, so the check above sees every one of them.
    const handlers = readFileSync(join(MAIN, 'vaultIpc.ts'), 'utf8')
    expect(secretNames(handlers)).toEqual(expect.arrayContaining(['arg', 'currentArg', 'nextArg', 'password', 'recoveryKey', 'pw', 'key', 'current', 'next']))
  })

  it('T-STATIC-01 (C7): the check sees each way a secret becomes text (self-test)', () => {
    const handler = "ipc.handle(CH.vaultUnlock, (_e, arg: unknown) => {\n  const password = passwordBytes(arg)\n  log.info(new TextDecoder().decode(password))\n})"
    expect(secretNames(handler)).toEqual(['password', 'arg'])
    expect(secretStringConversions(handler, secretNames(handler))).toEqual(['password: decode'])
    const all = 'function f(pw: SecretBytes) { a(pw.toString()); b(String(pw)); c(`${pw}`); d(JSON.stringify(pw)); e(pw + ""); g(Buffer.from(pw)) }'
    expect(secretStringConversions(all, secretNames(all))).toEqual(['pw: toString', 'pw: String()', 'pw: template', 'pw: JSON.stringify', 'pw: concatenation', 'pw: Buffer.from'])
    expect(secretStringConversions('function f(pw: SecretBytes) { return deriveKek(pw, kdf) }', ['pw'])).toEqual([])
  })

  it('T-STATIC-02: no node:crypto import in main/vault, main/sync, main/db; elsewhere only the reviewed imports (C4)', () => {
    const inBoundary = (f: string) => /^(vault|sync|db)\//.test(relative(MAIN, f).split('\\').join('/'))
    const found = sources()
      .filter(inBoundary)
      .flatMap((f) => cryptoImports(readFileSync(f, 'utf8')).map((names) => `${relative(MAIN, f)}: ${names}`))
    expect(found.map((f) => `${f}: cryptography in the vault, sync and the database runs in @slate/native (audit §4.0 invariant 1)`)).toEqual([])
    // Elsewhere the lint rule (slate/crypto-stays-in-the-vault) holds each file to its reviewed names; the
    // allowlist itself can no longer name a file inside the boundary.
    const allowlisted = Object.keys(JSON.parse(readFileSync(join(MAIN, '../../../../tools/guards/allowlists/crypto-imports.json'), 'utf8')) as Record<string, unknown>)
    expect(allowlisted.filter((f) => /^packages\/desktop\/src\/main\/(vault|sync|db)\//.test(f))).toEqual([])
  })

  it('T-STATIC-02: the check sees every form of a node:crypto import (self-test)', () => {
    expect(cryptoImports("import { createHash } from 'node:crypto'")).toEqual(['createHash'])
    expect(cryptoImports("import * as c from 'crypto'\nconst { randomBytes } = require('node:crypto')")).toEqual(['* as c', 'require'])
    expect(cryptoImports("const m = await import('node:crypto')")).toEqual(['import()'])
    // Review C4 L3: the builtin lookup that no import check sees.
    expect(cryptoImports("const c = process.getBuiltinModule('node:crypto')\nconst d = process.getBuiltinModule(\"crypto\")")).toEqual(['getBuiltinModule', 'getBuiltinModule'])
    // Re-review L3-R: computed access and destructuring.
    expect(cryptoImports("const c = process['getBuiltinModule']('node:crypto')")).toEqual(['getBuiltinModule'])
    expect(cryptoImports("const { getBuiltinModule } = process\nconst c = getBuiltinModule('crypto')")).toEqual(['getBuiltinModule'])
    expect(cryptoImports("import { createHash } from 'node:crypto-x'\n// import { x } from 'node:crypto'")).toEqual([])
  })

  /**
   * The secrets that still exist as JavaScript bytes, each wiped by its owner and handed to the module,
   * which wipes its copy (audit §4.3): a new recovery secret while it is made and shown once (header.ts,
   * recovery.ts encodes it; a typed one is decoded in the module since C7), and quick unlock's QU, which
   * the OS keyring seals as a string (Z-12, the standard profile's residual). Typed passwords and
   * recovery keys are `SecretBytes`, checked by the C7 test above.
   * vault/suite1.ts takes a new recovery secret and QU the same way for a header-v1 vault's KEKs (C5).
   */
  const RESIDUAL_SECRETS: Record<string, string[]> = {
    'vault/header.ts': ['secret: Uint8Array'],
    'vault/recovery.ts': ['key: Uint8Array'],
    'vault/quickUnlock.ts': ['qu: Uint8Array'],
    'vault/suite1.ts': ['secret: Uint8Array', 'qu: Uint8Array'],
  }

  it('C4: vault, sync and database APIs take and keep keys as KeyHandle only, never as bytes', () => {
    const found = sources()
      .filter((f) => /^(vault|sync|db)\//.test(relative(MAIN, f).split('\\').join('/')))
      .flatMap((f) => byteKeyDeclarations(readFileSync(f, 'utf8')).filter((d) => !RESIDUAL_SECRETS[relative(MAIN, f).split('\\').join('/')]?.includes(d)).map((d) => `${relative(MAIN, f)}: ${d}`))
    expect(found.map((f) => `${f}: a key crosses an API as a KeyHandle (audit §4.0 invariant 2, C4 criterion 3)`)).toEqual([])
    const ring = readFileSync(join(MAIN, 'vault/keyring.ts'), 'utf8')
    expect(ring).toMatch(/\n {2}get\(name: KeyName\): KeyHandle \{/)
    expect(ring).toMatch(/\n {2}constructor\(mk: KeyHandle, lk: KeyHandle \| undefined, readonly schedule: KeySchedule\) \{/)
    expect(readFileSync(join(MAIN, 'sync/encryptingDrive.ts'), 'utf8')).not.toMatch(/\bwithKey\b/)
  })

  it('C4: the check sees a key typed as bytes in a parameter, a field or a return (self-test)', () => {
    expect(byteKeyDeclarations('export function f(mk: Buffer, kSync: Uint8Array): void {}')).toEqual(['mk: Buffer', 'kSync: Uint8Array'])
    expect(byteKeyDeclarations('class R { private keys: Map<KeyName, Buffer> | null = new Map() }')).toEqual(['keys: Map<KeyName, Buffer>'])
    expect(byteKeyDeclarations("export function g(): { lk: Buffer; db: string } { return x }\nconst k = (key: KeyBytes) => 1")).toEqual(['lk: Buffer', 'key: KeyBytes'])
    // Review C4 L3: an ArrayBuffer is bytes too.
    expect(byteKeyDeclarations('export function f(fileKey: ArrayBuffer): void {}')).toEqual(['fileKey: ArrayBuffer'])
    expect(byteKeyDeclarations('function h(mk: KeyHandle, salt: Uint8Array, keyId: string): Uint8Array {}')).toEqual([])
  })
  it('T-STATIC-03: every kbkdf label and KeyName has an entry in docs/compliance/key-inventory.json, and every owner file exists', () => {
    const inv = inventory()
    const derivations = inv.keys.map((k) => JSON.stringify(k.derivation ?? '')).join('\n')
    const labels = new Set<string>()
    for (const file of sources()) for (const m of readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '').matchAll(/['"`](slate\/v\d+\/[a-z0-9-]+)['"`]/g)) labels.add(m[1]!)
    // C9: a label the module fixes itself (K_hist, derived inside each history call) is derived there, in C.
    const nativeSrc = join(MAIN, '../../../native/src')
    for (const f of readdirSync(nativeSrc).filter((n) => n.endsWith('.c'))) {
      for (const m of readFileSync(join(nativeSrc, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/"(slate\/v\d+\/[a-z0-9-]+)"/g)) labels.add(m[1]!)
    }
    expect([...labels].length).toBeGreaterThan(8)
    expect([...labels].filter((l) => !derivations.includes(l)), 'labels with no inventory entry').toEqual([])
    // The other direction (review C10): an inventory label no code derives with is a key the inventory claims exists.
    const planned = inv.keys.filter((k) => k.status === 'planned').map((k) => JSON.stringify(k.derivation ?? ''))
    const claimed = [...derivations.matchAll(/slate\/v\d+\/[a-z0-9-]+/g)].map((m) => m[0]).filter((l) => !planned.some((d) => d.includes(l)))
    expect([...new Set(claimed)].filter((l) => !labels.has(l)), 'inventory labels with no code (mark the entry status: planned until its work package lands)').toEqual([])
    const ring = readFileSync(join(MAIN, 'vault/keyring.ts'), 'utf8')
    const subkeys = [...(/const V2_LABEL = \{([\s\S]*?)\} as const/.exec(ring)?.[1] ?? '').matchAll(/^\s*(\w+):/gm)].map((m) => m[1]!)
    const keyNames = ['mk', 'lk', ...subkeys]
    expect(subkeys.length).toBeGreaterThan(5)
    expect(keyNames.filter((n) => !inv.keys.some((k) => k.keyName === n)), 'KeyNames with no inventory entry').toEqual([])
    for (const k of inv.keys) {
      for (const owner of k.owner.split(' / ').filter((o) => o.endsWith('.ts'))) expect(existsSync(join(MAIN, owner)), `${k.id}: ${owner}`).toBe(true)
    }
  })
  it('T-STATIC-03: every file that takes a key from the ring, or MACs with one, is recorded on its inventory entry (a new use of an existing key)', () => {
    const inv = inventory()
    const recorded = (k: InventoryKey): Set<string> => new Set([...k.owner.split(' / '), ...(k.uses ?? []), 'vault/keyring.ts'])
    const problems: string[] = []
    for (const file of sources()) {
      const rel = relative(MAIN, file)
      const text = readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '')
      for (const k of inv.keys.filter((e) => e.keyName)) {
        if (new RegExp(`\\.get\\('${k.keyName}'\\)`).test(text) && !recorded(k).has(rel)) problems.push(`${rel} takes ${k.id} (${k.keyName}) from the key ring: add it to that entry's "uses"`)
      }
      if (/\bhmacSha256\(/.test(text) && !inv.keys.some((k) => recorded(k).has(rel))) problems.push(`${rel} calls hmacSha256: record the key it uses in key-inventory.json`)
    }
    expect(problems).toEqual([])
  })
  it('T-GCM-01: the AES-GCM seal call sites are exactly those key-inventory.json records (F-FIPS-09)', () => {
    const recorded = new Set(inventory().keys.flatMap((k) => k.gcmCallSites ?? []))
    const found = new Set<string>()
    for (const file of sources()) if (/\.gcmSeal(?:Key|IvInAad)?\(/.test(readFileSync(file, 'utf8').replace(/\/\/.*$/gm, ''))) found.add(relative(MAIN, file))
    expect([...found].sort()).toEqual([...recorded].sort())
  })

  it('T-PQ-C3-03: no main-process file except tlsPolicy.ts contains ecdhCurve or DEFAULT_ECDH_CURVE (INV-PQ-7)', () => {
    const files = mainProcessSources()
    expect(files).toContain(join(MAIN, 'tlsPolicy.ts'))
    const found = files.filter((f) => f !== join(MAIN, 'tlsPolicy.ts') && TLS_GROUP_SETTING.test(readFileSync(f, 'utf8'))).map((f) => relative(REPO, f).split('\\').join('/'))
    expect(found.map((f) => `${f}: set TLS groups only through applyTlsPolicy() in src/main/tlsPolicy.ts`)).toEqual([])
  })

  it('T-PQ-C3-03: the check sees either setting in any spelling a lint rule would miss (self-test)', () => {
    for (const text of ["tls.connect({ ecdhCurve: 'X25519' })", "tls['DEFAULT_ECDH_CURVE'] = 'P-256'", 'const { DEFAULT_ECDH_CURVE } = tls']) expect(TLS_GROUP_SETTING.test(text), text).toBe(true)
    expect(TLS_GROUP_SETTING.test('const ecdhCurves = 1; myDEFAULT_ECDH_CURVE_X')).toBe(false)
  })
})
