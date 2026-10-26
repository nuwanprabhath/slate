import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Shared plumbing for the guard tests (`npm run guards`). Each test reads the repo as text and
 * fails with a message that names the fix: the accepted path, the file to edit, or the person who
 * must approve.
 */
export const ROOT = resolve(__dirname, '../..')

export function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
}

export function exists(rel: string): boolean {
  return existsSync(join(ROOT, rel))
}

/** Files under `dir` (repo-relative) whose names end in one of `exts`, as repo-relative posix paths. */
export function walk(dir: string, exts: readonly string[], skip: (rel: string) => boolean = () => false): string[] {
  const out: string[] = []
  const visit = (rel: string): void => {
    for (const d of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
      const child = `${rel}/${d.name}`
      if (d.name === 'node_modules' || skip(child)) continue
      if (d.isDirectory()) visit(child)
      else if (exts.some((e) => d.name.endsWith(e))) out.push(child)
    }
  }
  visit(dir)
  return out.sort()
}

export const isTestFile = (rel: string): boolean => /\.(test|spec)\.tsx?$/.test(rel) || rel.endsWith('/testSetup.ts')

/** A reasoned allowlist from tools/guards/allowlists: name → reason, `$` keys dropped. */
export function allowlist(name: string, text: string = read(`tools/guards/allowlists/${name}.json`)): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(allowlistEntries(name, text))) out[key] = entry.reason
  return out
}

/**
 * The entries with their optional `names` (crypto-imports.json lists the imports each file may use).
 * An entry is a reason string, or `{ names, reason }`.
 */
export function allowlistEntries(name: string, text: string = read(`tools/guards/allowlists/${name}.json`)): Record<string, { reason: string; names: string[] }> {
  const raw = JSON.parse(text) as Record<string, unknown>
  const out: Record<string, { reason: string; names: string[] }> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith('$')) continue
    const entry = typeof value === 'string' ? { reason: value, names: [] } : (value as { reason?: unknown; names?: unknown })
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < 10) throw new Error(`tools/guards/allowlists/${name}.json: "${key}" needs a reason (a sentence saying why)`)
    const names = Array.isArray(entry.names) ? entry.names.filter((n): n is string => typeof n === 'string') : []
    out[key] = { reason: entry.reason, names }
  }
  return out
}

export function git(args: readonly string[]): string {
  return spawnSync('git', [...args], { cwd: ROOT, encoding: 'utf8' }).stdout ?? ''
}

/** Where this branch left `SLATE_BASE_REF` (default main), or null outside a git checkout. */
export function baseCommit(): string | null {
  const base = git(['merge-base', 'HEAD', process.env.SLATE_BASE_REF || 'main']).trim()
  return base === '' ? null : base
}

/** A file's text at `commit`, or null when it did not exist there. */
export function readAt(commit: string, rel: string): string | null {
  const r = spawnSync('git', ['show', `${commit}:${rel}`], { cwd: ROOT, encoding: 'utf8' })
  return r.status === 0 ? r.stdout : null
}
