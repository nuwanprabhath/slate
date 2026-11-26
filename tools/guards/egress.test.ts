import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { egressEntries, findSinks, gatedFeatures, LITERALS, type EgressEntry } from './egressScan'
import { baseCommit, exists, isTestFile, read, readAt, ROOT, walk } from './repo'

/**
 * Privacy by default (GDPR Art. 25): nothing shipped reaches the network unless the person chose it.
 * Every file that holds a network sink (egressScan.ts lists them) has an entry in
 * tools/guards/allowlists/egress.json naming its consent: a ConsentFeature, whose gate the file calls
 * in source, or 'user-action' (one request per click), or 'neutralised' (cannot reach a remote host).
 * A new sink file fails until the flow is gated, disclosed and listed by the maintainer. The list only
 * shrinks (ratchet.test.ts), and an entry's feature never loosens (below).
 */

const PRIVACY = 'docs/architecture/golden-paths.md#privacy and PRIVACY.md'

const isLiteral = (f: string): boolean => (LITERALS as readonly string[]).includes(f)

/** Shipped source: every package's src, tests excluded. */
export function shippedSources(): string[] {
  return readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
    .filter((d) => d.isDirectory() && exists(`packages/${d.name}/src`))
    .flatMap((d) => walk(`packages/${d.name}/src`, ['.ts', '.tsx']))
    .filter((f) => !isTestFile(f))
}

/** The problems with one sink file against its entry; [] when it is listed and gated. */
export function checkSinkFile(file: string, sinks: readonly { kind: string; line: number }[], entry: EgressEntry | undefined, readFile: (rel: string) => string | null): string[] {
  const where = sinks.map((s) => `${s.kind} (line ${String(s.line)})`).join(', ')
  if (!entry) {
    return [
      `${file}: ${where} reaches the network with no entry in tools/guards/allowlists/egress.json. ` +
        `Gate it behind a ConsentFeature (add one to CONSENT_FEATURES with a DISCLOSURES entry, and call requireConsent('<feature>') or allowed('<feature>') at the call), add its row to PRIVACY.md, and ask the maintainer to list the file; see ${PRIVACY}.`,
    ]
  }
  if (isLiteral(entry.feature)) return entry.gatedIn === undefined ? [] : [`${file}: gatedIn only goes with a ConsentFeature, not '${entry.feature}'`]
  const desktop = file.startsWith('packages/desktop/')
  if (entry.gatedIn !== undefined && desktop) return [`${file}: a desktop file gates itself; drop gatedIn and call requireConsent('${entry.feature}') or allowed('${entry.feature}') in this file`]
  if (entry.gatedIn !== undefined && !entry.gatedIn.startsWith('packages/desktop/src/main/')) return [`${file}: gatedIn must name a packages/desktop/src/main file (where the gate can be imported), not ${entry.gatedIn}`]
  if (!desktop && entry.gatedIn === undefined) {
    return [`${file}: this package cannot import the privacy gate; name the packages/desktop/src/main file that calls requireConsent('${entry.feature}') for this flow as gatedIn (the maintainer edits egress.json)`]
  }
  const gateFile = entry.gatedIn ?? file
  const text = readFile(gateFile)
  if (text === null) return [`${file}: gatedIn names ${gateFile}, which does not exist`]
  if (gatedFeatures(gateFile, text).has(entry.feature)) return []
  return [
    `${gateFile} must gate '${entry.feature}' (${where}${entry.gatedIn ? ` in ${file}` : ''}): call requireConsent('${entry.feature}') or allowed('${entry.feature}') from main/privacy/gate.ts, ` +
      `or egressAllowed(settings, '${entry.feature}') from shared/privacy/consent.ts, before the request; see ${PRIVACY}.`,
  ]
}

/** An entry whose feature loosened since the base: a ConsentFeature became a literal, or one literal another. */
export function loosened(before: Record<string, EgressEntry>, after: Record<string, EgressEntry>): string[] {
  return Object.entries(after).flatMap(([file, e]) => {
    const was = before[file]
    if (!was || was.feature === e.feature) return []
    if (isLiteral(was.feature) && !isLiteral(e.feature)) return [] // tightened: a click became a consent
    return [`${file}: '${was.feature}' → '${e.feature}'`]
  })
}

