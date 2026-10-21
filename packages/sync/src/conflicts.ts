import { LoroMap, type LoroDoc, type LoroEventBatch } from 'loro-crdt'
import { contentToJSON, PageDoc, toMarkdown } from '@slate/core'

export interface BoxesTouched {
  contentEdited: Set<string>
  deleted: Set<string>
}

/** Which boxes an update edits the content of, or deletes, when applied on top of `base`. */
export function boxesTouched(base: LoroDoc, update: Uint8Array): BoxesTouched {
  const touched: BoxesTouched = { contentEdited: new Set(), deleted: new Set() }
  const fork = base.fork()
  const record = (batch: LoroEventBatch) => {
    for (const event of batch.events) {
      const [root, boxId, field] = event.path
      if (root !== 'boxes') continue
      if (typeof boxId === 'string' && field === 'content') touched.contentEdited.add(boxId)
      else if (event.path.length === 1 && event.diff.type === 'map') {
        for (const [id, value] of Object.entries(event.diff.updated)) if (value === undefined) touched.deleted.add(id)
      }
    }
  }
  fork.subscribe(record)
  fork.import(update)
  return touched
}

/** A box's content as Markdown; '' when the box is gone or empty. */
export function boxMarkdown(doc: LoroDoc, boxId: string): string {
  const content = new PageDoc(doc).contentMap(boxId)
  const json = content instanceof LoroMap ? contentToJSON(content) : null
  return json ? toMarkdown([json]) : ''
}
