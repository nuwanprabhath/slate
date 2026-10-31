// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import { contentToJSON, writeContent, type PMJSON } from '@slate/core'
import { LoroDoc, LoroMap } from 'loro-crdt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LoroBinding } from '../src/loroBinding'
import { buildExtensions as buildExtensions043 } from './fixtures/extensions-0.4.3'

/**
 * Phase 15, "Older versions": a page edited on this version syncs to devices still on 0.4.3. These
 * pin what 0.4.3's schema and Loro binding do with each addition: show it, drop it from view, or
 * delete it from the page when the person there edits elsewhere in the same box.
 */
const p = (text: string, attrs?: Record<string, unknown>): PMJSON => ({ type: 'paragraph', ...(attrs ? { attrs } : {}), content: [{ type: 'text', text }] })
const item = (text: string, attrs?: Record<string, unknown>): PMJSON => ({ type: 'listItem', ...(attrs ? { attrs } : {}), content: [p(text)] })

function boxWith(blocks: PMJSON[]): { doc: LoroDoc; root: LoroMap } {
  const doc = new LoroDoc()
  const root = doc.getMap('box')
  writeContent(root, blocks, doc)
  doc.commit()
  return { doc, root }
}

/** Opens the box in a 0.4.3 editor, types at the end of its last paragraph, and returns what 0.4.3 showed and what the page holds after. */
async function editOn043(blocks: PMJSON[]): Promise<{ shown: string; after: PMJSON | null; errors: number }> {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const { doc, root } = boxWith(blocks)
  const editor = new Editor({ extensions: [...buildExtensions043(), LoroBinding.configure({ doc, containerId: root.id })] })
  try {
    await new Promise((r) => setTimeout(r, 0)) // the binding loads the box on the next task
    const shown = editor.getText()
    let end = 0
    editor.state.doc.descendants((node, pos) => {
      if (node.isTextblock) end = pos + node.nodeSize - 1
    })
    editor.view.dispatch(editor.state.tr.insertText('!', end))
    doc.commit()
    return { shown, after: contentToJSON(root), errors: errors.mock.calls.length }
  } finally {
    editor.destroy()
    errors.mockRestore()
  }
}

const json = (v: unknown) => JSON.stringify(v)

afterEach(() => vi.restoreAllMocks())

describe('0.4.3 opening content added in phase 15', async () => {
  it('control: plain content survives an edit elsewhere', async () => {
    const { after } = await editOn043([p('one'), p('two')])
    expect(json(after)).toContain('one')
    expect(json(after)).toContain('two!')
  })

  it('new node types (taskList/taskItem): 0.4.3 drops them from view and deletes them from the page on the next edit', async () => {
    const { shown, after, errors } = await editOn043([p('before'), { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [p('buy milk')] }] }, p('after')])
    expect(shown).not.toContain('buy milk')
    expect(errors).toBeGreaterThan(0)
    expect(json(after)).not.toContain('buy milk')
  })

  it('a `checked` attribute on the existing listItem: 0.4.3 shows a bullet item and keeps the attribute when the edit is elsewhere', async () => {
    const { shown, after, errors } = await editOn043([{ type: 'bulletList', content: [item('buy milk', { checked: true }), item('eggs', { checked: false })] }, p('after')])
    expect(shown).toContain('buy milk')
    expect(errors).toBe(0)
    expect(json(after)).toContain('"checked":true')
    expect(json(after)).toContain('"checked":false')
  })

  it('a `checked` attribute: 0.4.3 removes it from the item it edits (the text stays, as a plain bullet)', async () => {
    const { after } = await editOn043([p('before'), { type: 'bulletList', content: [item('eggs', { checked: true })] }])
    expect(json(after)).toContain('eggs!')
    expect(json(after)).not.toContain('checked')
  })

  it('a textAlign attribute on a paragraph: shown left-aligned, kept when the edit is elsewhere, removed from the paragraph it edits', async () => {
    const elsewhere = await editOn043([p('centred', { textAlign: 'center' }), p('after')])
    expect(elsewhere.shown).toContain('centred')
    expect(elsewhere.errors).toBe(0)
    expect(json(elsewhere.after)).toContain('"textAlign":"center"')
    const same = await editOn043([p('centred', { textAlign: 'center' })])
    expect(json(same.after)).toContain('centred!')
    expect(json(same.after)).not.toContain('textAlign')
  })

  it('new subscript/superscript marks: 0.4.3 drops the marked text from view and deletes it on an edit in that paragraph', async () => {
    const marked = (type: string): PMJSON => ({ type: 'paragraph', content: [{ type: 'text', text: 'H' }, { type: 'text', text: '2', marks: [{ type }] }, { type: 'text', text: 'O' }] })
    for (const type of ['subscript', 'superscript']) {
      const { shown, after, errors } = await editOn043([marked(type)])
      expect(shown, type).not.toContain('H2O')
      expect(errors, type).toBeGreaterThan(0)
      expect(json(after), type).not.toContain('2')
    }
  })

  it('sub/superscript as an attribute of the existing textStyle mark: 0.4.3 shows the text, keeps it elsewhere, and in the paragraph it edits keeps the text as normal text', async () => {
    const marked: PMJSON = { type: 'paragraph', content: [{ type: 'text', text: 'H' }, { type: 'text', text: '2', marks: [{ type: 'textStyle', attrs: { verticalAlign: 'sub' } }] }, { type: 'text', text: 'O' }] }
    const elsewhere = await editOn043([marked, p('after')])
    expect(elsewhere.shown).toContain('H2O')
    expect(elsewhere.errors).toBe(0)
    expect(json(elsewhere.after)).toContain('"verticalAlign":"sub"')
    const same = await editOn043([marked])
    expect(json(same.after)).toContain('"text":"2"')
    expect(json(same.after)).toContain('O!')
    expect(json(same.after)).not.toContain('verticalAlign')
  })

  it('an indent attribute on a paragraph or heading (WP-C2): shown unindented, kept when the edit is elsewhere, removed from the block it edits', async () => {
    const heading: PMJSON = { type: 'heading', attrs: { level: 2, indent: 2 }, content: [{ type: 'text', text: 'title' }] }
    const elsewhere = await editOn043([heading, p('indented', { indent: 3 }), p('after')])
    expect(elsewhere.shown).toContain('indented')
    expect(elsewhere.errors).toBe(0)
    expect(json(elsewhere.after)).toContain('"indent":3')
    expect(json(elsewhere.after)).toContain('"indent":2')
    const same = await editOn043([p('indented', { indent: 3 })])
    expect(json(same.after)).toContain('indented!')
    expect(json(same.after)).not.toContain('indent"')
  })

  it("a floating picture's x and y (dragged to a spot in its box): 0.4.3 shows the picture on its own line and keeps both", async () => {
    const image: PMJSON = { type: 'image', attrs: { src: 'slate-blob://blob/a.png', x: 120, y: 40 } }
    const { after, errors } = await editOn043([p('before'), image, p('after')])
    expect(errors).toBe(0)
    expect(json(after)).toContain('"x":120')
    expect(json(after)).toContain('"y":40')
    expect(json(after)).toContain('after!')
  })
})
