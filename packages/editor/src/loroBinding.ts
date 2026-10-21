import { Extension } from '@tiptap/core'
import type { ContainerID, LoroDoc } from 'loro-crdt'
import { LoroSyncPlugin, type LoroDocType } from 'loro-prosemirror'

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
