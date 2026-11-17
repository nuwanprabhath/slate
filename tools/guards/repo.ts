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

/**
 * `readAt` for many paths in one `git cat-file --batch` process, mapping each path to its text at
 * `commit` or null. A ratchet that compared every test file one `git show` at a time spent 34 s of
 * its 60 s deadline on process spawns alone, so it timed out whenever the machine was busy; the whole
 * batch costs about a second.
 *
 * The batch protocol is line-based, so a path holding a newline would desynchronise it: those few go
 * through `readAt` instead.
 */
export function readAllAt(commit: string, rels: readonly string[]): Map<string, string | null> {
  const out = new Map<string, string | null>()
  const batched = rels.filter((rel) => !rel.includes('\n'))
  for (const rel of rels) if (rel.includes('\n')) out.set(rel, readAt(commit, rel))
  if (batched.length === 0) return out
  const r = spawnSync('git', ['cat-file', '--batch'], {
    cwd: ROOT,
    input: batched.map((rel) => `${commit}:${rel}\n`).join(''),
    maxBuffer: 1024 * 1024 * 1024,
  })
  const buf: Buffer = r.stdout
  let at = 0
  for (const rel of batched) {
    const end = buf.indexOf(0x0a, at)
    if (end === -1) {
      out.set(rel, null)
      continue
    }
    const header = buf.toString('utf8', at, end)
    // `<sha> <type> <size>` for an object that is there, `<request> missing` for one that is not.
    const size = /^[0-9a-f]{40,} \w+ (\d+)$/.exec(header)?.[1]
    if (size === undefined) {
      out.set(rel, null)
      at = end + 1
      continue
    }
    const from = end + 1
    const to = from + Number(size)
    out.set(rel, buf.toString('utf8', from, to))
    at = to + 1 // the newline git writes after each object
  }
  return out
}
