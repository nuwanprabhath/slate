// Shared helpers for the @slate/native build scripts. Pure functions only, so the unit tests in
// test/buildLib.test.ts exercise exactly what the build and the CI export check run.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
export const BUILD_DIR = join(PACKAGE_DIR, '.build')

/** The prebuild targets of audit §4.9; Windows is out of scope. */
const CONFIGURE_TARGETS = {
  'darwin-arm64': 'darwin64-arm64-cc',
  'darwin-x64': 'darwin64-x86_64-cc',
  'linux-x64': 'linux-x86_64',
  // Not a release target: the Ubuntu container of packages/desktop/e2e-ubuntu on an Apple silicon Mac.
  'linux-arm64': 'linux-aarch64',
}

export const TARGETS = Object.keys(CONFIGURE_TARGETS)

export function configureTarget(target) {
  const t = CONFIGURE_TARGETS[target]
  if (!t) throw new Error(`Unsupported target ${target}; supported: ${TARGETS.join(', ')}`)
  return t
}

export function hostTarget(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`
}

/** Electron 45 runs on macOS 12 and later; without this clang targets the build machine's macOS. */
export const MACOS_MIN = '12.0'

/**
 * Review L5: Configure and make see only these variables. CC, CFLAGS, CPPFLAGS, LDFLAGS, MAKEFLAGS,
 * PERL5LIB, OPENSSL_* and the rest of the caller's environment never reach the validated 3.1.2 build
 * (its Security Policy requires the unmodified procedure) or the libcrypto build.
 */
export function buildEnv(env, target) {
  const out = {}
  for (const k of ['PATH', 'HOME', 'TMPDIR']) if (env[k] !== undefined) out[k] = env[k]
  if (target.startsWith('darwin-')) out.MACOSX_DEPLOYMENT_TARGET = MACOS_MIN
  return out
}

export function fipsModuleFile(target) {
  return target.startsWith('darwin-') ? 'fips.dylib' : 'fips.so'
}

export class DigestMismatch extends Error {
  constructor(file, expected, actual) {
    super(`SHA-256 of ${file} is ${actual}, but deps.lock.json pins ${expected || '(nothing)'}; refusing to use it`)
    this.name = 'DigestMismatch'
  }
}

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** Throws unless `file` hashes to the pinned digest. A missing or malformed pin is a mismatch, never a skip. */
export function verifyTarball(file, expected) {
  const actual = sha256File(file)
  if (!/^[0-9a-f]{64}$/.test(expected ?? '') || actual !== expected) throw new DigestMismatch(file, expected, actual)
  return actual
}

/** OpenSSL publishes either "<hex> *<file>" or " <hex>". */
export function parsePublishedSha256(text) {
  const m = /^\s*([0-9a-f]{64})\b/i.exec(text)
  if (!m) throw new Error(`Not a SHA-256 file: ${JSON.stringify(text.slice(0, 80))}`)
  return m[1].toLowerCase()
}

/** Criterion 1: the addon exports these two symbols and nothing else. */
export const REQUIRED_EXPORTS = new Set(['napi_register_module_v1', 'node_api_module_get_api_version_v1'])

/**
 * Defined, exported symbols from `nm -gU` (macOS) or `nm -D --defined-only` (Linux) output. Mach-O
 * prefixes C symbols with `_`; undefined (`U`) and weak-undefined (`w`) references are not exports.
 */
export function exportedSymbols(nmOutput, platform) {
  const out = []
  for (const line of nmOutput.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 3) continue
    const [, type, name] = parts
    if (type === 'U' || type === 'w' || type === 'v') continue
    out.push(platform === 'darwin' && name.startsWith('_') ? name.slice(1) : name)
  }
  return out
}

/**
 * Names that exist only in test builds (SCC_KAT_BUILD): raw key import and the KAT slot peek. A release
 * addon containing any of them could turn a handle into key bytes (review M3).
 */
export const FORBIDDEN_STRINGS = ['keyImport', 'scc_key_import', 'scc__slot_bytes_for_kat', 'scc__set_generation_for_kat', 'scc__force_provider_error_for_kat']

export function forbiddenStrings(binary) {
  const buf = Buffer.from(binary.buffer, binary.byteOffset, binary.byteLength)
  return FORBIDDEN_STRINGS.filter((s) => buf.includes(Buffer.from(s)))
}

/**
 * The build kind the core compiles in as a string literal (`slate-native-build:release` or `:kat`).
 * Unlike symbol names it survives `strip`, so check:exports can require a release build positively.
 */
export function buildKind(binary) {
  const buf = Buffer.from(binary.buffer, binary.byteOffset, binary.byteLength)
  if (buf.includes(Buffer.from('slate-native-build:kat'))) return 'kat'
  if (buf.includes(Buffer.from('slate-native-build:release'))) return 'release'
  return null
}

export function checkExports(symbols) {
  const set = new Set(symbols)
  const extra = [...set].filter((s) => !REQUIRED_EXPORTS.has(s)).sort()
  const missing = [...REQUIRED_EXPORTS].filter((s) => !set.has(s)).sort()
  return { ok: extra.length === 0 && missing.length === 0, extra, missing }
}

/**
 * Review M4: fips-digest.json is a reviewed input. A provider build must match the committed pin for its
 * target; only an explicit --update-pin may change it (and the release checks the file is unchanged).
 */
export function checkPin(target, actual, pins, update) {
  const pinned = pins[target]
  if (pinned && pinned.provider === actual.provider && pinned.config === actual.config) return pins
  if (!update) {
    throw new Error(
      pinned
        ? `${target}: the built provider ${JSON.stringify(actual)} differs from the committed pin ${JSON.stringify(pinned)}; refusing`
        : `${target}: no committed pin for this target (built provider ${JSON.stringify(actual)}); commit it after review, or build with --update-pin`,
    )
  }
  const next = { ...pins, [target]: actual }
  return Object.fromEntries(Object.keys(next).sort().map((k) => [k, next[k]]))
}

/**
 * The C header that compiles the pins into slate_native.node: scc_init hashes the provider binary and
 * fipsmodule.cnf against them before OpenSSL reads either (review M4, R3).
 */
export function pinHeader(pin) {
  for (const d of pin ? [pin.provider, pin.config] : []) {
    if (!/^[0-9a-f]{64}$/.test(d ?? '')) throw new Error(`Not a SHA-256 pin: ${d}`)
  }
  return [
    '/* Generated from packages/native/fips-digest.json by scripts/lib.mjs; do not edit. */',
    `#define SLATE_FIPS_SHA256 "${pin?.provider ?? ''}"`,
    `#define SLATE_FIPS_CNF_SHA256 "${pin?.config ?? ''}"`,
    '',
  ].join('\n')
}

