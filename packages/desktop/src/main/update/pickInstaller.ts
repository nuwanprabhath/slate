import type { InstallKind } from '../../shared/api'

/** One entry of `files` in latest-mac.yml / latest-linux.yml. */
export interface UpdateFile {
  url: string
  sha512: string
  size: number
}

const ARCH_NAMES: Record<string, string[]> = {
  arm64: ['arm64', 'aarch64'],
  x64: ['x64', 'amd64', 'x86_64'],
}

const isSep = (c: string | undefined) => c === '-' || c === '_' || c === '.'

/** `name` in `url` with a `-`, `_` or `.` on each side; plain string search, so no name can make it throw. */
function hasBracketed(url: string, name: string): boolean {
  // Bounded by position, not by indexOf's -1: indexOf('') never returns -1.
  for (let i = 1; i + name.length < url.length; i++) {
    if (isSep(url[i - 1]) && isSep(url[i + name.length]) && url.startsWith(name, i)) return true
  }
  return false
}

/** The installer the assisted path downloads: the dmg or .deb built for this machine's arch. */
export function pickInstaller(files: UpdateFile[], kind: InstallKind, arch: string): UpdateFile | null {
  if (kind !== 'dmg' && kind !== 'deb') return null
  const ofKind = files.filter((f) => f.url.toLowerCase().endsWith(`.${kind}`))
  const mine = ARCH_NAMES[arch] ?? [arch]
  const others = Object.entries(ARCH_NAMES).flatMap(([a, names]) => (a === arch ? [] : names))
  const has = (f: UpdateFile, names: string[]) => names.some((n) => hasBracketed(f.url, n))
  return ofKind.find((f) => has(f, mine)) ?? ofKind.find((f) => !has(f, others)) ?? null
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** What the banner's "Copy install command" copies, run in a terminal after quitting Slate. */
export function installCommand(kind: InstallKind, file: string): string | null {
  if (kind === 'deb') return `sudo apt install ${quote(file)}`
  if (kind === 'dmg') {
    return [
      `hdiutil attach -nobrowse -mountpoint /tmp/slate-update ${quote(file)}`,
      'rm -rf /Applications/Slate.app',
      'ditto /tmp/slate-update/Slate.app /Applications/Slate.app',
      'hdiutil detach /tmp/slate-update',
      'xattr -cr /Applications/Slate.app',
    ].join(' && ')
  }
  return null
}
