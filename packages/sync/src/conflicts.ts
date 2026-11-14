import type { Diff, LoroDoc, LoroEventBatch } from 'loro-crdt'
import { PageDoc, toMarkdown, withHandles, type Handles } from '@slate/core'

export interface BoxesTouched {
  contentEdited: Set<string>
  deleted: Set<string>
}

/**
 * Loro makes a handle for every container a diff carries (a box put under its id, a paragraph inserted into a
 * list), whether or not anyone reads it, and each keeps the document it came from alive like any other handle.
 */
function ownContainers(diff: Diff, h: Handles): void {
  if (diff.type === 'map') for (const key of Object.keys(diff.updated)) h.own(diff.updated[key])
  else if (diff.type === 'list') for (const op of diff.diff) h.own(op.insert)
}

/** Which boxes an update edits the content of, or deletes, when applied on top of `base`. */
export function boxesTouched(base: LoroDoc, update: Uint8Array): BoxesTouched {
  const touched: BoxesTouched = { contentEdited: new Set(), deleted: new Set() }
  return withHandles((h) => {
    const record = (batch: LoroEventBatch) => {
      for (const event of batch.events) {
        ownContainers(event.diff, h)
        const [root, boxId, field] = event.path
        if (root !== 'boxes') continue
        if (typeof boxId === 'string' && field === 'content') touched.contentEdited.add(boxId)
        else if (event.path.length === 1 && event.diff.type === 'map') {
          for (const id of Object.keys(event.diff.updated)) if (event.diff.updated[id] === undefined) touched.deleted.add(id)
        }
      }
    }
    // A fork holds memory as a document does. The scope frees it when it ends, also when the import throws.
    const fork = h.own(base.fork())
    fork.subscribe(record)
    fork.import(update)
    return touched
  })
}

/** A box's content as Markdown; '' when the box is gone or empty. */
export function boxMarkdown(doc: LoroDoc, boxId: string): string {
  const json = new PageDoc(doc).boxContent(boxId)
  return json ? toMarkdown([json]) : ''
}
