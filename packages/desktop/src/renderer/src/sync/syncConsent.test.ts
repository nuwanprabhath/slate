import { describe, expect, it } from 'vitest'
import { plaintextRefused, refusedFeature } from './syncConsent'

/** How invoke hands a main-process throw to the renderer. */
const fromMain = (name: string, message: string) => new Error(`Error invoking remote method 'sync:configure': ${name}: ${message}`)

describe('reading a sync refusal back from main (GDPR-03)', () => {
  it('finds the provider consent a ConsentRequired names', () => {
    expect(refusedFeature(fromMain('ConsentRequired', 'gitSync needs consent'))).toBe('gitSync')
    expect(refusedFeature(fromMain('ConsentRequired', 'oneDriveSync needs consent'))).toBe('oneDriveSync')
  })

  it('reads PlaintextSyncRefused as the unencrypted-sync consent', () => {
    const e = fromMain('PlaintextSyncRefused', 'Encrypt your notes first, or allow unencrypted sync')
    expect(plaintextRefused(e)).toBe(true)
    expect(refusedFeature(e)).toBe('plaintextSync')
  })

  it('leaves every other error alone', () => {
    expect(refusedFeature(fromMain('Error', 'Choose a repository in Sync settings'))).toBeNull()
    expect(refusedFeature('PlaintextSyncRefused')).toBeNull()
  })
})
