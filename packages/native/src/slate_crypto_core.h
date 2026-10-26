#ifndef SLATE_CRYPTO_CORE_H
#define SLATE_CRYPTO_CORE_H
#include <stddef.h>
#include <stdint.h>
enum {
  SCC_OK = 0, SCC_ERR_ARG = -1, SCC_ERR_STATE = -2, SCC_ERR_INIT = -3, SCC_ERR_SECURE_HEAP = -4,
  SCC_ERR_MODULE_CONFIG = -5, SCC_ERR_MODULE_SELFTEST = -6, SCC_ERR_HANDLES = -7, SCC_ERR_HANDLE = -8,
  SCC_ERR_DRBG = -9, SCC_ERR_CRYPTO = -10, SCC_ERR_AUTH = -11, SCC_ERR_ERROR_STATE = -12, SCC_ERR_HARDEN = -13,
  SCC_ERR_TOO_LARGE = -14, SCC_ERR_MODULE_DIGEST = -15,
  SCC_ERR_NOT_APPROVED = -16, SCC_ERR_USAGE = -17
};
/* What a key handle may do (audit C4; review C2 R2, C3 L1/L2). The module refuses cross-use with
 * SCC_ERR_USAGE:
 *   DATA      subkeys, file keys, module-random keys: AEAD, HMAC, AES, KDF input, KEK for DATA/DB keys
 *   MASTER    the vault master key: KDF input only (its subkeys are DATA); wrapped under PASSWORD only
 *   DB        a database key (LK): keys SQLCipher; wrapped under DATA only
 *   PASSWORD  derived from caller bytes (PBKDF2, Argon2id, HKDF over a secret), so reproducible by
 *             whoever knows them: wraps and unwraps MASTER keys and nothing else */
enum { SCC_USE_DATA = 1, SCC_USE_MASTER = 2, SCC_USE_DB = 3, SCC_USE_PASSWORD = 4, SCC_USE_KEK = 5, SCC_USE_RECOVERY = 6 };
/* C7: RECOVERY  a recovery secret decoded from typed text (scc_recovery_decode): only input to scc_hkdf_recovery,
 *               which makes the PASSWORD-class KEK_rc; nothing else accepts it */
/* Review C4 M1, on top of the above:
 *   KEK       wraps and unwraps database keys only (derived from a master key for local-wrap, or random)
 *   DATA      wraps and unwraps nothing, so no key is ever opened as data
 *   wrapping  only a fresh key (keyRandom, not yet used); an existing wrap moves to another KEK of the
 *             same kind with scc_rewrap_key, which never yields a handle or bytes
 *   approval  a key from a non-approved source is not wrapped or rewrapped under an approved KEK
 * C5 (review C4 M1-R): scc_rewrap_key moves password-class wraps only. A database key never moves to another
 *   KEK: it is wrapped once, fresh, under its master key's local-wrap KEK, so it never leaves that master's
 *   tree, and no KEK whose bytes JavaScript can compute ever receives it.
 * C5 criterion 2: once scc_require_approved_keys ran (a fips-140-3 vault), the non-approved services
 *   (Argon2id, RFC 5869 HKDF, AES-ECB: suite 0x01 and the standard password KDF) refuse with SCC_ERR_NOT_APPROVED. */
/* The largest input any service accepts (bytes), matching the SLE2 envelope cap. Every length is checked
 * against it as a size_t before any narrowing, so nothing above INT_MAX ever reaches EVP_*Update. */
