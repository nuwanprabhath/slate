import { contentToJSON } from './content'
import { toMarkdown } from './markdown'
import type { PageDoc } from './page'
import { toPlainText } from './plaintext'

export const PRIVATE_PLACEHOLDER = '[private box omitted]'

export interface AgentBox {
  id: string
  x: number
  y: number
  private: boolean
  /** Null for a private box: its content is never read, so it cannot leak. */
  markdown: string | null
}

/** The only way agent-facing code reads a page. Private boxes are filtered before any content is read. */
export function agentBoxes(page: PageDoc): AgentBox[] {
  return page
    .listBoxes()
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((box) => {
      if (box.private) return { id: box.id, x: box.x, y: box.y, private: true, markdown: null }
      const json = contentToJSON(page.contentMap(box.id)!)
      return { id: box.id, x: box.x, y: box.y, private: false, markdown: json ? toMarkdown([json]) : '' }
    })
}

export function agentPageMarkdown(page: PageDoc): string {
  return agentBoxes(page)
    .map((b) => (b.private ? PRIVATE_PLACEHOLDER : b.markdown))
    .filter((md) => md !== '')
    .join('\n\n---\n\n')
}

const LINE_PX = 24
const GAP_PX = 40

/**
 * Where an agent's new box goes: left edge, below the lowest box (height estimated from its
 * lines). A private box gets a fixed estimate, so nothing is read from it.
 */
export function placeBelow(page: PageDoc): { x: number; y: number } {
  let bottom = 0
  for (const box of page.listBoxes()) {
    const json = box.private ? null : contentToJSON(page.contentMap(box.id)!)
    const lines = json ? Math.max(1, toPlainText([json]).split('\n').length) : 2
    bottom = Math.max(bottom, box.y + lines * LINE_PX + 16)
  }
  return { x: GAP_PX, y: bottom + GAP_PX }
}
