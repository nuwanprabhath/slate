import { useEffect, useState } from 'react'
import type { ThemeSpec } from '../../../shared/theme/spec'
import { themeState } from './themeState'

/** Electron prefixes a rejected invoke with "Error invoking remote method '…': Error: "; the rest is ours. */
function message(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e)
  return text.replace(/^Error invoking remote method '[^']*': (Error: )?/, '')
}

/**
 * "Describe a theme": Claude designs it (main validates the reply), it is previewed in this window
 * at once, and nothing is kept until Save. Refine asks again with the preview as the starting point.
 */
export function ThemeDescribe({ onSaved }: { onSaved: (id: string) => void }) {
  const [request, setRequest] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ spec: ThemeSpec; note: string | null; prompt: string } | null>(null)
  // A preview belongs to the open section; closing Settings puts the chosen theme back.
  useEffect(() => () => themeState.setPreview(null), [])

  const generate = async () => {
    const text = request.trim()
    if (text === '' || busy) return
    setBusy(true)
    setError(null)
    try {
      const r = await window.slate.themes.generate(text, result?.spec ?? null)
      const prompt = result === null ? text : `${result.prompt}\n${text}`
      setResult({ ...r, prompt })
      setRequest('')
      themeState.setPreview(r.spec)
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }
  const discard = () => {
    setResult(null)
    themeState.setPreview(null)
  }
  const save = async () => {
    if (result === null) return
    try {
      const saved = await window.slate.themes.save(result.spec, result.prompt)
      setResult(null)
      themeState.setPreview(null)
      onSaved(saved.id)
    } catch (e) {
      setError(message(e))
    }
  }

  return (
    <div className="theme-describe">
      <label htmlFor="theme-describe">
        <strong>{result === null ? 'Describe a theme' : 'Refine it'}</strong>
        <span className="settings-help">
          {' '}
          In your own words, like &ldquo;calm forest green, low contrast borders&rdquo;. Claude designs it and you see it at once; nothing is kept until you save it.
        </span>
      </label>
      <textarea
        id="theme-describe"
        spellCheck={false}
        data-testid="theme-describe"
        rows={2}
        maxLength={2000}
        value={request}
        disabled={busy}
        placeholder={result === null ? 'Calm forest green, low contrast borders' : 'Warmer, and a lighter page'}
        onChange={(e) => setRequest(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void generate()
          }
        }}
      />
      <div className="theme-actions">
        {busy ? (
          <>
            <span data-testid="theme-generating">Claude is designing, usually under a minute…</span>
            <button type="button" className="btn" data-testid="theme-generate-cancel" onClick={() => void window.slate.themes.cancelGenerate()}>Cancel</button>
          </>
        ) : (
          <button type="button" className="btn" data-testid="theme-generate" disabled={request.trim() === ''} onClick={() => void generate()}>
            {result === null ? 'Generate' : 'Refine'}
          </button>
        )}
        {result !== null && !busy && (
          <>
            <span data-testid="theme-preview-name">Previewing <strong>{result.spec.name}</strong></span>
            <button type="button" className="btn" data-testid="theme-preview-save" onClick={() => void save()}>Save</button>
            <button type="button" className="btn" data-testid="theme-preview-discard" onClick={discard}>Discard</button>
          </>
        )}
      </div>
      {result?.note && <p className="theme-note">{result.note}.</p>}
      {error !== null && <p className="theme-error" data-testid="theme-generate-error">{error}</p>}
    </div>
  )
}
