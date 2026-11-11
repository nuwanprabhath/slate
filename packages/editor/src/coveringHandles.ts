/** A box as the overlap pass needs it: its rectangle, plus the height it was dragged to, if any. */
export interface OverlapBox {
  id: string
  x: number
  y: number
  width: number
  height?: number
}

/**
 * The boxes whose handle bar lies over another box, so it must be drawn even when unhovered.
 *
 * A sweep, not a pairwise compare: this runs on every structural change, including each auto-push
 * move while typing, so it must not cost O(n^2) on a page with many boxes. Boxes are taken in `y`
 * order and each one is tested only against the boxes still reaching down into its handle's band.
 */
export function coveringHandles(boxes: readonly OverlapBox[], handleHeight: number, measuredHeight: (id: string) => number | undefined): Set<string> {
  const out = new Set<string>()
  const order = [...boxes].sort((a, b) => a.y - b.y)
  const bottoms = new Map<string, number>(order.map((b) => [b.id, b.y + Math.max(measuredHeight(b.id) ?? 0, b.height ?? 0)]))
  // Boxes above the current row that still reach into its handle band; pruned as the sweep descends.
  let active: OverlapBox[] = []
  for (let i = 0; i < order.length; ) {
    const y = order[i]!.y
    let j = i
    while (j < order.length && order[j]!.y === y) j++
    const top = y - handleHeight
    active = active.filter((o) => bottoms.get(o.id)! > top)
    for (let k = i; k < j; k++) {
      const b = order[k]!
      for (const o of active) {
        if (b.x < o.x + o.width && o.x < b.x + b.width) {
          out.add(b.id)
          break
        }
      }
    }
    for (let k = i; k < j; k++) active.push(order[k]!)
    i = j
  }
  return out
}
