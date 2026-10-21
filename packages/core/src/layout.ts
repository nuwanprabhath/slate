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
