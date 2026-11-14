import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fcParams, fcRuns, relativeCost } from '../../desktop/test/fuzz'
import { parseCurlTls, parseSshKex, remoteTransport } from '../src/transport'

// The shape DocStore.recordTransport accepts (store.ts REMOTE); duplicated so this package needs no desktop import.
const RECORDABLE = /^[a-z][a-z0-9-]*:[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:\d{1,5})?$/

const SSH_TRACE = 'OpenSSH_9.9p1, LibreSSL 3.3.6\ndebug1: Connecting to github.com port 22.\ndebug1: kex: algorithm: mlkem768x25519-sha256\ndebug1: kex: host key algorithm: ssh-ed25519\n'
const CURL_TRACE = '== Info: Trying 140.82.121.4:443...\n== Info: SSL connection using TLSv1.3 / TLS_AES_128_GCM_SHA256 / X25519MLKEM768 / id_ecdsa\n=> Send header: Authorization: Basic dXNlcjp0b2tlbg==\n'

/** Text that looks like either trace and then goes wrong: repeated prefixes, long runs, no terminators. */
const traceText = fc.oneof(
  fc.string({ maxLength: 400 }),
  fc
    .array(fc.constantFrom('debug1: kex: algorithm: ', 'SSL connection using TLSv', '1.3 / ', ' / ', '/', 'a', '-', '.', ' ', '\t', '\r', '\n', 'X25519', '\u0000', 'UNDEF'), { maxLength: 200 })
    .map((p) => p.join(''))
)

const secret = fc.constantFrom('alice', 'tok3n', 'ghp_SECRETvalue', 'p%40ss')
const path = fc.constantFrom('/owner/repo.git', 'owner/repo', '/~u/r', '/a?b=c', '/x#frag', '')
const host = fc.constantFrom('github.com', 'GitLab.Example.com', 'git.example.com', '127.0.0.1', 'h')
const port = fc.constantFrom('', ':22', ':443', ':8443', ':0')
/** Addresses carrying a user, a password, a path and a query, in URL and scp spellings. */
const remoteWithCredentials = fc.oneof(
  fc.tuple(fc.constantFrom('https://', 'ssh://', 'git+ssh://', 'http://', 'ssh+git://'), secret, secret, host, port, path, fc.constantFrom('', '?token=QQQsecret')).map(
    ([s, u, p, h, po, pa, q]) => ({ url: `${s}${u}:${p}@${h}${po}${pa}${q}`, secrets: [u, p] })
  ),
  fc.tuple(secret, host, path).map(([u, h, pa]) => ({ url: `${u}@${h}:${pa.replace(/^\//, '') || 'r'}`, secrets: [u] }))
)

describe('transport parsing (F4b properties 5 and 6)', () => {
  it('T-F4B-04: remoteTransport gives null or a host-level id with no user, password, path or query', () => {
    fc.assert(
      fc.property(remoteWithCredentials, ({ url, secrets }) => {
        const t = remoteTransport(url)
        if (t === null) return
        expect(t.remote).toMatch(RECORDABLE)
        for (const s of secrets) expect(t.remote.toLowerCase()).not.toContain(s.toLowerCase())
        expect(t.remote).not.toContain('/')
        expect(t.remote).not.toContain('?')
        expect(t.remote).not.toContain('@')
      }),
      fcParams
    )
  })

  it('T-F4B-05: remoteTransport never throws and its id is always recordable, on arbitrary text', () => {
    fc.assert(
      fc.property(traceText, (text) => {
        const t = remoteTransport(text)
        if (t !== null) expect(t.remote).toMatch(RECORDABLE)
        else expect(t).toBeNull()
      }),
      fcParams
    )
  })

  it('T-F4B-06: parseSshKex and parseCurlTls never throw and return a bare token', () => {
    fc.assert(
      fc.property(traceText, (text) => {
        const kex = parseSshKex(text)
        const tls = parseCurlTls(text)
        if (kex !== null) expect(kex).toMatch(/^[A-Za-z0-9@._-]+$/)
        if (tls !== null) expect(tls).toMatch(/^[A-Za-z0-9_-]+$/)
        expect(tls).not.toBe('UNDEF')
      }),
      fcParams
    )
  })

  it('T-F4B-07: hostile trace text costs about what a real trace of the same length costs', () => {
    // The real trace with its answer lines last, so the benign parse scans the whole text as a miss does.
    const real = (SSH_TRACE + CURL_TRACE).replace(/^.*(kex: algorithm|SSL connection).*\n/gm, '').repeat(60) + SSH_TRACE + CURL_TRACE
    // Mean ratio only: super-linear parsing shows in the mean, while this p99 measured whether another process
    // had the CPU (it read 366 under six concurrent suites, FX-26). The kit's default p99 stays for other callers.
    const cost = relativeCost(
      () => {
        parseSshKex(real)
        parseCurlTls(real)
      },
      { p99OverBenign: Number.POSITIVE_INFINITY }
    )
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('debug1: kex: algorithm: ', 'SSL connection using TLSv1.3 / ', 'a / ', 'x', ' ', '\t'), { minLength: 1, maxLength: 60 }),
        (unit) => {
          const piece = unit.join('')
          const hostile = piece.repeat(Math.ceil(real.length / piece.length)).slice(0, real.length)
          cost.time(() => {
            parseSshKex(hostile)
            parseCurlTls(hostile)
          })
        }
      ),
      fcRuns(10, 200)
    )
    cost.check()
  })
})
