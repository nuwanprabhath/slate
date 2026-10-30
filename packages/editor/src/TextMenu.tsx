import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Editor } from '@tiptap/core'
import type { EditorServices } from './services'
import { copyAsMarkdown, pastePlainText } from './textCommands'

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)

/** A shortcut as the platform writes it: ⌥⇧⌘C on macOS, Ctrl+Alt+Shift+C elsewhere. */
function keys(key: string, { shift = false, alt = false } = {}): string {
  if (isMac) return `${alt ? '⌥' : ''}${shift ? '⇧' : ''}⌘${key}`
  return `Ctrl+${alt ? 'Alt+' : ''}${shift ? 'Shift+' : ''}${key}`
}

interface Item {
  label: string
  testId: string
  shortcut: string
  disabled?: boolean
  /** Starts a new group, drawn with a rule above it. */
  group?: boolean
  run: () => void
}

/**
 * The right-click menu inside a box. Focus stays in the editor (a menu button never takes it), so
 * the selection the commands act on is the one the person right-clicked, and an empty box is not
 * removed on blur. Cut, Copy and Paste go through main exactly as the Edit menu's do.
 */
export function TextMenu({ editor, at, services, onClose }: { editor: Editor; at: { x: number; y: number }; services: EditorServices; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState(at)
  const view = editor.view
  const empty = editor.state.selection.empty
  const edit = (command: 'cut' | 'copy' | 'paste') => () => {
    view.focus()
    void services.editCommand(command)
  }
  const items: Item[] = [
    { label: 'Cut', testId: 'text-menu-cut', shortcut: keys('X'), disabled: empty, run: edit('cut') },
    { label: 'Copy', testId: 'text-menu-copy', shortcut: keys('C'), disabled: empty, run: edit('copy') },
    { label: 'Paste', testId: 'text-menu-paste', shortcut: keys('V'), run: edit('paste') },
    { label: 'Paste as Plain Text', testId: 'text-menu-paste-plain', shortcut: keys('V', { shift: true }), run: () => pastePlainText(view, services) },
    { label: 'Copy as Markdown', testId: 'text-menu-copy-markdown', shortcut: keys('C', { shift: true, alt: true }), disabled: empty, group: true, run: () => copyAsMarkdown(view) },
    { label: 'Select All', testId: 'text-menu-select-all', shortcut: keys('A'), run: () => editor.chain().focus().selectAll().run() },
  ]

  // Kept inside the window: a right-click near the right or bottom edge opens it leftward or upward.
  useLayoutEffect(() => {
    const rect = ref.current?.getBoundingClientRect()
    if (!rect) return
    const x = at.x + rect.width > window.innerWidth - 4 ? Math.max(4, at.x - rect.width) : at.x
    const y = at.y + rect.height > window.innerHeight - 4 ? Math.max(4, at.y - rect.height) : at.y
    setPos({ x, y })
  }, [at])

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', down, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('mousedown', down, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  return createPortal(
    <div ref={ref} className="context-menu text-menu" data-testid="text-menu" style={{ left: pos.x, top: pos.y }} role="menu" aria-label="Text">
      {items.map((item) => (
        <Fragment key={item.testId}>
          {item.group && <hr />}
          <button
            type="button"
            role="menuitem"
            className="context-menu-item"
            data-testid={item.testId}
            disabled={item.disabled}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onClose()
              item.run()
            }}
          >
            <span>{item.label}</span>
            <span className="text-menu-keys">{item.shortcut}</span>
          </button>
        </Fragment>
      ))}
    </div>,
    document.body,
  )
}
