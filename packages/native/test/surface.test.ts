// Source-level guards for the native boundary (audit §7.3 C2 criteria 3 and 4, §4.3 V8 cage).
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..')
const core = readFileSync(join(root, 'src', 'slate_crypto_core.c'), 'utf8')
const header = readFileSync(join(root, 'src', 'slate_crypto_core.h'), 'utf8')
const binding = readFileSync(join(root, 'src', 'binding.c'), 'utf8')
const indexTs = readFileSync(join(root, 'index.ts'), 'utf8')

/** Functions that never perform a cryptographic service, so they stay callable in the error state:
 * status queries, process hardening, entering the error state and zeroisation itself. */
const ERROR_STATE_EXEMPT = new Set([
  'scc_harden_process',
  'scc_init',
  'scc_preinit',
  'scc_fips_active',
  'scc_enter_error_state',
  'scc_in_error_state',
  'scc_error_latched',
  'scc_key_destroy',
  'scc_zeroize_all',
  'scc_live_handles',
  'scc_secure_heap_used',
  'scc_heap_locked',
  'scc_selftest_failures',
  'scc_fips_module_info',
  'scc_default_ctx_providers',
  // C4: a usage and latch query, and freeing an Argon2id job (it only wipes, so it must work in the error state).
  'scc_key_usage',
  'scc_approved_keys_required',
  'scc_argon2id_job_free',
  // Review C4 L2: runs on a libuv thread, so it reads the error flag instead of running the gate (surface.test Z-7).
  'scc_argon2id_job_run',
  // C6: the self-test gate's own controls. They run no service; scc_post_begin refuses in the error state and
  // scc_post_end(0) enters it (kat.c "C6 …").
  'scc_post_gate',
  'scc_post_passed',
  'scc_post_begin',
  'scc_post_end',
  // PQ-A1: the post-quantum inventory in status(); queries, like scc_fips_module_info.
  'scc_pq_algorithms',
  'scc_pq_in_fips_boundary',
])

/** Every exported `scc_*` definition and the text up to its first `return` that can produce a result. */
export function functionsMissingErrorGate(source: string): string[] {
  const missing: string[] = []
  // Any return type; the gate must be the body's first statement, before any lookup or work (review M1).
  const re = /^[A-Za-z_][\w \t*]*?\b(scc_\w+)\([^)]*\)\s*\{\n([\s\S]*?)^\}/gm
  for (const m of source.matchAll(re)) {
    const [, name, body] = m as unknown as [string, string, string]
    // scc__* are KAT-only hooks, compiled only under SCC_KAT_BUILD.
    if (ERROR_STATE_EXEMPT.has(name) || name.startsWith('scc__')) continue
    if (!/^\s*SERVICE_GATE\(\);/.test(body)) missing.push(name)
  }
  return missing
}

/** Review H1: `(int)` casts outside int_len(), or an EVP_*Update length that is not an int_len() result. */
export function narrowingViolations(source: string): string[] {
  const out: string[] = []
  const withoutHelper = source.replace(/static int int_len\([\s\S]*?\n\}/, '')
  for (const m of withoutHelper.matchAll(/\((?:int|unsigned|int32_t|uint32_t|long)\)\s*\w+/g)) out.push(m[0])
  for (const m of source.matchAll(/EVP_(?:Encrypt|Decrypt|Cipher)Update\([^;\n]*?,\s*([\w>.-]+)\)\s*==/g)) {
    if (!/_n$|^\d+$/.test(m[1]!)) out.push(m[0])
  }
  return out
}

