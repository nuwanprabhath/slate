import { useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { linkPopover, normalizeLinkInput, type LinkPopoverState } from './links'

/** Renders the popover when it belongs to `editor`. Portalled so a transformed canvas can't offset it. */
export function LinkPopover({ editor }: { editor: LinkPopoverState['editor'] | null }) {
  const state = useSyncExternalStore(linkPopover.subscribe, linkPopover.get)
  if (!state || !editor || state.editor !== editor) return null
  return createPortal(<LinkForm key={`${state.from}:${state.to}`} state={state} />, document.body)
}

function LinkForm({ state }: { state: LinkPopoverState }) {
  const { editor, from, to } = state
  const [text, setText] = useState('')
  const [href, setHref] = useState(state.href)
  const [error, setError] = useState<string | null>(null)
  const coords = editor.view.coordsAtPos(to)

  const done = () => {
    linkPopover.close()
    editor.commands.focus()
  }
  const apply = () => {
    const parsed = normalizeLinkInput(href)
    if ('error' in parsed) {
      setError(parsed.error)
      return
    }
    const mark = { type: 'link', attrs: { href: parsed.href } }
    if (state.askText) {
      editor.chain().insertContentAt(from, { type: 'text', text: text.trim() || parsed.href, marks: [mark] }).run()
    } else {
      editor.chain().setTextSelection({ from, to }).setLink({ href: parsed.href }).setTextSelection(to).run()
    }
    done()
  }
  const remove = () => {
    editor.chain().setTextSelection({ from, to }).unsetLink().setTextSelection(to).run()
    done()
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      apply()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      done()
    }
  }

  return (
    <div
      className="slate-link-popover"
      data-testid="link-popover"
      style={{ left: Math.max(8, coords.left), top: coords.bottom + 6 }}
      onKeyDown={onKeyDown}
    >
      {state.askText && (
        <input data-testid="link-text-input" value={text} placeholder="Text" onChange={(e) => setText(e.target.value)} autoFocus />
      )}
      <input
        data-testid="link-input"
        value={href}
        placeholder="Paste or type a link"
        aria-invalid={error !== null}
        onChange={(e) => {
          setHref(e.target.value)
          setError(null)
        }}
        autoFocus={!state.askText}
        onFocus={(e) => e.currentTarget.select()}
      />
      {error && (
        <div className="slate-link-error" data-testid="link-error" role="alert">
          {error}
        </div>
      )}
      <div className="slate-link-actions">
        <button type="button" data-testid="link-apply" onClick={apply}>
          Apply
        </button>
        {state.existing && (
          <button type="button" data-testid="link-remove" onClick={remove}>
            Remove link
          </button>
        )}
      </div>
    </div>
  )
}
