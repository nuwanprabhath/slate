import type { FindMatch } from '@slate/editor'

/**
 * The match Replace should change: the current one, as `(box, index in box)`, if the page's matches
 * are what the bar shows. They refresh after a short quiet spell, so right after an edit the bar can
 * be stale; then this is null and the bar shows the fresh matches instead of replacing a different one.
 */
export function currentToReplace(shown: FindMatch[], index: number, fresh: FindMatch[]): { boxId: string; occurrence: number } | null {
  const current = shown[index]
  if (!current || fresh.length !== shown.length || fresh.some((f, i) => f.boxId !== shown[i]!.boxId || f.from !== shown[i]!.from || f.to !== shown[i]!.to)) return null
  return { boxId: current.boxId, occurrence: shown.slice(0, index).filter((s) => s.boxId === current.boxId).length }
}
