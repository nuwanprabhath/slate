import type { CryptoModuleStatus } from '../../../../shared/api'

const PQ_FAMILIES = ['ML-KEM', 'ML-DSA'] as const

/**
 * The "Post-quantum algorithms" row (PQ-D3, INV-PQ-9). The validated provider (CMVP #4985) predates FIPS 203 and 204,
 * so these algorithms run in the build's ordinary OpenSSL and never inside the module, whatever `pqInFipsBoundary`
 * says: the text has no branch that places them inside.
 */
function pqRow(s: CryptoModuleStatus): string {
  const families = PQ_FAMILIES.filter((f) => s.pqAlgorithms.some((a) => a.startsWith(f)))
  if (families.length === 0) return 'Not available in this build'
  if (s.approvedMode) return `Not in the validated module: CMVP #${s.cmvp} predates FIPS 203 and FIPS 204`
  const version = /OpenSSL (\d+\.\d+\.\d+)/.exec(s.libcrypto ?? '')?.[1]
  return `${families.join(', ')} available (${version ? `OpenSSL ${version}, ` : ''}outside the validated module)`
}

/** Label/value rows for Settings → Security's "Cryptographic module" group (audit F-FIPS-08, Z-10). */
export function cryptoModuleRows(s: CryptoModuleStatus): Array<[string, string]> {
  const validation: [string, string] = ['Validation', `${s.standard}, CMVP certificate #${s.cmvp}`]
  if (!s.available) return [['Module', 'Not available'], validation, ['Approved mode', 'Off']]
  const rows: Array<[string, string]> = [
    ['Module', `${s.module} ${s.version}`],
    validation,
    ['Approved mode', s.approvedMode ? 'On' : s.errorState || s.problem || !s.development ? 'Off' : 'Off: development build without the FIPS provider'],
    // "Passed" only ever describes the approved module (review M2).
    ['Self-test at launch', s.problem ? `Failed: ${s.problem}` : s.approvedMode ? `Passed in ${s.postMs ?? 0} ms` : s.errorState ? 'Failed' : 'Not run: no FIPS provider'],
  ]
  if (s.libcrypto) rows.push(['Library', s.libcrypto])
  rows.push(['Post-quantum algorithms', pqRow(s)])
  if (s.secureHeapLocked === false) rows.push(['Memory locking', 'Memory locking is unavailable on this system'])
  return rows
}
