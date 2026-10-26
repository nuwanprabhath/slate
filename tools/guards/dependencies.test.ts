import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { allowlist, exists, read, ROOT } from './repo'

/**
 * Supply chain, checked on every manifest: each dependency is one the maintainer approved (with a
 * reason in tools/guards/allowlists/dependencies.json), comes from the npm registry, and is pinned
 * by an integrity hash in its lockfile.
 */
interface Manifest {
  name?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

const MANIFESTS = ['package.json', 'tools/lint/package.json', ...readdirSync(join(ROOT, 'packages')).map((p) => `packages/${p}/package.json`)].filter(exists)
const LOCKFILES = ['package-lock.json', 'tools/lint/package-lock.json'].filter(exists)
const manifests = MANIFESTS.map((file) => ({ file, json: JSON.parse(read(file)) as Manifest }))
const WORKSPACES = new Set(manifests.map((m) => m.json.name).filter((n): n is string => typeof n === 'string' && n.startsWith('@slate/')))

const deps = (m: Manifest): Array<[string, string]> => [
  ...Object.entries(m.dependencies ?? {}),
  ...Object.entries(m.devDependencies ?? {}),
  ...Object.entries(m.optionalDependencies ?? {}),
  ...Object.entries(m.peerDependencies ?? {}),
]

describe('dependencies', () => {
  const approved = allowlist('dependencies')

  it('every dependency of every package.json is approved, with a reason', () => {
    const unlisted = manifests.flatMap(({ file, json }) => deps(json).filter(([name]) => !WORKSPACES.has(name) && !(name in approved)).map(([name]) => `${name} (${file})`))
    expect(
      unlisted.map((d) => `${d}: add it to tools/guards/allowlists/dependencies.json with a reason; the maintainer approves new dependencies`),
    ).toEqual([])
  })

  it('the approval list has no entry nothing depends on', () => {
    const used = new Set(manifests.flatMap(({ json }) => deps(json).map(([name]) => name)))
    expect(Object.keys(approved).filter((name) => !used.has(name))).toEqual([])
  })

  it('specifiers are registry versions: no git+, http:, file: or link: outside the workspaces', () => {
    const bad = manifests.flatMap(({ file, json }) =>
      deps(json)
        .filter(([name, spec]) => !(WORKSPACES.has(name) && spec === '*') && /^(git\+|git:|github:|https?:|file:|link:)|\//.test(spec))
        .map(([name, spec]) => `${file}: ${name}@${spec}`),
    )
    expect(bad).toEqual([])
  })

  it('every locked package comes from the npm registry with an integrity hash', () => {
    const problems: string[] = []
    for (const lockfile of LOCKFILES) {
      const lock = JSON.parse(read(lockfile)) as { packages?: Record<string, { resolved?: string; integrity?: string; link?: boolean }> }
      for (const [path, entry] of Object.entries(lock.packages ?? {})) {
        if (path === '' || entry.link || !path.includes('node_modules/')) continue
        if (!entry.resolved?.startsWith('https://registry.npmjs.org/')) problems.push(`${lockfile}: ${path} resolves to ${String(entry.resolved)}`)
        if (!entry.integrity?.startsWith('sha512-')) problems.push(`${lockfile}: ${path} has no sha512 integrity`)
      }
    }
    expect(problems).toEqual([])
  })
})