describe('egress scanner (fixtures)', () => {
  const kinds = (code: string, file = 'packages/desktop/src/main/x.ts') => findSinks(file, code).map((s) => s.kind)

  it('finds each flow of the GDPR review §1.1, in the shape of the real code', () => {
    // N-1, N-3: electron-updater.
    expect(kinds("declare const updater: () => import('electron-updater').AppUpdater\nexport async function c() { await updater().checkForUpdates(); await updater().downloadUpdate() }")).toEqual([
      'autoUpdater.checkForUpdates',
      'autoUpdater.downloadUpdate',
    ])
    expect(kinds("import { autoUpdater } from 'electron-updater'\nvoid autoUpdater.checkForUpdatesAndNotify()")).toEqual(['autoUpdater.checkForUpdatesAndNotify'])
    // N-2, N-3: Electron's net, by any name.
    expect(kinds("import { net } from 'electron'\nexport const r = net.fetch('https://github.com/x.sig')")).toEqual(['net.fetch'])
    expect(kinds("import { net as n } from 'electron'\nexport const r = n.request('https://x')")).toEqual(['net.request'])
    expect(kinds("import * as electron from 'electron'\nexport const r = electron.net.fetch('https://x')")).toEqual(['net.fetch'])
    expect(kinds("import { net } from 'electron'\nconst m = net\nexport const r = m.fetch('https://x')")).toEqual(['net.fetch'])
    // N-5, N-12: the git transport.
    expect(kinds("import { nodeGitRunner, type GitRunner } from '@slate/sync'\nexport const run: GitRunner = nodeGitRunner('git', {})")).toEqual(['git transport (nodeGitRunner)'])
    expect(kinds("import { nodeGitRunner as make } from '../gitRunner'\nexport const f = { make }")).toEqual(['git transport (nodeGitRunner)'])
    // N-6, N-8: the global fetch as a fallback.
    expect(kinds('export const f = (o: { fetch?: typeof fetch }) => o.fetch ?? ((input: string) => fetch(input))', 'packages/sync/src/oneDrive.ts')).toEqual(['fetch'])
    // N-7: MSAL.
    expect(kinds("import { PublicClientApplication } from '@azure/msal-node'\nexport const p = new PublicClientApplication({ auth: { clientId: 'x' } })")).toEqual(['new PublicClientApplication'])
    expect(kinds("import * as msal from '@azure/msal-node'\nexport const p = new msal.ConfidentialClientApplication({ auth: { clientId: 'x' } })")).toEqual(['new ConfidentialClientApplication'])
    // N-9, N-10: fetch passed on as a value, never called by that name.
    expect(kinds('export function f(deps: { fetch?: typeof fetch }) { const doFetch = deps.fetch ?? fetch; return doFetch }')).toEqual(['fetch'])
    expect(kinds('export async function g(token: string, doFetch: typeof fetch = fetch) { return doFetch(token) }')).toEqual(['fetch'])
    expect(kinds('export const deps = { fetch }')).toEqual(['fetch'])
    expect(kinds("export const r = globalThis.fetch('https://x')")).toEqual(['fetch'])
    // N-11: a TLS handshake, as a default, namespace, named or required import.
    expect(kinds("import tls from 'node:tls'\nexport const s = tls.connect({ host: 'graph.microsoft.com', port: 443 })")).toEqual(['tls.connect'])
    expect(kinds("import { connect } from 'tls'\nexport const s = connect(443, 'x')")).toEqual(['tls.connect'])
    expect(kinds("const https = require('node:https')\nexport const r = https.get('https://x')")).toEqual(['https.get'])
    expect(kinds("import * as http from 'http'\nexport const r = http.request('http://x')")).toEqual(['http.request'])
    expect(kinds("import { request as rq } from 'node:https'\nexport const r = rq('https://x')")).toEqual(['https.request'])
    expect(kinds("import { createConnection } from 'node:net'\nexport const s = createConnection(443, 'x')")).toEqual(['net.createConnection'])
    expect(kinds("export async function f() { const { connect } = await import('node:http2'); return connect('https://x') }")).toEqual(['http2.connect'])
    // N-13 (and N-4): the system browser.
    expect(kinds("import { shell } from 'electron'\nexport const o = (u: string) => shell.openExternal(u)")).toEqual(['shell.openExternal'])
    // N-14: Chromium's dictionary download.
    expect(kinds("import type { Session } from 'electron'\nexport const f = (s: Session) => s.setSpellCheckerDictionaryDownloadURL('http://127.0.0.1:9/')")).toEqual(['spellcheck dictionary download'])
    // P-1, P-2: spawning claude, directly or through the login shell.
    expect(kinds("import { spawn } from 'node:child_process'\ndeclare const found: string | null\nexport const c = spawn(found ?? 'claude', ['-p'])")).toEqual(['spawns claude'])
    expect(kinds("import { execFile } from 'node:child_process'\nexecFile('/bin/zsh', ['-l', '-c', 'command -v claude'])")).toEqual(['spawns claude'])
    expect(kinds("import { spawnProgram } from './proc'\nvoid spawnProgram('claude', [])")).toEqual(['spawns claude'])
    // Sockets from the web platform.
    expect(kinds("export const w = new WebSocket('wss://x')")).toEqual(['new WebSocket'])
  })

  it('does not take look-alikes for sinks', () => {
    // updateService.ts and remoteVault.ts: methods that happen to be called fetch.
    expect(kinds('export class U { private async fetch(): Promise<void> {} async run() { await this.fetch() } }')).toEqual([])
    // Types and property names only.
    expect(kinds('export interface O { fetch?: typeof fetch; doFetch: typeof fetch }\nexport type F = Parameters<typeof fetch>')).toEqual([])
    // A local connect (proxy.ts takes one as a parameter), and node:net's server side.
    expect(kinds("export async function f(opts: { connect: () => Promise<void> }) { const { connect } = opts; await connect() }")).toEqual([])
    expect(kinds("import net from 'node:net'\nexport const s = net.createServer()")).toEqual([])
    // The word claude in a file that starts no process; a get on a Map.
    expect(kinds("export const label = 'claude'")).toEqual([])
    expect(kinds("export const m = new Map<string, string>()\nexport const v = m.get('https')")).toEqual([])
    // gitRunner.ts defines nodeGitRunner; defining it is not using it.
    expect(kinds("export function nodeGitRunner(gitPath = 'git') { return gitPath }", 'packages/sync/src/gitRunner.ts')).toEqual([])
  })

  it('reports the line of each sink', () => {
    expect(findSinks('packages/desktop/src/main/x.ts', "import tls from 'node:tls'\n\nexport const s = tls.connect(443)")).toEqual([{ kind: 'tls.connect', line: 3 }])
  })
})

