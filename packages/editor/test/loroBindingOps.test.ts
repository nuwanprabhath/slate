// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import { contentToJSON, PageDoc } from '@slate/core'
import { LoroDoc } from 'loro-crdt'
import { afterEach, expect, it } from 'vitest'
import { buildExtensions } from '../src/extensions'
import { LoroBinding } from '../src/loroBinding'

const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach((e) => e.destroy()))

/** Every op the doc recorded after the box was set up, as `type key`. */
async function opsWhileTyping(content: string, text: string): Promise<string[]> {
  const doc = new LoroDoc()
  const root = doc.getMap('box')
  const editor = new Editor({ extensions: [...buildExtensions(), LoroBinding.configure({ doc, containerId: root.id })], content })
  editors.push(editor)
  await new Promise((r) => setTimeout(r, 0))
  doc.commit()
  const before = doc.oplogVersion()
  editor.commands.focus('end')
  for (const ch of text) {
    editor.commands.insertContent(ch)
    doc.commit()
  }
  const ops = doc.exportJsonUpdates(before).changes.flatMap((c) => c.ops.map((o) => `${(o.content as { type: string }).type} ${(o.content as { key?: string }).key ?? ''}`.trim()))
  return ops
}

it('typing writes only the text, not a delete for every attribute left unset', async () => {
  for (const content of ['<p></p>', '<h2>Title</h2>', '<ul><li><p>item</p></li></ul>', '<p>a</p><img src="slate-blob://blob/aaaa.png"><p></p>']) {
    const ops = await opsWhileTyping(content, 'ABC')
    // Loro may merge consecutive inserts into one op; what must not appear is a delete.
    expect(ops.length, content).toBeGreaterThan(0)
    expect(ops.filter((op) => op.startsWith('delete')), content).toEqual([])
  }
})

it("typing on one device keeps another device's concurrent alignment of the same paragraph", async () => {
  const a = new LoroDoc()
  a.setPeerId(1n)
  const box = a.getMap('box')
  const seed = new Editor({ extensions: [...buildExtensions(), LoroBinding.configure({ doc: a, containerId: box.id })], content: '<p>hi</p>' })
  editors.push(seed)
  await new Promise((r) => setTimeout(r, 0))
  a.commit()
  const b = new LoroDoc()
  b.setPeerId(2n)
  b.import(a.export({ mode: 'snapshot' }))
  // Device A centres the paragraph; device B, not having seen that, types in it.
  seed.commands.setTextSelection(2)
  seed.commands.setTextAlign('center')
  a.commit()
  const typing = new Editor({ extensions: [...buildExtensions(), LoroBinding.configure({ doc: b, containerId: b.getMap('box').id })] })
  editors.push(typing)
  await new Promise((r) => setTimeout(r, 0))
  typing.commands.focus('end')
  typing.commands.insertContent('!')
  b.commit()
  a.import(b.export({ mode: 'update', from: a.oplogVersion() }))
  b.import(a.export({ mode: 'update', from: b.oplogVersion() }))
  for (const doc of [a, b]) expect(JSON.stringify(doc.getMap('box').toJSON())).toContain('"textAlign":"center"')
})

/** An editor bound to one box's content container, as the canvas mounts it. */
function mountBox(doc: LoroDoc, containerId: ReturnType<LoroDoc['getMap']>['id']): Editor {
  const editor = new Editor({ extensions: [...buildExtensions(), LoroBinding.configure({ doc, containerId })] })
  editors.push(editor)
  return editor
}

// The second device's editor must find the box's content already there and write nothing: if it wrote its own
// doc, the two devices' writes to the same keys would hide whichever lost, with the text typed into it.
for (const peers of [
  [1n, 2n],
  [2n, 1n],
] as const) {
  it(`a box made on one device and opened on another keeps the first device's typing (peers ${peers.join(', ')})`, async () => {
    const a = new PageDoc()
    a.doc.setPeerId(peers[0])
    const id = a.addBox({ x: 0, y: 0, width: 100 })
    const b = new PageDoc(new LoroDoc())
    b.doc.setPeerId(peers[1])
    b.doc.import(a.doc.export({ mode: 'snapshot' }))
    const before = b.doc.oplogVersion()
    const onA = mountBox(a.doc, a.getBox(id)!.contentId)
    mountBox(b.doc, b.getBox(id)!.contentId)
    await new Promise((r) => setTimeout(r, 0))
    a.doc.commit()
    b.doc.commit()
    expect(b.doc.exportJsonUpdates(before).changes).toEqual([])

    onA.commands.focus('end')
    onA.commands.insertContent('hello over git')
    a.doc.commit()
    b.doc.import(a.doc.export({ mode: 'update', from: b.doc.oplogVersion() }))
    a.doc.import(b.doc.export({ mode: 'update', from: a.doc.oplogVersion() }))
    for (const page of [a, b]) expect(JSON.stringify(contentToJSON(page.contentMap(id)!))).toContain('hello over git')
  })
}