describe('review H1: no narrowing of a length on its way to OpenSSL', () => {
  it('the core casts only inside int_len(), and every EVP_*Update length comes from it', () => {
    expect(narrowingViolations(core)).toEqual([])
    expect(core).toMatch(/if \(n > SCC_MAX_INPUT\) return 0;/)
    expect(header).toMatch(/#define SCC_MAX_INPUT \(\(size_t\)256 \* 1024 \* 1024\)/)
  })

  it('the guard catches the reviewed (int) casts', () => {
    const bad = 'ok = EVP_EncryptUpdate(x, ct_tag, &len, pt, (int)pt_len) == 1 &&\n EVP_DecryptUpdate(x, pt, &len, ct_tag, ct_len) == 1;'
    expect(narrowingViolations(bad)).toEqual(['(int)pt_len', 'EVP_DecryptUpdate(x, pt, &len, ct_tag, ct_len) =='])
  })

  it('the native build fails on implicit narrowing (-Wconversion -Werror)', () => {
    const gyp = readFileSync(join(root, 'binding.gyp'), 'utf8')
    expect(gyp).toMatch(/"-Wconversion", "-Werror"/)
    expect(gyp).toMatch(/"-Wshorten-64-to-32"/)
    expect(gyp).toMatch(/"GCC_TREAT_WARNINGS_AS_ERRORS": "YES"/)
  })
})

describe('criterion 4: every service refuses work in the error state (SCC_12)', () => {
  it('gates each scc_* service on g_error_state', () => {
    const declared = [...header.matchAll(/\b(scc_\w+)\(/g)].map((m) => m[1])
    expect(declared.length).toBeGreaterThan(20)
    expect(functionsMissingErrorGate(core)).toEqual([])
  })

  it('the guard catches a service without the gate', () => {
    const bad = 'int scc_new_service(uint32_t key) {\n  unsigned char *k = slot_bytes(key);\n  return k ? SCC_OK : SCC_ERR_HANDLE;\n}\n'
    expect(functionsMissingErrorGate(bad)).toEqual(['scc_new_service'])
    const late = 'unsigned char *scc_late(uint32_t key) {\n  unsigned char *k = slot_bytes(key);\n  SERVICE_GATE();\n  return k;\n}\n'
    expect(functionsMissingErrorGate(late)).toEqual(['scc_late'])
  })

  it('the gate refuses before init (SCC_2) as well as in the error state (SCC_12)', () => {
    expect(core).toMatch(/if \(scc_in_error_state\(\)\) return SCC_ERR_ERROR_STATE;\s*\\\s*if \(!g_ready\) return SCC_ERR_STATE;/)
    expect(core).toMatch(/g_ready = 1;\n  return SCC_OK;\n\}/)
    expect(binding).toMatch(/if \(scc_preinit\(\) != SCC_OK\)/)
  })

  it('C6: the gate also refuses (SCC_2) in a gated module until its self-test passed, outside a self-test session', () => {
    expect(core).toMatch(/if \(!g_ready\) return SCC_ERR_STATE;\s*\\\s*if \(g_post_gated && !g_post_open && !g_post_ok\)\s*\\\s*return SCC_ERR_STATE;/)
    // One-way: nothing ever clears the gate or the pass, except the error state, which wins anyway.
    expect(core.match(/g_post_gated = 0/g)).toHaveLength(1)
    expect(core.match(/g_post_ok = 1;/g)).toHaveLength(1)
  })

  it('review C3 (C6): any service answering SCC_12 closes every SQLCipher connection, even when the module latched on its own', () => {
    // A DRBG failure or the provider's own error state latches the module without enterErrorState.
    expect(binding).toMatch(/static napi_value throw_rc\(napi_env env, int rc\) \{\n\s*if \(rc == SCC_ERR_ERROR_STATE\) slate_sqlite_close_all\(\);/)
    // Every service reports through throw_rc; only the SQLite binding (mid-call) uses the raw throw_code.
    const outside = binding.replace(/static napi_value throw_(?:code|rc)\([\s\S]*?\n\}/g, '')
    expect(outside.match(/throw_code\(/g)).toHaveLength(1)
    expect(binding).toMatch(/void slate_throw_scc\(napi_env env, int rc\) \{ \(void\)throw_code\(env, rc\); \}/)
  })

  it('tags handles with a generation so a destroyed handle never names a reused slot (SCC_8)', () => {
    expect(core).toMatch(/s->generation != \(\(handle >> 8\) & GEN_MAX\)/)
    expect(core).toMatch(/g_slots\[i\]\.generation < GEN_MAX/)
    expect(binding.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/napi_get_value_uint32/)
  })
})

describe('review L1: strings are read whole or refused', () => {
  it('binding.c reads strings only through get_string(), and the core never uses strlen on a label', () => {
    const outside = binding.replace(/static int get_string\([\s\S]*?\n\}/, '')
    expect(outside).not.toMatch(/napi_get_value_string_utf8/)
    expect(core).not.toMatch(/strlen\((?:label|info)\)/)
    expect(core).toMatch(/memchr\(label, '\\0', len\) == NULL/)
  })
})

describe('review L3: a password is wiped on every exit', () => {
  it('C7: the recovery decoder cleanses every temporary on its one exit', () => {
    const body = /int scc_recovery_decode\([^)]*\) \{([\s\S]*?)\n\}/.exec(core)?.[1] ?? ''
    for (const v of ['digits', 'key', 'digest', '&acc', '&check', '&diff', '&d0', '&d1', '&d2']) expect(body, v).toContain(`OPENSSL_cleanse(${v}, sizeof ${v.replace('&', '')})`)
    expect(body.split('return').length - 1).toBe(1)
  })

  it('Pbkdf2 and Argon2id leave only through `out:`, which cleanses the password', () => {
    for (const fn of ['Pbkdf2', 'Argon2id', 'HkdfFromSecret', 'RecoveryDecode']) {
      const body = new RegExp(`static napi_value ${fn}\\(napi_env env, napi_callback_info info\\) \\{([\\s\\S]*?)\\n\\}`).exec(binding)?.[1] ?? ''
      expect(body, fn).toMatch(/out:\n  if \(pw != NULL\) OPENSSL_cleanse\(pw, pw_len\);/)
      expect(body.split('return').length - 1, `${fn} has one return`).toBe(1)
      expect(body, fn).not.toMatch(/CHECK\(/)
    }
  })
})

describe('C4 Z-7: no thread but the main one ever sees the password', () => {
  it('Argon2idAsync copies the password into the job and wipes the JavaScript bytes before it returns', () => {
    const body = /static napi_value Argon2idAsync\(napi_env env, napi_callback_info info\) \{([\s\S]*?)\n\}/.exec(binding)?.[1] ?? ''
    expect(body).toMatch(/scc_argon2id_job_new\(pw, pw_len,[\s\S]*out:\n  if \(pw != NULL\) OPENSSL_cleanse\(pw, pw_len\);/)
    expect(body).not.toMatch(/CHECK\(/)
    // The libuv thread runs only the job, which holds its own secure-heap copy.
    const execute = /static void argon2_execute\([^)]*\) \{([\s\S]*?)\n\}/.exec(binding)?.[1] ?? ''
    expect(execute.trim().split('\n').map((l) => l.trim())).toEqual(['(void)env;', 'argon2_async *a = data;', '(void)scc_argon2id_job_run(a->job);'])
    const run = /int scc_argon2id_job_run\(scc_argon2_job \*job\) \{([\s\S]*?)\n\}/.exec(core)?.[1] ?? ''
    expect(run).not.toMatch(/slot|alloc_slot|g_slots/)
    // Review C4 L2: not even through the gate, whose provider check can latch the error state and zeroize
    // the slot table from this thread. The run reads the flags only; job_new and job_finish gate on main.
    expect(run).not.toMatch(/SERVICE_GATE|scc_in_error_state|scc_enter_error_state|zeroize/)
    expect(run).toMatch(/atomic_load\(&g_error_state\)/)
    expect(run).toMatch(/OPENSSL_cleanse\(job->pw/)
  })
})

describe('C4: key usage (reviews C2 R2, C3 L1/L2)', () => {
  it('every keyed service checks the handle\'s usage before it touches the key', () => {
    for (const fn of ['scc_gcm_seal', 'scc_gcm_seal_iv_in_aad', 'scc_gcm_open', 'scc_hmac_sha256', 'scc_aes_ecb_block', 'scc_aes_ctr', 'scc_kbkdf_for', 'scc_hkdf_legacy_for', 'scc_sqlcipher_raw_key', 'scc_hkdf_recovery']) {
      const body = new RegExp(`int ${fn}\\([^)]*\\) \\{([\\s\\S]*?)\\n\\}`).exec(core)?.[1] ?? ''
      expect(body, fn).toMatch(/need_usage\(key, SCC_USE_/)
      expect(body.indexOf('need_usage'), fn).toBeLessThan(Math.max(body.indexOf('slot_bytes'), 0) || Infinity)
    }
    expect(core).toMatch(/if \(kek_usage == SCC_USE_PASSWORD\) return key_usage == SCC_USE_MASTER;/)
    // Review C4 M1: a data key is never a KEK, and only a fresh key is wrapped.
    const wrap = /static int wrap_allowed\(int kek_usage, int key_usage\) \{([\s\S]*?)\n\}/.exec(core)?.[1] ?? ''
    expect(wrap).not.toMatch(/SCC_USE_DATA/)
    expect(wrap).toMatch(/if \(kek_usage == SCC_USE_KEK\) return key_usage == SCC_USE_DB;/)
    expect(core).toMatch(/if \(!wrap_allowed\(ku, wu\) \|\| !slot_fresh\(key\)\) return SCC_ERR_USAGE;/)
  })
})

describe('review L4: provider and DRBG failures are the module\'s error state', () => {
  it('scc_in_error_state consults the provider status, and every DRBG failure latches', () => {
    expect(core).toMatch(/OSSL_PARAM_construct_int\(OSSL_PROV_PARAM_STATUS, &status\)/)
    expect(core).toMatch(/if \(!g_error_state && provider_in_error\(\)\) scc_enter_error_state\(\);/)
    const raw = core.replace(/static int drbg_failed\(void\) \{[\s\S]*?\n\}/, '')
    expect(raw).not.toMatch(/SCC_ERR_DRBG/)
  })
})

describe('criterion 3: no library context crosses into JavaScript', () => {
  it('neither the binding nor the core API names OSSL_LIB_CTX', () => {
    expect(binding).not.toMatch(/OSSL_LIB_CTX|OSSL_PROVIDER/)
    expect(header).not.toMatch(/OSSL_LIB_CTX|OSSL_PROVIDER/)
    expect(indexTs).not.toMatch(/libctx|libCtx|LibCtx|OSSL_LIB_CTX/)
  })

  it('the JavaScript surface in index.ts matches what binding.c registers', () => {
    const registered = [...binding.matchAll(/\{"(\w+)", NULL, \w+, NULL, NULL, NULL, napi_default, NULL\}/g)].map((m) => m[1]).sort()
    const iface = /export interface SlateNative \{([\s\S]*?)\n\}/.exec(indexTs)?.[1] ?? ''
    const typed = [...iface.matchAll(/^\s{2}(\w+)\(/gm)].map((m) => m[1]).sort()
    expect(registered.length).toBeGreaterThan(15)
    expect(typed).toEqual(registered)
  })

  it('T-PQ-A1-07: the export list gains exactly mldsaVerify, and the addon still exports only the two N-API symbols', () => {
    const registered = [...binding.matchAll(/\{"(\w+)", NULL, \w+, NULL, NULL, NULL, napi_default, NULL\}/g)].map((m) => m[1])
    // The surface before PQ-A1, in registration order; anything else added here is a reviewed change.
    const before = 'init hardenProcess postGate postBegin postEnd status enterErrorState zeroizeAll keyRandom requireApprovedKeys hkdfFromSecret kbkdfFromSecret pbkdf2Calibrate nameSivEncode nameSivDecode recoveryDecode hkdfFromRecovery kbkdfFromRecovery argon2idAsync keyDestroy kbkdf hkdfLegacy pbkdf2 pbkdf2Async argon2id gcmSeal gcmSealIvInAad gcmOpen gcmOpenKey gcmSealKey rewrapKey historySeal historyRewrap historyOpen hmacSha256 aesEcbBlock aesCtr sha256 randomBytes'.split(' ')
    expect(registered.filter((name) => !before.includes(name!))).toEqual(['mldsaVerify'])
    expect(before.filter((name) => !registered.includes(name))).toEqual([])
    const r = spawnSync(process.execPath, [join(root, 'scripts', 'check-exports.mjs')], { encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/exactly napi_register_module_v1, node_api_module_get_api_version_v1/)
  })

  it('PQ-A1: mldsaVerify works on public bytes only (no key handle), and approved-only mode does not refuse it', () => {
    const body = core.slice(core.indexOf('int scc_mldsa_verify('), core.indexOf('\n}\n', core.indexOf('int scc_mldsa_verify(')))
    expect(body).toMatch(/^int scc_mldsa_verify\(int level, const unsigned char \*spki_der, size_t spki_len,/)
    expect(body).not.toMatch(/slot_bytes|need_usage|NOT_AFTER_LATCH|g_fips_ctx/)
    expect(body).toMatch(/EVP_PKEY_verify_message_init\(/)
    expect(body).toMatch(/g_std_ctx/)
    expect(header).toMatch(/scc_mldsa_verify[\s\S]*not refused by scc_require_approved_keys|not refused by scc_require_approved_keys[\s\S]*scc_mldsa_verify/)
  })
})

describe('§4.3 V8 memory cage', () => {
  it('never hands JavaScript a buffer that points into native (secure-heap) memory', () => {
    expect(binding).not.toMatch(/napi_create_external_(?:arraybuffer|buffer)|napi_create_external\b/)
  })

  it('criterion 5: the secure heap is 1 MiB with a 32-byte minimum, and its lock state is reported', () => {
    expect(core).toMatch(/CRYPTO_secure_malloc_init\(1 << 20, 32\)/)
    expect(binding).toMatch(/"secureHeapLocked"/)
  })

  it('review M4: the provider is hashed against the compiled-in pin before OpenSSL is pointed at it', () => {
    const init = core.slice(core.indexOf('int scc_init('))
    expect(init.indexOf('verify_provider_digest(modules_dir)')).toBeGreaterThan(0)
    expect(init.indexOf('verify_provider_digest(modules_dir)')).toBeLessThan(init.indexOf('OSSL_PROVIDER_set_default_search_path'))
    expect(init.indexOf('verify_provider_digest(modules_dir)')).toBeLessThan(init.indexOf('OSSL_PROVIDER_load(g_fips_ctx, "fips")'))
  })

  it('criterion 2: the core never lets libcrypto read a system openssl.cnf', () => {
    expect(core).toMatch(/OPENSSL_init_crypto\(OPENSSL_INIT_NO_LOAD_CONFIG, NULL\)/)
    expect(core.indexOf('OPENSSL_INIT_NO_LOAD_CONFIG')).toBeLessThan(core.indexOf('CRYPTO_secure_malloc_init(1 << 20'))
    expect(core).toMatch(/OSSL_PROVIDER_set_default_search_path\(g_fips_ctx, modules_dir\)/)
    expect(core.indexOf('OSSL_PROVIDER_set_default_search_path')).toBeLessThan(core.indexOf('OSSL_LIB_CTX_load_config'))
  })
})

describe('C3: SQLCipher keys come only from key handles', () => {
  const sqliteKey = readFileSync(join(root, 'src', 'sqlite_key.c'), 'utf8')
  const gyp = readFileSync(join(root, 'binding.gyp'), 'utf8')
  const vendored = ['better_sqlite3.cpp', 'objects/database.cpp', 'objects/database.hpp'].map((f) => readFileSync(join(root, 'src', 'sqlite', f), 'utf8')).join('\n')
  const wrappersJs = readFileSync(join(root, 'sqlite', 'methods', 'wrappers.js'), 'utf8')

  it('only sqlite_key.c calls sqlite3_key*/sqlite3_rekey*, and it cleanses the raw key on every path', () => {
    expect(vendored).not.toMatch(/sqlite3_(?:re)?key(?:_v2)?\s*\(/)
    expect(sqliteKey).toMatch(/sqlite3_key_v2\(/)
    const body = /int slate_sqlcipher_key\([^)]*\) \{\n([\s\S]*?)\n\}/.exec(sqliteKey)?.[1] ?? ''
    expect(body.split('return').length - 1).toBe(1)
    expect(body.indexOf('OPENSSL_cleanse(raw, sizeof raw);')).toBeGreaterThan(-1)
    expect(body.indexOf('OPENSSL_cleanse(raw, sizeof raw);')).toBeLessThan(body.indexOf('return'))
  })

  it('every connection gets the authorizer that refuses key pragmas, and loadExtension is gone', () => {
    expect(vendored).toMatch(/sqlite3_set_authorizer\(db_handle, slate_sqlite_authorizer, &this->slate\)/)
    expect(vendored).not.toMatch(/SQLITE_DBCONFIG_ENABLE_LOAD_EXTENSION|sqlite3_load_extension|"key"|"rekey"|"loadExtension"/)
    expect(gyp).toMatch(/"SQLITE_OMIT_LOAD_EXTENSION"/)
    expect(wrappersJs).not.toMatch(/Buffer|export const (?:key|rekey|loadExtension)\b/)
  })

  it("Slate's own C in the SQLite seam builds with the module's strict flags; only vendored targets are relaxed", () => {
    const target = gyp.slice(gyp.indexOf('"target_name": "slate_native"'))
    expect(target).toMatch(/"sources": \["src\/slate_crypto_core\.c", "src\/binding\.c", "src\/sqlite_key\.c"\]/)
    expect(target).toMatch(/"-Wconversion", "-Werror"/)
    for (const relaxed of ['sqlcipher', 'sqlite_binding']) {
      const start = gyp.indexOf(`"target_name": "${relaxed}"`)
      const t = gyp.slice(start, gyp.indexOf('"target_name"', start + 1))
      expect(t).not.toMatch(/src\/(?:slate_crypto_core|binding|sqlite_key)\.c/)
    }
  })
})