export function readPins() {
  return JSON.parse(readFileSync(join(PACKAGE_DIR, 'fips-digest.json'), 'utf8'))
}

/** Writes .build/pin/<target>/slate_fips_pin.h and returns its directory (an include path). */
export function writePinHeader(target) {
  const dir = join(BUILD_DIR, 'pin', target)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'slate_fips_pin.h'), pinHeader(readPins()[target]))
  return dir
}

/** Where scripts/build-openssl.mjs installs libcrypto (headers + libcrypto.a) for a target. */
export function opensslPrefix(target) {
  return join(BUILD_DIR, 'openssl', target)
}

/** Where the shipped provider and its config land: packages/native/fips/<target> (electron-builder extraResources). */
export function fipsOutDir(target) {
  return join(PACKAGE_DIR, 'fips', target)
}

export function prebuildPath(target) {
  return join(PACKAGE_DIR, 'prebuilds', target, 'slate_native.node')
}

/** Where scripts/build-sqlcipher.mjs writes the patched SQLCipher amalgamation (sqlite3.c, sqlite3.h). */
export function sqlcipherDir() {
  return join(BUILD_DIR, 'sqlcipher')
}

const FIPS_STATUS_STUB = 'static int sqlcipher_openssl_fips_status(void *ctx) {\n  return 0;\n}\n'
const FIPS_STATUS_REAL = [
  'static int sqlcipher_openssl_fips_status(void *ctx) {',
  '  /* Slate (audit C3, T-DB-02): community SQLCipher always answers 0 here. SQLCipher fetches every',
  '   * algorithm from the default library context, which @slate/native points at the FIPS provider with',
  '   * fips=yes as its default property query; report exactly that. */',
  '  (void)ctx;',
  '  return EVP_default_properties_is_fips_enabled(NULL) && OSSL_PROVIDER_available(NULL, "fips");',
  '}',
  '',
].join('\n')
const LAST_OPENSSL_INCLUDE = '#include <openssl/err.h> /* amalgamator: dontcache */\n'

