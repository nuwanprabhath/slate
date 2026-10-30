// @vitest-environment happy-dom
import { Editor, Extension } from '@tiptap/core'
import { afterEach, describe, expect, it } from 'vitest'
import { buildExtensions } from '../src/extensions'
import { foldPlugin, toggleFold, unfoldAt } from '../src/fold'

/** Phase 15 WP-C2: folding headings is view state only, kept per box in the renderer. */
const editors: Editor[] = []
afterEach(() => {
  editors.splice(0).forEach((e) => e.destroy())
})

let boxCount = 0
function open(content: string, boxId = `box-${++boxCount}`): Editor {
  const ed = new Editor({ extensions: [...buildExtensions(), Extension.create({ name: 'fold', addProseMirrorPlugins: () => [foldPlugin(boxId)] })], content })
  editors.push(ed)
  return ed
}

const PAGE = '<h1>One</h1><p>a</p><h2>Sub</h2><p>b</p><h1>Two</h1><p>c</p>'

/** Each top-level block's text, with the ones folded away in brackets. */
function shown(ed: Editor): string[] {
  return Array.from(ed.view.dom.children).map((el) => {
    const text = el.textContent?.replace(/[▸▾]/g, '') ?? ''
    return el.classList.contains('slate-fold-hidden') ? `[${text}]` : el.classList.contains('slate-folded') ? `${text}…` : text
  })
}
const headingPos = (ed: Editor, text: string): number => {
  let at = -1
  ed.state.doc.forEach((node, pos) => {
    if (at < 0 && node.type.name === 'heading' && node.textContent === text) at = pos
  })
  return at
}

describe('fold headings', () => {
  it('hides everything up to the next heading of the same or a higher level, without touching the document', () => {
    const ed = open(PAGE)
    const before = JSON.stringify(ed.getJSON())
    toggleFold(ed.view, headingPos(ed, 'One'))
    expect(shown(ed)).toEqual(['One…', '[a]', '[Sub]', '[b]', 'Two', 'c'])
    expect(JSON.stringify(ed.getJSON())).toBe(before)
    toggleFold(ed.view, headingPos(ed, 'One'))
    expect(shown(ed)).toEqual(['One', 'a', 'Sub', 'b', 'Two', 'c'])
  })

  it('a lower heading folds only its own section', () => {
    const ed = open(PAGE)
    toggleFold(ed.view, headingPos(ed, 'Sub'))
    expect(shown(ed)).toEqual(['One', 'a', 'Sub…', '[b]', 'Two', 'c'])
  })

  it('every heading has a toggle; a mousedown on it folds and unfolds', () => {
    const ed = open(PAGE)
    const toggles = ed.view.dom.querySelectorAll('.slate-fold-toggle')
    expect(toggles).toHaveLength(3)
    const first = toggles[0]!
    expect(first.getAttribute('aria-label')).toBe('Fold heading')
    first.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
    expect(shown(ed)[0]).toBe('One…')
    const again = ed.view.dom.querySelector('.slate-fold-toggle')!
    expect(again.getAttribute('aria-label')).toBe('Unfold heading')
    again.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
    expect(shown(ed)[0]).toBe('One')
  })

  it('stays folded through edits above the heading, and unfolds when the heading text changes', () => {
    const ed = open(PAGE)
    toggleFold(ed.view, headingPos(ed, 'Two'))
    ed.view.dispatch(ed.state.tr.insertText('zz', 2))
    expect(shown(ed)).toEqual(['Ozzne', 'a', 'Sub', 'b', 'Two…', '[c]'])
    ed.view.dispatch(ed.state.tr.insertText('!', headingPos(ed, 'Two') + 4))
    expect(shown(ed)).toEqual(['Ozzne', 'a', 'Sub', 'b', 'Two!', 'c'])
  })

  it('is kept per box in the renderer: a remounted editor of the same box shows the fold, another box does not', () => {
    const ed = open(PAGE, 'kept')
    toggleFold(ed.view, headingPos(ed, 'One'))
    ed.destroy()
    expect(shown(open(PAGE, 'kept'))[0]).toBe('One…')
    expect(shown(open(PAGE, 'other'))[0]).toBe('One')
  })

  it('unfoldAt(boxId, pos) opens the fold hiding pos, and only that', () => {
    const ed = open(PAGE, 'find')
    toggleFold(ed.view, headingPos(ed, 'One'))
    toggleFold(ed.view, headingPos(ed, 'Two'))
    expect(unfoldAt('find', headingPos(ed, 'Two') + 7)).toBe(true)
    expect(shown(ed)).toEqual(['One…', '[a]', '[Sub]', '[b]', 'Two', 'c'])
    expect(unfoldAt('find', 1)).toBe(false)
    expect(unfoldAt('nowhere', 1)).toBe(false)
  })

  it('moving the caret into folded text unfolds it, and folding moves a caret out of it', () => {
    const ed = open(PAGE)
    ed.commands.setTextSelection(headingPos(ed, 'Two') + 7)
    toggleFold(ed.view, headingPos(ed, 'Two'))
    expect(ed.state.selection.$from.parent.textContent).toBe('Two')
    ed.commands.setTextSelection(headingPos(ed, 'Two') + 7)
    expect(shown(ed).at(-1)).toBe('c')
  })
})
