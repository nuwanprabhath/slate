// The suite-0x01 read path (audit §4.5.1): header-v1 vaults, their local-keys and quick-unlock files, SLE1
// envelopes and AES-ECB remote names. The only file that calls the module's legacy primitives (RFC 5869
// HKDF from a key or a secret, one AES-ECB block); lint rule `slate/legacy-crypto-in-v1-path` keeps it so.
// A fips-140-3 vault never reaches here: its readSuites exclude 0x01, and after its unlock the module refuses
// these services outright (requireApprovedKeys, SCC_16).
import type { KeyHandle } from '@slate/native'
import { vaultNative } from './native'

/** RFC 5869 HKDF-SHA-256 from MK with an empty salt. K_localwrap is a KEK, every other subkey a data key. */
export function v1Subkey(mk: KeyHandle, info: string, usage: 'data' | 'kek'): KeyHandle {
  return vaultNative().hkdfLegacy(mk, new Uint8Array(0), info, usage)
}

/** An SLE1 file key: HKDF from K_sync with the file's salt. The caller destroys it. */
export function v1FileKey(kSync: KeyHandle, salt: Uint8Array): KeyHandle {
  return vaultNative().hkdfLegacy(kSync, salt, 'slate/v1/remote-file')
}

/** KEK_rc of a header-v1 vault: HKDF over the recovery secret (wiped by the module), the vault id as salt. */
export function v1RecoveryKek(secret: Uint8Array, vaultId: string): KeyHandle {
  return vaultNative().hkdfFromSecret(secret, new TextEncoder().encode(vaultId), 'slate/v1/recovery')
}

/** KEK_rc of a header-v1 vault from a typed recovery key the module decoded (C7): the same HKDF over its bytes. */
export function v1RecoveryKekFromHandle(recovery: KeyHandle, vaultId: string): KeyHandle {
  return vaultNative().hkdfFromRecovery(recovery, new TextEncoder().encode(vaultId), 'slate/v1/recovery')
}

/** KEK_qu of a v1 quick-unlock file: HKDF over QU (wiped by the module). */
export function v1QuickKek(qu: Uint8Array): KeyHandle {
  return vaultNative().hkdfFromSecret(qu, new Uint8Array(0), 'slate/v1/quick')
}

/** §15 N1: one AES-256 block of the packed id, so a name decodes without a map. */
export function v1NameBlock(kNameEnc: KeyHandle, block: Uint8Array, encrypt: boolean): Uint8Array {
  return vaultNative().aesEcbBlock(kNameEnc, block, encrypt)
}
