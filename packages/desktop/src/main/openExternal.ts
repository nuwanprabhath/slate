import { isAbsolute } from 'node:path'
import { shell } from 'electron'

/**
 * The only module that imports Electron's `shell` (lint rule `slate/open-external-safely`):
 * everything main hands to the operating system to open goes through one of these.
 */

const SAFE_SCHEMES: ReadonlySet<string> = new Set(['https:', 'mailto:'])
// The WHATWG parser drops leading C0 controls and every tab and newline; String.trim does not.
// A string that only parses after that cleanup is refused rather than guessed at.
// eslint-disable-next-line no-control-regex -- control characters are exactly what this refuses
const CONTROL = /[\u0000-\u001f\u007f]/

/** The canonical URL for an absolute `https:` URL with a host or a `mailto:` URL, else null. */
export function safeExternalUrl(url: unknown): string | null {
  if (typeof url !== 'string' || CONTROL.test(url) || url !== url.trim()) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (!SAFE_SCHEMES.has(parsed.protocol)) return null
  if (parsed.protocol === 'https:' && (parsed.hostname === '' || !url.toLowerCase().startsWith('https://'))) return null
  return parsed.href
}

/** True for a URL `openExternalSafe` would open. */
export function isSafeExternalUrl(url: unknown): url is string {
  return safeExternalUrl(url) !== null
}

/**
 * The one way main hands a URL to the system. A note's link is untrusted text: `shell.openExternal`
 * with `file:`, `smb:` or an app's own scheme can launch a program, so anything but https and mailto
 * is refused, and the system gets the canonical URL that was checked, never the raw string.
 * Resolves whether it was opened.
 */
export async function openExternalSafe(url: unknown, open: (url: string) => Promise<void> = (u) => shell.openExternal(u)): Promise<boolean> {
  const safe = safeExternalUrl(url)
  if (safe === null) return false
  await open(safe)
  return true
}

/** Shows a file Slate itself wrote (a log, a downloaded installer) in the file manager. */
export function revealInFolder(path: string): void {
  if (!isAbsolute(path)) throw new Error('revealInFolder takes an absolute path')
  shell.showItemInFolder(path)
}

/** Opens a file or folder Slate itself wrote with its default app; resolves the OS error text, '' on success. */
export function openLocalPath(path: string): Promise<string> {
  if (!isAbsolute(path)) return Promise.resolve('openLocalPath takes an absolute path')
  return shell.openPath(path)
}
