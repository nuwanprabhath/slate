import type { CryptoModuleStatus } from '../../../../shared/api'

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
  if (s.secureHeapLocked === false) rows.push(['Memory locking', 'Memory locking is unavailable on this system'])
  return rows
}
