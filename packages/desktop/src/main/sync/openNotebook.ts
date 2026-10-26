import { NotebookDoc, PageDoc } from '@slate/core'
import type { DocStore } from '../store'

export interface NotebookFacts {
  id: string
  /** Device id → when that device last opened the notebook. */
  openOn: Record<string, number>
  modifiedAt: number
  /** No page in it has a box. */
  empty: boolean
}

export interface PickInput {
  notebooks: NotebookFacts[]
  deviceId: string
  /** The notebook shown here, or null when nothing has been opened yet. */
  current: string | null
  /** The user picked a notebook while the sync ran: theirs to keep. */
  userChose: boolean
}

const latest = (openOn: Record<string, number>, skip?: string) =>
  Math.max(0, ...Object.entries(openOn).filter(([device]) => device !== skip).map(([, at]) => at))

/**
 * Which notebook a device should show after its first sync: the one another device opened most
 * recently, else the most recently modified. Null keeps what is shown, which is always the case
 * once the user has chosen or the shown notebook has content.
 */
export function pickNotebook({ notebooks, deviceId, current, userChose }: PickInput): string | null {
  if (userChose) return null
  if (current !== null && notebooks.find((n) => n.id === current)?.empty === false) return null
  const others = notebooks.filter((n) => n.id !== current && !n.empty)
  const byOthers = others.map((n) => ({ id: n.id, at: latest(n.openOn, deviceId) })).sort((a, b) => b.at - a.at)
  if (byOthers[0] && byOthers[0].at > 0) return byOthers[0].id
  const byModified = [...others].sort((a, b) => b.modifiedAt - a.modifiedAt)
  return byModified[0]?.id ?? null
}

const PREFIX = 'notebook:'

/**
 * What the store knows about each notebook. There is no edit time in a doc, so "modified" is the
 * last time any device opened it.
 */
export function notebookFacts(store: DocStore): NotebookFacts[] {
  return store.list(PREFIX).map((docId) => {
    const doc = NotebookDoc.fromUpdates(store.load(docId))
    const openOn = doc.openOn()
    const empty = doc.allPageIds().every((pageId) => PageDoc.fromUpdates(store.load(`page:${pageId}`)).listBoxes().length === 0)
    return { id: docId.slice(PREFIX.length), openOn, modifiedAt: latest(openOn), empty }
  })
}

/** The notebook this device opened last, by its own records. */
export function ownCurrent(notebooks: NotebookFacts[], deviceId: string): string | null {
  let best: NotebookFacts | undefined
  for (const n of notebooks) if ((n.openOn[deviceId] ?? 0) > (best?.openOn[deviceId] ?? 0)) best = n
  return best?.id ?? null
}