#define SCC_MAX_INPUT ((size_t)256 * 1024 * 1024)
/* KDF labels (KBKDF Label, HKDF info): 1..128 bytes, no NUL, passed with an explicit length (review L1). */
#define SCC_MAX_LABEL ((size_t)128)
/* KDF cost bounds (review L2): a tampered header can neither weaken a derivation nor freeze the app. */
#define SCC_PBKDF2_MIN_ITER 1000u
#define SCC_PBKDF2_MAX_ITER 10000000u
/* The fips-140-3 profile's floor (audit §4.1); calibration never returns fewer. */
#define SCC_PBKDF2_FIPS_MIN_ITER 600000u
#define SCC_ARGON2_MIN_KIB 32u
#define SCC_ARGON2_MAX_KIB 4194304u
#define SCC_ARGON2_MIN_PASSES 1u
#define SCC_ARGON2_MAX_PASSES 16u
int scc_harden_process(void);
int scc_preinit(void);
const char *scc_build_kind(void);
int scc_init(const char *fips_config_path, const char *modules_dir, int require_fips);
int scc_fips_active(void);
void scc_enter_error_state(void);
int scc_in_error_state(void);
int scc_error_latched(void);
/* C6: the power-up self-test gate (audit S-1, S-2). scc_post_gate is one-way; scc_post_end(0) enters the error state. */
void scc_post_gate(void);
int scc_post_passed(void);
int scc_post_begin(void);
int scc_post_end(int passed);
int scc_key_random(uint32_t *handle);
int scc_key_random_for(int usage, uint32_t *handle);
#ifdef SCC_KAT_BUILD
int scc_key_import(const unsigned char *bytes, size_t len, uint32_t *handle);
int scc_key_import_for(const unsigned char *bytes, size_t len, int usage, uint32_t *handle);
#endif
int scc_key_usage(uint32_t handle);
int scc_require_approved_keys(void);
int scc_approved_keys_required(void);
int scc_key_destroy(uint32_t handle);
size_t scc_zeroize_all(void);
size_t scc_live_handles(void);
size_t scc_secure_heap_used(void);
/* 1 once scc_init succeeded and the module is not in the error state. Safe in every init state. */
int scc_ready(void);
int scc_kbkdf_for(uint32_t key, const char *label, size_t label_len, const unsigned char *ctx, size_t ctx_len, int usage, uint32_t *out);
int scc_hkdf_legacy_for(uint32_t key, const unsigned char *salt, size_t salt_len, const char *info, size_t info_len, int usage, uint32_t *out);
int scc_rewrap_key(uint32_t old_kek, const unsigned char *iv, const unsigned char *aad, size_t aad_len, const unsigned char *ct_tag, size_t ct_tag_len,
                   uint32_t new_kek, const unsigned char *new_aad, size_t new_aad_len, unsigned char *iv_out, unsigned char *ct_out);
int scc_kbkdf(uint32_t key, const char *label, size_t label_len, const unsigned char *ctx, size_t ctx_len, uint32_t *out);
int scc_pbkdf2(const unsigned char *pw, size_t pw_len, const unsigned char *salt, size_t salt_len, uint64_t iter, uint32_t *out);
int scc_argon2id(const unsigned char *pw, size_t pw_len, const unsigned char *salt, size_t salt_len, uint32_t memory_kib, uint32_t passes, uint32_t *out);
int scc_gcm_seal(uint32_t key, const unsigned char *iv_in, const unsigned char *aad, size_t aad_len, const unsigned char *pt, size_t pt_len, unsigned char *iv_out, unsigned char *ct_tag);
int scc_gcm_seal_iv_in_aad(uint32_t key, const unsigned char *aad, size_t aad_len, size_t iv_offset, const unsigned char *pt, size_t pt_len, unsigned char *iv_out, unsigned char *ct_tag);
int scc_gcm_open(uint32_t key, const unsigned char *iv, const unsigned char *aad, size_t aad_len, const unsigned char *ct_tag, size_t ct_tag_len, unsigned char *pt);
int scc_hkdf_secret(const unsigned char *secret, size_t len, const unsigned char *salt, size_t salt_len, const char *info, size_t info_len, uint32_t *out);
/* C7: the longest recovery-key text accepted (56 characters plus separators and whitespace). */
#define SCC_RECOVERY_MAX_TEXT ((size_t)256)
int scc_recovery_decode(const unsigned char *text, size_t len, uint32_t *out);
int scc_hkdf_recovery(uint32_t key, const unsigned char *salt, size_t salt_len, const char *info, size_t info_len, uint32_t *out);
/* C5 with C7: suite 0x02's KEK_rc, SP 800-108r1 KBKDF from a RECOVERY handle (approved as `approved` says). */
int scc_kbkdf_recovery(uint32_t key, const char *label, size_t label_len, const unsigned char *ctx, size_t ctx_len, int approved, uint32_t *out);
/* Argon2id as a job, so the addon can run the derivation off the main thread: `new` (main thread) validates
 * and copies the password into the secure heap; `run` (any thread, touches no handle) derives into the job;
 * `finish` (main thread) moves the result into a PASSWORD handle; `free` (always, last) cleanses and frees
 * the password and the derived bytes, whether or not the job finished. */
typedef struct scc_argon2_job scc_argon2_job;
int scc_argon2id_job_new(const unsigned char *pw, size_t pw_len, const unsigned char *salt, size_t salt_len, uint32_t memory_kib, uint32_t passes, scc_argon2_job **job);
int scc_argon2id_job_run(scc_argon2_job *job);
/* The same job for PBKDF2-HMAC-SHA-512 (review C5 L1); run, finish and free as above. */
int scc_pbkdf2_job_new(const unsigned char *pw, size_t pw_len, const unsigned char *salt, size_t salt_len, uint64_t iter, scc_argon2_job **job);
int scc_argon2id_job_finish(scc_argon2_job *job, uint32_t *out);
void scc_argon2id_job_free(scc_argon2_job *job);
/* Suite 0x02 (audit §4.5.2, §4.6). KEK_rc / KEK_qu: SP 800-108r1 over a caller secret (>= 16 bytes), a
 * password-class key. Names: SIV = HMAC-SHA-256(mac, "slate-name/v2" 0x00 || p)[0..16), C = AES-256-CTR(enc,
 * ICB = SIV, p); decode refuses (SCC_ERR_AUTH, output cleansed) unless the SIV matches in constant time.
 * `approved = 0` marks the KEK non-approved: a standard-profile vault's KEKs protect a master key that an
 * Argon2id KEK also opens, so none of them is approved (IG 2.4.A). Lowering approval never launders. */
