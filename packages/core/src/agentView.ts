import { contentToJSON } from './content'
import { toMarkdown } from './markdown'
import type { PageDoc } from './page'

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
