import { useEffect, useState } from 'react'
import type { Settings } from '../../../shared/api'
import { SECTIONS } from './registry'
import { filterSections } from './search'
import './settings.css'

interface Props {
  settings: Settings
  /** The section to show first; the first section when unknown. */
  section?: string
  onClose: () => void
  onShowConnectAgents: () => void
}

/** Sections on the left, the chosen one's fields on the right. Every change saves at once. */
export function SettingsDialog({ settings, section, onClose, onShowConnectAgents }: Props) {
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState(() => SECTIONS.find((s) => s.id === section)?.id ?? SECTIONS[0].id)
  useEffect(() => {
    if (section && SECTIONS.some((s) => s.id === section)) setActiveId(section)
  }, [section])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const visible = filterSections(SECTIONS, query)
  const active = visible.find((s) => s.id === activeId) ?? visible[0]
  // Shown at once, before main's change event comes back, so a control never lags the click.
  const [shown, setShown] = useState(settings)
  useEffect(() => setShown(settings), [settings])
  const patch = (fields: Partial<Settings>) => {
    setShown((s) => ({ ...s, ...fields }))
    void window.slate.settings.set(fields)
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="settings-dialog" data-testid="settings-dialog" role="dialog" aria-label="Settings">
        <nav className="settings-nav" aria-label="Settings sections">
          <input
            className="settings-search"
            data-testid="settings-search"
            type="search"
            placeholder="Search settings"
            aria-label="Search settings"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {visible.map((s) => (
            <button
              key={s.id}
              type="button"
              className={s.id === active?.id ? 'settings-nav-item active' : 'settings-nav-item'}
              data-testid={`settings-nav-${s.id}`}
              aria-current={s.id === active?.id ? 'page' : undefined}
              onClick={() => setActiveId(s.id)}
            >
              {s.label}
            </button>
          ))}
          {visible.length === 0 && <p className="settings-help">No settings match.</p>}
        </nav>
        <div className="settings-pane" data-testid="settings-pane">
          <header className="settings-header">
            <h2 data-testid="settings-heading">{active?.label ?? 'Settings'}</h2>
            <button type="button" className="settings-close" data-testid="settings-close" aria-label="Close" onClick={onClose}>
              ✕
            </button>
          </header>
          {active && (
            <>
              <p className="settings-blurb">{active.blurb}</p>
              <active.Component settings={shown} patch={patch} onClose={onClose} onShowConnectAgents={onShowConnectAgents} />
            </>
          )}
        </div>
      </section>
    </div>
  )
}
