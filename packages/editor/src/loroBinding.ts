import { Extension } from '@tiptap/core'
import { LoroMap, type ContainerID, type LoroDoc } from 'loro-crdt'
import { LoroSyncPlugin, type LoroDocType } from 'loro-prosemirror'

// loro-prosemirror (0.4.4) deletes every null-valued node attribute on each update, whether or not
// the key is stored, and Loro records each delete as an op: with null-default attributes (textAlign,
// indent, checked, image width) every keystroke added two or more ops to the page's history for good.
// Deleting a key this peer cannot see has no effect it could intend, and could only remove another
// peer's concurrent value, so it is skipped.
const deleteKey = LoroMap.prototype.delete
LoroMap.prototype.delete = function (this: LoroMap, key: string): void {
  if (this.get(key) === undefined) return
  deleteKey.call(this, key)
}

/** Binds one box editor to its `content` container inside the page's Loro doc. */
export const LoroBinding = Extension.create<{ doc: LoroDoc | null; containerId: ContainerID | null }>({
  name: 'loroBinding',
  addOptions() {
    return { doc: null, containerId: null }
  },
  addProseMirrorPlugins() {
    const { doc, containerId } = this.options
    if (!doc || !containerId) throw new Error('LoroBinding needs doc and containerId')
    return [LoroSyncPlugin({ doc: doc as unknown as LoroDocType, containerId })]
  },
})
