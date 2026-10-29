import { describe, expect, it } from 'vitest'
import type { CryptoModuleStatus } from '../../../../shared/api'
import { cryptoModuleRows } from './cryptoModuleText'

const healthy: CryptoModuleStatus = {
  available: true,
  problem: null,
  module: 'OpenSSL FIPS Provider',
  version: '3.1.2',
  cmvp: 4985,
  standard: 'FIPS 140-3',
  certificateUrl: 'https://csrc.nist.gov/projects/cryptographic-module-validation-program/certificate/4985',
  approvedMode: true,
  errorState: false,
  postMs: 42,
  libcrypto: 'OpenSSL 3.5.9 30 Sep 2026',
  secureHeapLocked: true,
  development: false,
  pqAlgorithms: ['ML-KEM-768', 'ML-KEM-1024', 'ML-DSA-65', 'ML-DSA-87', 'SLH-DSA-SHA2-256s'],
  pqInFipsBoundary: false,
}

describe('cryptoModuleRows (Settings → Security, F-FIPS-08)', () => {
  it('shows module name, version, CMVP number, approved-mode state and POST time', () => {
    expect(cryptoModuleRows(healthy)).toEqual([
      ['Module', 'OpenSSL FIPS Provider 3.1.2'],
      ['Validation', 'FIPS 140-3, CMVP certificate #4985'],
      ['Approved mode', 'On'],
      ['Self-test at launch', 'Passed in 42 ms'],
      ['Library', 'OpenSSL 3.5.9 30 Sep 2026'],
      ['Post-quantum algorithms', 'Not in the validated module: CMVP #4985 predates FIPS 203 and FIPS 204'],
    ])
  })

  it('a development build without the provider never says the self-test passed (review M2)', () => {
    const rows = cryptoModuleRows({ ...healthy, approvedMode: false, development: true })
    expect(rows).toContainEqual(['Approved mode', 'Off: development build without the FIPS provider'])
    expect(rows).toContainEqual(['Self-test at launch', 'Not run: no FIPS provider'])
    expect(rows.some(([, v]) => v.startsWith('Passed'))).toBe(false)
  })

  it('never says Passed when approved mode is off, whatever else the status says', () => {
    for (const s of [{ ...healthy, approvedMode: false }, { ...healthy, approvedMode: false, development: true }, { ...healthy, approvedMode: false, problem: 'X' }]) {
      expect(cryptoModuleRows(s).some(([, v]) => v.startsWith('Passed'))).toBe(false)
    }
  })

  it('says when the module failed its self-test, with the code', () => {
    const rows = cryptoModuleRows({ ...healthy, approvedMode: false, errorState: true, problem: 'POST-MODULE-LOAD (SCC_6)' })
    expect(rows).toContainEqual(['Approved mode', 'Off'])
    expect(rows).toContainEqual(['Self-test at launch', 'Failed: POST-MODULE-LOAD (SCC_6)'])
  })

  it('says when memory locking is unavailable (Z-10)', () => {
    expect(cryptoModuleRows({ ...healthy, secureHeapLocked: false })).toContainEqual(['Memory locking', 'Memory locking is unavailable on this system'])
  })

  it('reports a missing module as not available', () => {
    const rows = cryptoModuleRows({ ...healthy, available: false, approvedMode: false, postMs: null, libcrypto: null, secureHeapLocked: null, problem: 'The cryptographic module is not available in this build.' })
    expect(rows).toEqual([
      ['Module', 'Not available'],
      ['Validation', 'FIPS 140-3, CMVP certificate #4985'],
      ['Approved mode', 'Off'],
    ])
  })
})

describe('the Post-quantum algorithms row (INV-PQ-9)', () => {
  const pq = (s: CryptoModuleStatus) => cryptoModuleRows(s).find(([l]) => l === 'Post-quantum algorithms')?.[1]

  it('T-PQ-D3-01: outside the module in both profiles, never implied to be inside', () => {
    const outside = { ...healthy, approvedMode: false, development: true }
    expect(pq(outside)).toBe('ML-KEM, ML-DSA available (OpenSSL 3.5.9, outside the validated module)')
    expect(pq(healthy)).toBe('Not in the validated module: CMVP #4985 predates FIPS 203 and FIPS 204')
    for (const s of [outside, healthy, { ...healthy, pqInFipsBoundary: true }, { ...outside, pqInFipsBoundary: true }]) {
      const text = pq(s) ?? ''
      expect(text).toMatch(/outside the validated module|Not in the validated module/)
      expect(text).not.toMatch(/quantum-proof|unbreakable|certified|inside the validated|in the validated module(?!:)/i)
    }
  })

  it('T-PQ-D3-01: a build without the algorithms says so, and a missing module has no row', () => {
    expect(pq({ ...healthy, approvedMode: false, pqAlgorithms: [] })).toBe('Not available in this build')
    expect(pq({ ...healthy, available: false, approvedMode: false, pqAlgorithms: [] })).toBeUndefined()
  })
})
