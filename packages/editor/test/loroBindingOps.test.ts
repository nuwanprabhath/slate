// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
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
