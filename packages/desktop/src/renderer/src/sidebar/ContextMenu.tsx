import { useEffect, useRef, useState } from 'react'

export type MenuItem =
  | { label: string; onSelect: () => void; confirm?: boolean }
  | { swatches: readonly string[]; onPick: (color: string) => void }

export interface MenuState {
  x: number
  y: number
  items: MenuItem[]
}

/** In-app context menu. Destructive items need a second click instead of a blocking dialog. */
export function ContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [armed, setArmed] = useState<string | null>(null)
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', down)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('mousedown', down)
      window.removeEventListener('keydown', key)
    }
  }, [onClose])
  return (
    <div ref={ref} className="context-menu" style={{ left: menu.x, top: menu.y }} role="menu">
      {menu.items.map((item, i) =>
        'swatches' in item ? (
          <div key={i} className="swatches">
            {item.swatches.map((c) => (
              <button
                key={c}
                type="button"
                className="swatch"
                style={{ background: c }}
                aria-label={`Colour ${c}`}
                onClick={() => {
                  item.onPick(c)
                  onClose()
                }}
              />
            ))}
          </div>
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={item.confirm ? 'danger' : undefined}
            onClick={() => {
              if (item.confirm && armed !== item.label) return setArmed(item.label)
              item.onSelect()
              onClose()
            }}
          >
            {item.confirm && armed === item.label ? `Click again to ${item.label.toLowerCase()}` : item.label}
          </button>
        ),
      )}
    </div>
  )
}
