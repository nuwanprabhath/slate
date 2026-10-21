export const REPO = 'nuwanprabhath/slate'

type Parsed = [number, number, number]

export function parseVersion(v: string): Parsed | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** True when `candidate` is a later release than `current`; a prerelease ranks below its release. */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate)
  const b = parseVersion(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!
  const pre = (v: string) => v.includes('-')
  return pre(current) && !pre(candidate)
}

export function releaseUrl(version: string): string {
  return `https://github.com/${REPO}/releases/tag/v${version}`
}

export function assetUrl(version: string, name: string): string {
  return `https://github.com/${REPO}/releases/download/v${version}/${name}`
}
