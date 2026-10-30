import { useEffect, useReducer, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react'
import type { ChainedCommands, Editor } from '@tiptap/core'
import { activeEditor, formatPainter, inTodoItem, type TextAlign } from '@slate/editor'
import { SyncStatus } from './sync/SyncStatus'
import { ColorPalette } from './ColorPalette'
import { AlignIcon, BulletListIcon, ChevronIcon, ClearFormattingIcon, FormatPainterIcon, HighlightIcon, LockIcon, NumberedListIcon, ScriptIcon, TableIcon, TextColorIcon, TodoListIcon } from './toolbarIcons'

const FONTS = [
  { label: 'Default font', value: '' },
  { label: 'Sans', value: 'system-ui, sans-serif' },
  { label: 'Serif', value: 'Georgia, serif' },
  { label: 'Mono', value: 'monospace' },
]
const SIZES = ['', '12px', '14px', '16px', '18px', '24px', '32px']
const BULLET_STYLES = [
  { value: 'disc', label: '• Disc' },
  { value: 'circle', label: '◦ Circle' },
  { value: 'square', label: '▪ Square' },
]
const NUMBER_STYLES = [
  { value: 'decimal', label: '1. 2. 3.' },
  { value: 'lower-alpha', label: 'a. b. c.' },
  { value: 'lower-roman', label: 'i. ii. iii.' },
  { value: 'upper-alpha', label: 'A. B. C.' },
  { value: 'upper-roman', label: 'I. II. III.' },
]

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

/** A toolbar menu's open state, closed by a click outside it or Escape. */
function useToolbarMenu(): [boolean, (open: boolean) => void, RefObject<HTMLSpanElement | null>] {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])
  return [open, setOpen, root]
}

