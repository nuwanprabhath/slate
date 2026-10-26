// @ts-check
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, posix, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The repository root (this file is tools/eslint-rules/paths.mjs). */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** A linted file as a repo-relative posix path. */
export function repoPath(/** @type {string} */ filename) {
  return relative(ROOT, filename).split(sep).join('/')
}

/** `**`, `*`, `?` and `{a,b}` globs, matched against repo-relative posix paths. */
export function globToRegExp(/** @type {string} */ glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?'
        i += 2
      } else {
        re += '.*'
        i += 1
      }
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else if (c === '{') re += '(?:'
    else if (c === '}') re += ')'
    else if (c === ',' && glob.lastIndexOf('{', i) > glob.lastIndexOf('}', i)) re += '|'
    else re += /[.+^$()|[\]\\]/.test(/** @type {string} */ (c)) ? `\\${c}` : c
  }
  return new RegExp(`^${re}$`)
}

/** @param {string} file @param {readonly string[] | undefined} globs */
export function matchesAny(file, globs) {
  return (globs ?? []).some((g) => globToRegExp(g).test(file))
}

/** Where a relative import from `file` lands, repo-relative; null for a package import. */
export function resolveImport(/** @type {string} */ file, /** @type {string} */ source) {
  if (!source.startsWith('.')) return null
  return posix.normalize(posix.join(posix.dirname(file), source))
}

/**
 * A reasoned allowlist: `tools/guards/allowlists/<name>.json`, an object of repo-relative file →
 * reason. Keys starting with `$` are comments. Read by the lint rules and by the guard tests, which
 * also refuse an entry added since the branch left main (tools/guards/ratchet.test.ts).
 * @returns {Record<string, string>}
 */
export function allowlist(/** @type {string} */ name) {
  const raw = JSON.parse(readFileSync(join(ROOT, 'tools/guards/allowlists', `${name}.json`), 'utf8'))
  return Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith('$')))
}

/** Every allowlist file name, without `.json`. */
export function allowlistNames() {
  return readdirSync(join(ROOT, 'tools/guards/allowlists')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))
}