int scc_kbkdf_secret(const unsigned char *secret, size_t len, const char *label, size_t label_len, const unsigned char *ctx, size_t ctx_len, int approved, uint32_t *out);
int scc_name_siv_encode(uint32_t enc, uint32_t mac, const unsigned char p[16], unsigned char out[32]);
int scc_name_siv_decode(uint32_t enc, uint32_t mac, const unsigned char in[32], unsigned char p_out[16]);
/* PBKDF2-HMAC-SHA-512 iterations that take about target_ms (100..10000) here, in [600000, 10^7]. */
int scc_pbkdf2_calibrate(uint32_t target_ms, uint64_t *iterations);
int scc_hkdf_legacy(uint32_t key, const unsigned char *salt, size_t salt_len, const char *info, size_t info_len, uint32_t *out);
int scc_heap_locked(void);
int scc_selftest_failures(void);
int scc_default_ctx_providers(char *buf, size_t len);
int scc_fips_module_info(char *name, size_t name_len, char *version, size_t version_len);
int scc_gcm_open_key(uint32_t kek, const unsigned char *iv, const unsigned char *aad, size_t aad_len, const unsigned char *ct_tag, size_t ct_tag_len, uint32_t *out);
int scc_gcm_open_key_for(uint32_t kek, const unsigned char *iv, const unsigned char *aad, size_t aad_len, const unsigned char *ct_tag, size_t ct_tag_len, int usage, uint32_t *out);
int scc_gcm_seal_key(uint32_t kek, uint32_t key, const unsigned char *iv_in, const unsigned char *aad, size_t aad_len, unsigned char *iv_out, unsigned char *ct_tag);
/* C9 (audit §4.5.2, §4.7): a master key of an earlier key epoch, kept in the vault header's `history` wrapped
 * under K_hist,e = KBKDF(MK_current, "slate/v2/history", ctx), ctx = vid || uint32be(e) (20 bytes). K_hist never
 * becomes a handle, so it wraps nothing else and is never used for anything else.
 *   seal    the key that moves into history comes out of a proof (its wrap under a password-class KEK that opens
 *           it, as for scc_rewrap_key), so only a caller holding that key's password moves it; `mk_new` (a MASTER
 *           key) is the epoch the entry is filed under. Its own key is refused (SCC_ERR_ARG).
 *   rewrap  an entry under the K_hist of the key a proof opens moves under the K_hist of `mk_new` (the next rotation)
 *   open    an entry under the K_hist of `mk` becomes a MASTER handle (approved as `mk`, never fresh), to read old files
 * Approval as everywhere: a key from a non-approved source is never sealed under an approved K_hist. */
int scc_history_seal(uint32_t proof_kek, const unsigned char *iv, const unsigned char *aad, size_t aad_len, const unsigned char *ct_tag, size_t ct_tag_len,
                     uint32_t mk_new, const unsigned char *ctx, size_t ctx_len, const unsigned char *new_aad, size_t new_aad_len, unsigned char *iv_out, unsigned char *ct_out);
int scc_history_rewrap(uint32_t proof_kek, const unsigned char *iv, const unsigned char *aad, size_t aad_len, const unsigned char *ct_tag, size_t ct_tag_len,
                       const unsigned char *ctx_cur, size_t ctx_cur_len, const unsigned char *e_iv, const unsigned char *e_aad, size_t e_aad_len,
                       const unsigned char *e_ct, size_t e_ct_len, uint32_t mk_new, const unsigned char *ctx_new, size_t ctx_new_len,
                       const unsigned char *new_aad, size_t new_aad_len, unsigned char *iv_out, unsigned char *ct_out);
int scc_history_open(uint32_t mk, const unsigned char *ctx, size_t ctx_len, const unsigned char *iv, const unsigned char *aad, size_t aad_len,
                     const unsigned char *ct_tag, size_t ct_tag_len, uint32_t *out);
int scc_hmac_sha256(uint32_t key, const unsigned char *data, size_t len, unsigned char out[32]);
int scc_aes_ecb_block(uint32_t key, const unsigned char in[16], int encrypt, unsigned char out[16]);
int scc_aes_ctr(uint32_t key, const unsigned char icb[16], const unsigned char *in, size_t len, unsigned char *out);
int scc_sha256(const unsigned char *data, size_t len, unsigned char out[32]);
int scc_random(unsigned char *out, size_t len);
int scc_sqlcipher_raw_key(uint32_t key, char out[68]);
#endif
