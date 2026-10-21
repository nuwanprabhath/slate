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
