import { useEffect, useReducer, useSyncExternalStore, type ReactNode } from 'react'
import type { ChainedCommands, Editor } from '@tiptap/core'
import { activeEditor } from '@slate/editor'

const FONTS = [
  { label: 'Default font', value: '' },
  { label: 'Sans', value: 'system-ui, sans-serif' },
  { label: 'Serif', value: 'Georgia, serif' },
  { label: 'Mono', value: 'monospace' },
]
const SIZES = ['', '12px', '14px', '16px', '18px', '24px', '32px']

function useActiveEditor(): Editor | null {
  const editor = useSyncExternalStore(activeEditor.subscribe, activeEditor.get)
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    if (!editor) return
    editor.on('transaction', rerender)
    return () => {
      editor.off('transaction', rerender)
    }
  }, [editor])
  return editor && !editor.isDestroyed ? editor : null
}

export function Toolbar() {
  const editor = useActiveEditor()
  const run = (fn: (chain: ChainedCommands) => ChainedCommands) => () => {
    if (editor) fn(editor.chain().focus()).run()
  }
  const button = (id: string, label: ReactNode, title: string, active: boolean, onClick: () => void) => (
    <button
      type="button"
      data-testid={`tb-${id}`}
      title={title}
      aria-pressed={active}
      disabled={!editor}
      className={active ? 'active' : undefined}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {label}
    </button>
  )
  const is = (name: string, attrs?: Record<string, unknown>) => editor?.isActive(name, attrs) ?? false
  const textStyle = (editor?.getAttributes('textStyle') ?? {}) as { fontFamily?: string; fontSize?: string; color?: string }

  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting">
      {button('bold', <b>B</b>, 'Bold (Mod+B)', is('bold'), run((c) => c.toggleBold()))}
      {button('italic', <i>I</i>, 'Italic (Mod+I)', is('italic'), run((c) => c.toggleItalic()))}
      {button('underline', <u>U</u>, 'Underline (Mod+U)', is('underline'), run((c) => c.toggleUnderline()))}
      {button('strike', <s>S</s>, 'Strikethrough', is('strike'), run((c) => c.toggleStrike()))}
      {button('code', '</>', 'Inline code (Mod+E)', is('code'), run((c) => c.toggleCode()))}
      <span className="sep" />
      {([1, 2, 3] as const).map((level) => (
        <span key={level}>{button(`h${level}`, `H${level}`, `Heading ${level}`, is('heading', { level }), run((c) => c.toggleHeading({ level })))}</span>
      ))}
      <span className="sep" />
      {button('bullet', '•', 'Bulleted list (Mod+Shift+8)', is('bulletList'), run((c) => c.toggleBulletList()))}
      {button('ordered', '1.', 'Numbered list (Mod+Shift+7)', is('orderedList'), run((c) => c.toggleOrderedList()))}
      {button('codeblock', '{ }', 'Code block (Mod+Alt+C)', is('codeBlock'), run((c) => c.toggleCodeBlock()))}
      {button('table', '▦', 'Insert table', false, run((c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: false })))}
      {is('table') && (
        <>
          {button('row', '+row', 'Add row below', false, run((c) => c.addRowAfter()))}
          {button('col', '+col', 'Add column right', false, run((c) => c.addColumnAfter()))}
          {button('delrow', '−row', 'Delete row', false, run((c) => c.deleteRow()))}
          {button('delcol', '−col', 'Delete column', false, run((c) => c.deleteColumn()))}
          {button('deltable', '✕▦', 'Delete table', false, run((c) => c.deleteTable()))}
        </>
      )}
      <span className="sep" />
      <select
        data-testid="tb-font"
        disabled={!editor}
        value={FONTS.find((f) => f.value === textStyle.fontFamily)?.value ?? ''}
        onChange={(e) => run((c) => (e.target.value ? c.setFontFamily(e.target.value) : c.unsetFontFamily()))()}
      >
        {FONTS.map((f) => (
          <option key={f.label} value={f.value}>
            {f.label}
          </option>
        ))}
      </select>
      <select
        data-testid="tb-size"
        disabled={!editor}
        value={textStyle.fontSize ?? ''}
        onChange={(e) => run((c) => (e.target.value ? c.setFontSize(e.target.value) : c.unsetFontSize()))()}
      >
        {SIZES.map((s) => (
          <option key={s} value={s}>
            {s || 'Size'}
          </option>
        ))}
      </select>
      <label className="color-input" title="Text colour">
        A
        <input data-testid="tb-color" type="color" disabled={!editor} value={textStyle.color ?? '#e6e6e6'} onChange={(e) => run((c) => c.setColor(e.target.value))()} />
      </label>
      <label className="color-input" title="Highlight">
        ▮
        <input data-testid="tb-highlight" type="color" disabled={!editor} defaultValue="#f2c12e" onChange={(e) => run((c) => c.toggleHighlight({ color: e.target.value }))()} />
      </label>
      {button('clear', '⌫', 'Clear formatting', false, run((c) => c.unsetAllMarks().clearNodes()))}
    </div>
  )
}
