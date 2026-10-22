import { useEffect, useRef, useState } from 'react'
import type { AppMenuNode } from '../../../shared/windowChrome/chrome'
import { titleBarColors } from '../../../shared/windowChrome/chrome'
import { appliedTheme } from '../theme/applyTheme'
import './titleBar.css'

/**
 * The window's title bar, drawn in the theme. On macOS the traffic lights sit over its left end;
 * on Linux and Windows Electron draws the window buttons over its right end and the native menu
 * bar is gone, so the bar carries an in-app one. Nothing is drawn with the system bar.
 */
export function TitleBar({ title }: { title: string }) {
  const { kind, platform } = window.slate.chrome
  useChromeColors(kind === 'overlay')
  if (kind === 'system') return null
  return (
    <header
      className="title-bar"
      data-testid="title-bar"
      data-chrome={kind}
      // macOS zooms on its own for hiddenInset; Linux's window manager does not see this drag region.
      onDoubleClick={(e) => {
        if (platform === 'linux' && e.target === e.currentTarget) window.slate.chrome.toggleMaximize()
      }}
    >
      {kind === 'overlay' && <MenuBar />}
      <span className="title-bar-title" data-testid="title-bar-title">
        {title}
      </span>
    </header>
  )
}

/** Keeps the OS-drawn window buttons the colour of the bar, previews included. */
function useChromeColors(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return
    const send = () => {
      const spec = appliedTheme.get()
      if (spec) window.slate.chrome.setColors(titleBarColors(spec))
    }
    send()
    return appliedTheme.subscribe(send)
  }, [enabled])
}

/** Main's own application menu (`chrome.menu`), so every label, item and shortcut is defined once in main/menu.ts. */
function MenuBar() {
  const [menu, setMenu] = useState<AppMenuNode[]>([])
  const [open, setOpen] = useState<number | null>(null)
  const nav = useRef<HTMLElement>(null)
  // Focus goes back where it was before an item runs: Edit → Paste pastes into the page, not the menu.
  const returnFocus = useRef<HTMLElement | null>(null)

  useEffect(() => {
    void window.slate.chrome.menu().then(setMenu)
  }, [])

  useEffect(() => {
    if (open === null) return
    const onDown = (e: MouseEvent) => {
      if (!nav.current?.contains(e.target as Node)) setOpen(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(null)
    }
    const onBlur = () => setOpen(null)
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [open])

  const openAt = (i: number | null) => {
    // Re-read on each open: a checkbox may have changed since.
    if (i !== null) void window.slate.chrome.menu().then(setMenu)
    setOpen(i)
  }

  const invoke = (path: number[]) => {
    setOpen(null)
    returnFocus.current?.focus()
    returnFocus.current = null
    window.slate.chrome.invokeMenu(path)
  }

  const top = menu.filter((m) => m.kind === 'submenu')
  return (
    <nav className="menu-bar" aria-label="Application menu" data-testid="menu-bar" ref={nav}>
      {top.map((m, i) => (
        <div key={m.label} className="menu-bar-slot">
          <button
            type="button"
            className="menu-bar-item"
            data-testid={`menu-bar-${m.label.toLowerCase()}`}
            aria-haspopup="menu"
            aria-expanded={open === i}
            onMouseDown={(e) => {
              e.preventDefault()
              if (open === null && document.activeElement instanceof HTMLElement) returnFocus.current = document.activeElement
            }}
            onClick={() => openAt(open === i ? null : i)}
            onMouseEnter={() => {
              if (open !== null && open !== i) openAt(i)
            }}
          >
            {m.label}
          </button>
          {open === i && (
            <ul className="menu-dropdown" role="menu" data-testid="menu-bar-dropdown">
              {(m.submenu ?? []).map((node) =>
                node.kind === 'separator' ? (
                  <li key={node.path.join('.')} role="separator" />
                ) : node.kind === 'submenu' ? null : (
                  <li key={node.path.join('.')} role="none">
                    <button
                      type="button"
                      role={node.kind === 'checkbox' ? 'menuitemcheckbox' : 'menuitem'}
                      aria-checked={node.kind === 'checkbox' || node.kind === 'radio' ? node.checked === true : undefined}
                      disabled={!node.enabled}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => invoke(node.path)}
                    >
                      <span className="menu-dropdown-check">{node.checked ? '✓' : ''}</span>
                      <span>{node.label}</span>
                      <span className="menu-dropdown-accel">{node.accelerator ?? ''}</span>
                    </button>
                  </li>
                ),
              )}
            </ul>
          )}
        </div>
      ))}
    </nav>
  )
}
