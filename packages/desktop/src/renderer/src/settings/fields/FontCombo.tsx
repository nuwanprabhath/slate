import { useEffect, useId, useState } from 'react'
import { CURATED_FONTS, fontCssValue, isValidFontName } from '../../../../shared/theme/fonts'

const THEME_DEFAULT = 'Theme default'

/** Whether a family renders differently from a fallback: `document.fonts.check` is true for any unknown local font. */
function installed(family: string): boolean {
  const ctx = document.createElement('canvas').getContext('2d')
  if (ctx === null) return false
  const sample = 'mmmmmmmmmmlli1WQ'
  return ['monospace', 'serif'].some((generic) => {
    ctx.font = `20px ${generic}`
    const base = ctx.measureText(sample).width
    ctx.font = `20px "${family}", ${generic}`
    return ctx.measureText(sample).width !== base
  })
}

interface LocalFontData { family: string }
type FontWindow = Window & { queryLocalFonts?: () => Promise<LocalFontData[]> }

let local: Promise<string[]> | null = null

/** The installed families, where Chromium lets us list them; otherwise none, and the curated list stands. */
function localFamilies(): Promise<string[]> {
  local ??= (async () => {
    const query = (window as FontWindow).queryLocalFonts
    if (query === undefined) return []
    try {
      const fonts = await query.call(window)
      return [...new Set(fonts.map((f) => f.family))].filter(isValidFontName).sort((a, b) => a.localeCompare(b))
    } catch {
      return []
    }
  })()
  return local
}

/**
 * A text field with a drop-down of fonts, each shown in itself. Empty means the theme's own font;
 * a typed name is kept only when `isValidFontName` accepts it.
 */
export function FontCombo({ testId, label, value, onChange }: {
  testId: string
  label: string
  value: string | undefined
  onChange: (name: string | undefined) => void
}) {
  const [text, setText] = useState(value ?? '')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [families, setFamilies] = useState<string[]>([])
  const listId = useId()
  useEffect(() => setText(value ?? ''), [value])
  useEffect(() => {
    if (!open) return
    let live = true
    void localFamilies().then((f) => live && setFamilies(f))
    return () => {
      live = false
    }
  }, [open])

  const curated = CURATED_FONTS.filter((f) => !f.optional || installed(f.families[0]!)).map((f) => f.name)
  const names = [...curated, ...families.filter((f) => !curated.includes(f))]
  const query = text.trim().toLowerCase()
  const matches = query === '' || names.some((n) => n.toLowerCase() === query) ? names : names.filter((n) => n.toLowerCase().includes(query))
  const options = [THEME_DEFAULT, ...matches]
  const invalid = text.trim() !== '' && !isValidFontName(text)

  const commit = (name: string) => {
    setOpen(false)
    if (name === THEME_DEFAULT || name.trim() === '') {
      setText('')
      onChange(undefined)
    } else if (isValidFontName(name)) {
      setText(name.trim())
      onChange(name.trim())
    }
  }

  return (
    <label className="settings-inline">
      <strong>{label}</strong>
      <span className="font-combo">
        <input
          data-testid={testId}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-invalid={invalid}
          placeholder={THEME_DEFAULT}
          value={text}
          style={{ fontFamily: (text && fontCssValue(text)) || undefined }}
          onChange={(e) => {
            setText(e.target.value)
            setActive(0)
            setOpen(true)
          }}
          onBlur={() => commit(text)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              if (!open) setOpen(true)
              else setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length)
            } else if (e.key === 'Enter') {
              e.preventDefault()
              commit(open && active > 0 ? options[active]! : text)
            } else if (e.key === 'Escape' && open) {
              e.preventDefault()
              e.stopPropagation()
              setOpen(false)
            }
          }}
        />
        <button type="button" className="font-combo-toggle" tabIndex={-1} aria-label={`Show ${label.toLowerCase()} list`} onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen((o) => !o)}>
          ▾
        </button>
        {open && (
          <ul className="font-combo-list" id={listId} role="listbox" data-testid={`${testId}-list`}>
            {options.map((name, i) => (
              <li
                key={name}
                role="option"
                aria-selected={i === active}
                style={{ fontFamily: name === THEME_DEFAULT ? undefined : (fontCssValue(name) ?? undefined) }}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => commit(name)}
              >
                {name}
              </li>
            ))}
          </ul>
        )}
      </span>
      {invalid && <span className="font-combo-error">Use letters, digits, spaces, dashes, underscores and dots only.</span>}
    </label>
  )
}
