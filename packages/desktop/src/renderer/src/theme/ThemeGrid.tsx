import { useState } from 'react'
import { DEFAULT_PALETTE, type PaletteToken, type ThemeSpec } from '../../../shared/theme/spec'

const SWATCHES: PaletteToken[] = ['bg', 'sidebar-bg', 'page', 'text', 'accent', 'link']

function describe(spec: ThemeSpec): string {
  const parts: string[] = []
  if (spec.material === 'glass') parts.push('Glass')
  if (spec.texture !== 'none') parts.push(`${spec.texture[0]!.toUpperCase()}${spec.texture.slice(1)} texture`)
  if (spec.effects.some((e) => e.kind === 'gradient-drift')) parts.push('Drift')
  if (spec.effects.some((e) => e.kind === 'grain')) parts.push('Grain')
  return parts.length === 0 ? 'Plain' : parts.join(' · ')
}

export interface ThemeEntry {
  id: string
  spec: ThemeSpec
  saved: boolean
}

/** Every theme as a card of swatches; a click applies it. Saved themes can be renamed and deleted, any can be duplicated. */
export function ThemeGrid({ all, activeId, onChoose, onDuplicate, onRename, onDelete }: {
  all: ThemeEntry[]
  activeId: string
  onChoose: (id: string) => void
  onDuplicate: (t: ThemeEntry) => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
}) {
  const [renaming, setRenaming] = useState<string | null>(null)
  return (
    <div className="theme-grid" role="list" data-testid="theme-grid">
      {all.map((t) => (
        <div key={t.id} className="theme-card-wrap" role="listitem">
          <button type="button" className="theme-card" data-testid="theme-card" data-theme-id={t.id} data-active={t.id === activeId} onClick={() => onChoose(t.id)}>
            <span className="theme-swatches" aria-hidden="true">
              {SWATCHES.map((s) => (
                // A colour Slate re-serialised (validate.ts), set as a style value.
                <span key={s} className="theme-swatch" style={{ background: t.spec.palette[s] ?? DEFAULT_PALETTE[s] }} />
              ))}
            </span>
            {renaming === t.id ? (
              <input
                className="theme-rename"
                data-testid="theme-rename-input"
                autoFocus
                defaultValue={t.spec.name}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') {
                    onRename(t.id, e.currentTarget.value)
                    setRenaming(null)
                  } else if (e.key === 'Escape') setRenaming(null)
                }}
                onBlur={() => setRenaming(null)}
              />
            ) : (
              <span className="theme-card-name">{t.spec.name}</span>
            )}
            <span className="theme-card-effects">{describe(t.spec)}</span>
          </button>
          <span className="theme-card-actions">
            <button type="button" data-testid="theme-duplicate" title="Duplicate" aria-label={`Duplicate ${t.spec.name}`} onClick={() => onDuplicate(t)}>⧉</button>
            {t.saved && (
              <>
                <button type="button" data-testid="theme-rename" title="Rename" aria-label={`Rename ${t.spec.name}`} onClick={() => setRenaming(t.id)}>✎</button>
                <button type="button" data-testid="theme-delete" title="Delete" aria-label={`Delete ${t.spec.name}`} onClick={() => onDelete(t.id)}>✕</button>
              </>
            )}
          </span>
        </div>
      ))}
    </div>
  )
}