function replaceOnce(source, from, to, what) {
  const n = source.split(from).length - 1
  if (n !== 1) throw new Error(`SQLCipher patch (${what}): expected exactly one match, found ${n}; review the patch for this SQLCipher version`)
  return source.replace(from, () => to)
}

/**
 * The one change Slate makes to SQLCipher: PRAGMA cipher_fips_status reports the real state of the
 * default library context instead of a constant 0. Each anchor must match exactly once, so a new
 * SQLCipher release that moves the code fails the build instead of silently shipping unpatched.
 */
export function patchSqlcipher(source) {
  const withInclude = replaceOnce(source, LAST_OPENSSL_INCLUDE, `${LAST_OPENSSL_INCLUDE}#include <openssl/provider.h> /* amalgamator: dontcache */\n`, 'provider.h')
  return replaceOnce(withInclude, FIPS_STATUS_STUB, FIPS_STATUS_REAL, 'cipher_fips_status')
}

const ARGON2_ALLOC = [
  '    if (ctx->type != ARGON2_D)',
  '        ctx->memory = OPENSSL_secure_zalloc(ctx->memory_blocks * sizeof(BLOCK));',
  '    else',
  '        ctx->memory = OPENSSL_zalloc(ctx->memory_blocks * sizeof(BLOCK));',
  '',
].join('\n')
const ARGON2_ALLOC_PATCHED = [
  "    /* Slate (audit C4): the memory matrix is up to 4 GiB, the module's secure heap is 1 MiB, and",
  '     * OPENSSL_secure_zalloc never falls back, so a real-cost Argon2id derivation always failed. A matrix',
  '     * that fits stays in the secure heap; a larger one uses ordinary memory, which the',
  '     * OPENSSL_secure_clear_free at the end of the derivation cleanses before freeing. */',
  '    ERR_set_mark();',
  '    ctx->memory = ctx->type != ARGON2_D ? OPENSSL_secure_zalloc(ctx->memory_blocks * sizeof(BLOCK)) : NULL;',
  '    if (ctx->memory == NULL) {',
  '        ERR_pop_to_mark();',
  '        ctx->memory = OPENSSL_zalloc(ctx->memory_blocks * sizeof(BLOCK));',
  '    } else {',
  '        ERR_clear_last_mark();',
  '    }',
  '',
].join('\n')

/**
 * The one change Slate makes to libcrypto 3.5.x (providers/implementations/kdfs/argon2.c): Argon2id's
 * memory matrix falls back to ordinary memory when the secure heap cannot hold it. The FIPS provider is
 * built from its own pinned tarball and is not touched. The anchor must match exactly once.
 */
export function patchOpensslArgon2(source) {
  const n = source.split(ARGON2_ALLOC).length - 1
  if (n !== 1) throw new Error(`OpenSSL Argon2 patch: expected exactly one match, found ${n}; review the patch for this OpenSSL version`)
  return source.replace(ARGON2_ALLOC, () => ARGON2_ALLOC_PATCHED)
}
