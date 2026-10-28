export interface BoxRect {
  id: string
  x: number
  y: number
  width: number
  height: number
}

function overlapsX(a: BoxRect, b: BoxRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width
}

/**
 * When box `grownId` grows from `oldHeight` to `newHeight`, every box that sits at or below
 * its old bottom edge and overlaps it horizontally moves down by the growth delta. Pushed
 * boxes push the boxes under them in turn. Shrinking never pulls boxes up.
 * Returns the new y for every moved box.
 */
export function computePush(boxes: BoxRect[], grownId: string, oldHeight: number, newHeight: number): Map<string, number> {
  const moved = new Map<string, number>()
  const delta = newHeight - oldHeight
  const grown = boxes.find((b) => b.id === grownId)
  if (delta <= 0 || !grown) return moved

  const queue: Array<{ rect: BoxRect; bottom: number }> = [{ rect: grown, bottom: grown.y + oldHeight }]
  while (queue.length > 0) {
    const pusher = queue.shift()!
    for (const b of boxes) {
      if (b.id === grownId || moved.has(b.id)) continue
      if (b.y >= pusher.bottom && overlapsX(pusher.rect, b)) {
        moved.set(b.id, b.y + delta)
        queue.push({ rect: b, bottom: b.y + b.height })
      }
    }
  }
  return moved
}

/**
 * Imported pages keep the source app's coordinates, but Slate renders text taller, so a box can
 * run into the one below it. Walks the boxes top to bottom and moves a box down until it clears
 * every earlier box that overlaps it horizontally, leaving `gap` between them. Earlier boxes count
 * at their moved position, so moves cascade down a column. Boxes only ever move down.
 * Returns the new y for every box that moved.
 */
export function settleOverlaps(boxes: BoxRect[], gap = 12): Map<string, number> {
  const moved = new Map<string, number>()
  const placed: BoxRect[] = []
  for (const box of [...boxes].sort((a, b) => a.y - b.y || a.x - b.x)) {
    let y = box.y
    for (const above of placed) {
      if (overlapsX(above, box) && above.y + above.height > box.y - gap) y = Math.max(y, above.y + above.height + gap)
    }
    if (y !== box.y) moved.set(box.id, y)
    placed.push({ ...box, y })
  }
  return moved
}

function overlaps(a: BoxRect, b: BoxRect): boolean {
  return overlapsX(a, b) && a.y < b.y + b.height && b.y < a.y + a.height
}

/** Whether any two boxes overlap (touching edges do not count). */
export function hasOverlaps(boxes: BoxRect[]): boolean {
  return boxes.some((a, i) => boxes.some((b, j) => i < j && overlaps(a, b)))
}

/**
 * "Re-arrange boxes": moves boxes so none overlap, changing the layout as little as possible.
 * Boxes are placed in (y, x) order; each keeps its x and moves down only as far as it needs to
 * clear every box already placed, leaving `gap`. Unlike `settleOverlaps`, a box that overlaps
 * nothing stays put even when it sits closer than `gap` to another. Returns the new y of every
 * box that moved.
 */
export function arrangeBoxes(boxes: BoxRect[], gap = 16): Map<string, number> {
  const moved = new Map<string, number>()
  const placed: BoxRect[] = []
  for (const box of [...boxes].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const at = { ...box }
    // Moving below one box can land on another placed box; repeat until clear. Each pass moves down, so it ends.
    for (let hit = placed.find((p) => overlaps(p, at)); hit; hit = placed.find((p) => overlaps(p, at))) at.y = hit.y + hit.height + gap
    if (at.y !== box.y) moved.set(box.id, at.y)
    placed.push(at)
  }
  return moved
}
