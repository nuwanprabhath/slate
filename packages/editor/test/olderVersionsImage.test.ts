// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { Editor, type Extensions } from '@tiptap/core'
import { LoroDoc, type LoroMap } from 'loro-crdt'
import { contentToJSON, type PMJSON } from '@slate/core'
import { writeContent } from '../src/content'
import { buildExtensions } from '../src/extensions'
import { LoroBinding } from '../src/loroBinding'
// 0.4.3's extension list, verbatim but for its one import path (`git show v0.4.3:packages/editor/src/extensions.ts`).
import { buildExtensions as buildExtensions043 } from './fixtures/extensions-v0.4.3'

/**
 * Pages sync to devices that may still run 0.4.3. Each test loads content this version writes
 * through 0.4.3's schema, the way that device would after a sync, and edits elsewhere in the box.
 */

const PNG = 'slate-blob://blob/abc.png'
const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach((e) => e.destroy()))
const tick = () => new Promise((r) => setTimeout(r, 0))

function mount(doc: LoroDoc, extensions: Extensions): Editor {
  const root = doc.getMap('content')
  const editor = new Editor({ extensions: [...extensions, LoroBinding.configure({ doc, containerId: root.id })] })
  editors.push(editor)
  return editor
}

function imageOf(json: PMJSON | null): Record<string, unknown> | undefined {
  return json?.content?.find((n) => n.type === 'image')?.attrs
}

describe('older versions: image width', () => {
  it('0.4.3 shows a resized image at its width and keeps the width when the box is edited there', async () => {
    const here = new LoroDoc()
    writeContent(here.getMap('content'), [
      { type: 'paragraph', content: [{ type: 'text', text: 'before' }] },
      { type: 'image', attrs: { src: PNG } },
      { type: 'paragraph', content: [{ type: 'text', text: 'after' }] },
    ])
    here.commit()
    const current = mount(here, buildExtensions())
    await tick()
    let imagePos = -1
    current.state.doc.descendants((node, pos) => {
      if (node.type.name === 'image') imagePos = pos
    })
    current.view.dispatch(current.state.tr.setNodeAttribute(imagePos, 'width', 240))
    await tick()
    expect(imageOf(contentToJSON(here.getMap('content') as LoroMap))?.width).toBe(240)

    // The other device, still on 0.4.3, receives the page.
    const there = new LoroDoc()
    there.import(here.export({ mode: 'snapshot' }))
    const old = mount(there, buildExtensions043())
    await tick()
    expect(imageOf(old.getJSON() as PMJSON)?.width).toBe(240)
    expect(old.view.dom.querySelector('img')?.getAttribute('width')).toBe('240')

    // It types at the end of the box; the image keeps its width there and back here.
    old.commands.insertContentAt(old.state.doc.content.size - 1, ' more')
    await tick()
    expect(old.getText()).toContain('after more')
    expect(imageOf(contentToJSON(there.getMap('content') as LoroMap))?.width).toBe(240)
    here.import(there.export({ mode: 'update', from: here.oplogVersion() }))
    await tick()
    expect(imageOf(current.getJSON() as PMJSON)?.width).toBe(240)
    expect(current.getText()).toContain('after more')
  })
})
