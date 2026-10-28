import { useEffect, useRef } from 'react'

export interface CanvasMenuItem {
  label: string
  testId: string
  disabled?: boolean
  onSelect: () => void
}

/**
 * The canvas's right-click menu. The app's `ContextMenu` lives in the renderer, which the editor may
 * not import, so this one reuses its `.context-menu` styles (loaded app-wide) to look the same.
 */
export function CanvasMenu({ at, items, onClose }: { at: { x: number; y: number }; items: CanvasMenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', down)
    window.addEventListener('keydown', key)
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    return () => {
      window.removeEventListener('mousedown', down)
      window.removeEventListener('keydown', key)
    }
  }, [onClose])
  return (
    <div ref={ref} className="context-menu" data-testid="canvas-menu" style={{ left: at.x, top: at.y }} role="menu">
      {items.map((item) => (
        <button
          key={item.testId}
          type="button"
          role="menuitem"
          className="context-menu-item"
          data-testid={item.testId}
          disabled={item.disabled}
          onClick={() => {
            item.onSelect()
            onClose()
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