describe('gate references (fixtures)', () => {
  const gated = (code: string) => [...gatedFeatures('packages/desktop/src/main/x.ts', code)].sort()

  it('sees each gate, imported from privacy/gate or privacy/consent, or injected', () => {
    expect(gated("import { requireConsent } from '../privacy/gate'\nrequireConsent('microsoftSignIn')")).toEqual(['microsoftSignIn'])
    expect(gated("import { allowed } from './privacy/gate'\nexport const ok = allowed('claudeTheme')")).toEqual(['claudeTheme'])
    expect(gated("import { egressAllowed } from '../../shared/privacy/consent'\ndeclare const s: never\nexport const ok = egressAllowed(s, 'updates')")).toEqual(['updates'])
    expect(gated("import { allowed as may } from '../privacy/gate'\nexport const ok = may('updates')")).toEqual(['updates'])
    expect(gated("import { requireConsent } from '../privacy/gate'\ndeclare const git: boolean\nrequireConsent(git ? 'gitSync' : 'oneDriveSync')")).toEqual(['gitSync', 'oneDriveSync'])
    expect(gated("declare const deps: { allowed(f: string): boolean }\nexport const ok = deps.allowed('updates')")).toEqual(['updates'])
  })

  it('ignores a local function that only shares a name, and a feature named outside a gate', () => {
    expect(gated("const allowed = (f: string) => f.length > 0\nexport const ok = allowed('updates')")).toEqual([])
    expect(gated("import { allowed } from './settings'\nexport const ok = allowed('updates')")).toEqual([])
    expect(gated("export const feature = 'updates'")).toEqual([])
  })
})