/** The chevron half of a list split button: a small menu of marker styles. */
function StyleMenu(props: { id: string; label: string; styles: typeof BULLET_STYLES; disabled: boolean; onPick: (style: string) => void }) {
  const { id, label, styles, disabled, onPick } = props
  const [open, setOpen, root] = useToolbarMenu()
  return (
    <span className="split-menu" ref={root}>
      <button
        type="button"
        className="chevron"
        data-testid={`tb-${id}-menu`}
        title={`${label} styles`}
        aria-label={`${label} styles`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen(!open)}
      >
        <ChevronIcon />
      </button>
      {open && (
        <div className="style-menu" role="menu">
          {styles.map((s) => (
            <button
              key={s.value}
              type="button"
              role="menuitem"
              className="menu-item"
              data-testid={`list-style-${s.value}`}
              title={s.value}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setOpen(false)
                onPick(s.value)
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
    </span>
  )
}

const isMac = navigator.platform.toLowerCase().includes('mac')

const ALIGNMENTS: Array<{ value: TextAlign; label: string; keys: string }> = [
  { value: 'left', label: 'Align left', keys: isMac ? '⌥⇧⌘L' : 'Ctrl+Alt+Shift+L' },
  { value: 'center', label: 'Centre', keys: isMac ? '⇧⌘E' : 'Ctrl+Shift+E' },
  { value: 'right', label: 'Align right', keys: isMac ? '⇧⌘R' : 'Ctrl+Shift+R' },
]

/** The alignment dropdown: the current alignment's icon, opening left, centre and right. */
function AlignMenu(props: { current: TextAlign; disabled: boolean; onPick: (align: TextAlign) => void }) {
  const { current, disabled, onPick } = props
  const [open, setOpen, root] = useToolbarMenu()
  return (
    <span className="split-menu" ref={root}>
      <button
        type="button"
        className="align-button"
        data-testid="tb-align"
        title="Alignment"
        aria-label="Alignment"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen(!open)}
      >
        <AlignIcon align={current} />
        <ChevronIcon />
      </button>
      {open && (
        <div className="style-menu align-menu" role="menu">
          {ALIGNMENTS.map((a) => (
            <button
              key={a.value}
              type="button"
              role="menuitemradio"
              aria-checked={a.value === current}
              className={a.value === current ? 'menu-item active' : 'menu-item'}
              data-testid={`align-${a.value}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setOpen(false)
                onPick(a.value)
              }}
            >
              <AlignIcon align={a.value} />
              <span className="align-label">{a.label}</span>
              <span className="align-keys">{a.keys}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  )
}

/** The brush: a click carries the selection's format to the next selection; a double-click keeps it on until Esc or another click. */
function FormatPainterButton(props: { editor: Editor | null }) {
  const { editor } = props
  const painter = useSyncExternalStore(formatPainter.subscribe, formatPainter.get)
  return (
    <button
      type="button"
      data-testid="tb-format-painter"
      title="Format painter (double-click to keep it on)"
      aria-label="Format painter"
      aria-pressed={painter !== null}
      disabled={!editor}
      className={painter ? 'active' : undefined}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => (painter ? formatPainter.stop() : editor && formatPainter.start(editor, false))}
      onDoubleClick={() => editor && formatPainter.start(editor, true)}
    >
      <FormatPainterIcon />
    </button>
  )
}

/** The lock replaces this window, so one answer at mount is enough: only an encrypted, unlocked vault gets the button. */
function useVaultUnlocked(): boolean {
  const [unlocked, setUnlocked] = useState(false)
  useEffect(() => {
    let live = true
    void window.slate.vault.status().then((s) => live && setUnlocked(s.state === 'unlocked'))
    return () => {
      live = false
    }
  }, [])
  return unlocked
}

export function Toolbar() {
  const editor = useActiveEditor()
  const vaultUnlocked = useVaultUnlocked()
  const run = (fn: (chain: ChainedCommands) => ChainedCommands) => () => {
    if (editor) fn(editor.chain().focus()).run()
  }
  const button = (id: string, label: ReactNode, title: string, active: boolean, onClick: () => void) => (
    <button
      type="button"
      data-testid={`tb-${id}`}
      title={title}
      aria-label={title}
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
  const todo = editor ? inTodoItem(editor.state) : false
  const align: TextAlign = editor?.isActive({ textAlign: 'center' }) ? 'center' : editor?.isActive({ textAlign: 'right' }) ? 'right' : 'left'
  const textStyle = (editor?.getAttributes('textStyle') ?? {}) as { fontFamily?: string; fontSize?: string; color?: string }
  // Picking a style turns the list on first when the selection is not in one of that type.
  const setListStyle = (type: 'bulletList' | 'orderedList', style: string) =>
    run((c) => {
      const on = is(type) ? c : type === 'bulletList' ? c.toggleBulletList() : c.toggleOrderedList()
      return on.updateAttributes(type, { listStyle: style })
    })()

  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting">
      {button('bold', <b>B</b>, 'Bold (Mod+B)', is('bold'), run((c) => c.toggleBold()))}
      {button('italic', <i>I</i>, 'Italic (Mod+I)', is('italic'), run((c) => c.toggleItalic()))}
      {button('underline', <u>U</u>, 'Underline (Mod+U)', is('underline'), run((c) => c.toggleUnderline()))}
      {button('strike', <s>S</s>, 'Strikethrough', is('strike'), run((c) => c.toggleStrike()))}
      {button('code', '</>', 'Inline code (Mod+E)', is('code'), run((c) => c.toggleCode()))}
      {button('subscript', <ScriptIcon position="sub" />, 'Subscript (Mod+Shift+,)', is('textStyle', { verticalAlign: 'sub' }), run((c) => c.toggleSubscript()))}
      {button('superscript', <ScriptIcon position="super" />, 'Superscript (Mod+Shift+.)', is('textStyle', { verticalAlign: 'super' }), run((c) => c.toggleSuperscript()))}
      <span className="sep" />
      {([1, 2, 3] as const).map((level) => (
        <span key={level}>{button(`h${level}`, `H${level}`, `Heading ${level}`, is('heading', { level }), run((c) => c.toggleHeading({ level })))}</span>
      ))}
      <span className="sep" />
      <span className="split">
        {button('bullet', <BulletListIcon />, 'Bulleted list (Mod+Shift+8)', is('bulletList') && !todo, run((c) => c.toggleBulletList()))}
        <StyleMenu id="bullet" label="Bulleted list" styles={BULLET_STYLES} disabled={!editor} onPick={(s) => setListStyle('bulletList', s)} />
      </span>
      <span className="split">
        {button('ordered', <NumberedListIcon />, 'Numbered list (Mod+Shift+7)', is('orderedList'), run((c) => c.toggleOrderedList()))}
        <StyleMenu id="ordered" label="Numbered list" styles={NUMBER_STYLES} disabled={!editor} onPick={(s) => setListStyle('orderedList', s)} />
      </span>
      {button('todo', <TodoListIcon />, 'To-do list (Mod+Shift+9)', todo, run((c) => c.toggleTodoList()))}
      {button('codeblock', '{ }', 'Code block (Mod+Alt+C)', is('codeBlock'), run((c) => c.toggleCodeBlock()))}
      {button('table', <TableIcon />, 'Insert table', false, run((c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: false })))}
      <AlignMenu current={align} disabled={!editor} onPick={(a) => run((c) => c.setTextAlign(a))()} />
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
      <ColorPalette
        id="color"
        label="Text colour"
        autoLabel="Automatic"
        defaultColor="#ff0000"
        disabled={!editor}
        icon={(last) => <TextColorIcon color={textStyle.color ?? last} />}
        onPick={(color) => run((c) => (color ? c.setColor(color) : c.unsetColor()))()}
      />
      <ColorPalette
        id="highlight"
        label="Highlight"
        autoLabel="No highlight"
        defaultColor="#ffff00"
        disabled={!editor}
        icon={(last) => <HighlightIcon color={last} />}
        onPick={(color) => run((c) => (color ? c.setHighlight({ color }) : c.unsetHighlight()))()}
      />
      <FormatPainterButton editor={editor} />
      {button('clear', <ClearFormattingIcon />, 'Clear all formatting', false, run((c) => c.unsetAllMarks().clearNodes()))}
      {vaultUnlocked && (
        <button
          type="button"
          className="toolbar-lock"
          data-testid="toolbar-lock"
          aria-label="Lock Slate"
          title={`Lock Slate (${isMac ? '⌘⇧L' : 'Ctrl+Shift+L'})`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => window.slate.vault.lock()}
        >
          <LockIcon />
        </button>
      )}
      <SyncStatus />
    </div>
  )
}
