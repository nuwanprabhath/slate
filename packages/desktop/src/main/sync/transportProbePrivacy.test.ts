import { describe, expect, it } from 'vitest'
import { DISCLOSURES, type ConsentFeature, type Consents } from '../../shared/privacy/consent'
import { probeTransports, type ProbeInput } from './transportProbe'

const grants = (...features: ConsentFeature[]): Consents =>
  Object.fromEntries(features.map((f) => [f, { grantedAt: 1, textVersion: DISCLOSURES[f].textVersion, source: 'user' }]))

function probe(settings: ProbeInput['settings']) {
  const contacted: string[] = []
  const input: ProbeInput = {
    state: 'plaintext',
    settings,
    graphUrl: 'https://graph.microsoft.com/v1.0',
    git: async (url) => (contacted.push(url), { ok: true, message: 'Connected.', remote: 'git-https:github.com', kex: 'X25519MLKEM768' }),
    ssh: async () => ({ hybrid: [], ssh: null, prepend: false }),
    tls: async (host) => (contacted.push(host), 'X25519MLKEM768'),
    record: () => {},
    now: () => 1,
  }
  return { run: () => probeTransports(input), contacted }
}

const GIT = { remoteUrl: 'https://github.com/me/notes.git', branch: 'main', auth: 'system' } as const

/** GDPR-03: the transport probe is a connection to the provider too, so it waits for the same consent. */
describe('the transport probe under strict mode', () => {
  it('contacts no OneDrive host without the oneDriveSync consent', async () => {
    const p = probe({ syncProvider: 'onedrive', syncRequirePq: false, gdprStrictMode: true, consents: grants('gitSync') })
    expect(await p.run()).toEqual([])
    expect(p.contacted).toEqual([])
  })

  it('runs no git ls-remote without the gitSync consent', async () => {
    const p = probe({ syncProvider: 'git', git: GIT, syncRequirePq: false, gdprStrictMode: true, consents: grants('oneDriveSync') })
    expect(await p.run()).toEqual([])
    expect(p.contacted).toEqual([])
  })

  it('probes once the provider is consented', async () => {
    const one = probe({ syncProvider: 'onedrive', syncRequirePq: false, gdprStrictMode: true, consents: grants('oneDriveSync') })
    expect((await one.run()).length).toBeGreaterThan(0)
    const git = probe({ syncProvider: 'git', git: GIT, syncRequirePq: false, gdprStrictMode: true, consents: grants('gitSync') })
    expect(await git.run()).toHaveLength(1)
    expect(git.contacted).toEqual([GIT.remoteUrl])
  })
})