describe('egress allowlist checks (fixtures)', () => {
  const sink = [{ kind: 'fetch', line: 1 }]
  const gate = "import { requireConsent } from '../privacy/gate'\nrequireConsent('gitSync')"
  const files: Record<string, string> = { 'packages/desktop/src/main/a.ts': gate, 'packages/desktop/src/main/b.ts': 'export {}' }
  const readFile = (rel: string) => files[rel] ?? null

  it('passes a listed, gated file, a literal, and a library gated where it is wired', () => {
    expect(checkSinkFile('packages/desktop/src/main/a.ts', sink, { feature: 'gitSync', reason: 'r' }, readFile)).toEqual([])
    expect(checkSinkFile('packages/desktop/src/main/b.ts', sink, { feature: 'user-action', reason: 'r' }, readFile)).toEqual([])
    expect(checkSinkFile('packages/sync/src/x.ts', sink, { feature: 'gitSync', reason: 'r', gatedIn: 'packages/desktop/src/main/a.ts' }, readFile)).toEqual([])
  })

  it('fails an unlisted sink file, pointing at golden-paths "Privacy" and PRIVACY.md', () => {
    const [msg] = checkSinkFile('packages/desktop/src/main/b.ts', sink, undefined, readFile)
    expect(msg).toContain('no entry in tools/guards/allowlists/egress.json')
    expect(msg).toContain('docs/architecture/golden-paths.md#privacy')
    expect(msg).toContain('PRIVACY.md')
  })

  it('fails a consent feature whose gate is missing, wrong, or claimed for a desktop file elsewhere', () => {
    expect(checkSinkFile('packages/desktop/src/main/b.ts', sink, { feature: 'gitSync', reason: 'r' }, readFile)[0]).toContain("must gate 'gitSync'")
    expect(checkSinkFile('packages/desktop/src/main/a.ts', sink, { feature: 'updates', reason: 'r' }, readFile)[0]).toContain("must gate 'updates'")
    expect(checkSinkFile('packages/desktop/src/main/b.ts', sink, { feature: 'gitSync', reason: 'r', gatedIn: 'packages/desktop/src/main/a.ts' }, readFile)[0]).toContain('a desktop file gates itself')
    expect(checkSinkFile('packages/sync/src/x.ts', sink, { feature: 'gitSync', reason: 'r' }, readFile)[0]).toContain('cannot import the privacy gate')
    expect(checkSinkFile('packages/sync/src/x.ts', sink, { feature: 'gitSync', reason: 'r', gatedIn: 'packages/sync/src/y.ts' }, readFile)[0]).toContain('must name a packages/desktop/src/main file')
    expect(checkSinkFile('packages/sync/src/x.ts', sink, { feature: 'gitSync', reason: 'r', gatedIn: 'packages/desktop/src/main/gone.ts' }, readFile)[0]).toContain('does not exist')
  })

  it('refuses a loosened feature, and lets one tighten', () => {
    const e = (feature: string): EgressEntry => ({ feature, reason: 'r' })
    expect(loosened({ a: e('updates') }, { a: e('user-action') })).toEqual(["a: 'updates' → 'user-action'"])
    expect(loosened({ a: e('updates') }, { a: e('gitSync') })).toEqual(["a: 'updates' → 'gitSync'"])
    expect(loosened({ a: e('user-action') }, { a: e('neutralised') })).toEqual(["a: 'user-action' → 'neutralised'"])
    expect(loosened({ a: e('user-action') }, { a: e('updates') })).toEqual([])
    expect(loosened({}, { a: e('neutralised') })).toEqual([])
  })
})

describe('egress: every network sink is gated (the repo)', () => {
  const entries = egressEntries()
  const found = new Map(shippedSources().map((f) => [f, findSinks(f, read(f))] as const).filter(([, s]) => s.length > 0))
  const readFile = (rel: string) => (exists(rel) ? read(rel) : null)

  it('every sink file is listed in egress.json, and a consent feature is gated in source', () => {
    const problems = [...found].flatMap(([file, sinks]) => checkSinkFile(file, sinks, entries[file], readFile))
    expect(problems).toEqual([])
  })

  it('egress.json has no entry for a file without a sink (delete the line: the list only shrinks)', () => {
    expect(Object.keys(entries).filter((f) => !found.has(f)).map((f) => `${f}: ${exists(f) ? 'no longer reaches the network' : 'no longer exists'}; delete its egress.json entry`)).toEqual([])
  })

  const base = baseCommit()
  // Outside a checkout with history (a source tarball) there is no base to compare with.
  it.skipIf(base === null)('no entry loosened its feature since the base (only the maintainer does that)', () => {
    const was = readAt(base!, 'tools/guards/allowlists/egress.json')
    const changes = was === null ? [] : loosened(egressEntries(was), entries)
    expect(changes.map((c) => `${c}: an entry's consent never loosens on an agent branch; gate the flow instead, see ${PRIVACY}`)).toEqual([])
  })
})
