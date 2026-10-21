import { useEffect } from 'react'
import type { ConflictRecord } from '@slate/sync'
import './sync.css'

type Choice = 'merged' | 'mine' | 'theirs'

export function ConflictResolver({ conflict, onClose }: { conflict: ConflictRecord; onClose: (resolved: boolean) => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const choose = (choice: Choice) => void window.slate.sync.resolve(conflict.id, choice).then(() => onClose(true))
  const pane = (title: string, text: string, testId: string) => (
    <section className="conflict-column">
      <h3>{title}</h3>
      <pre className="conflict-text" data-testid={testId}>
        {text}
      </pre>
    </section>
  )
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose(false)}>
      <div className="conflict-resolver" data-testid="conflict-resolver" role="dialog" aria-label="Merged edits">
        <h2>Edits from two devices were merged</h2>
        <div className="conflict-columns">
          {pane('This device', conflict.mine, 'conflict-mine')}
          {pane(`Other device (${conflict.device})`, conflict.theirs, 'conflict-theirs')}
          {pane('Merged', conflict.merged, 'conflict-merged')}
        </div>
        <div className="conflict-actions">
          <button type="button" data-testid="resolve-merged" onClick={() => choose('merged')}>
            Keep merged
          </button>
          <button type="button" data-testid="resolve-mine" onClick={() => choose('mine')}>
            Keep this device's
          </button>
          <button type="button" data-testid="resolve-theirs" onClick={() => choose('theirs')}>
            Keep other device's
          </button>
        </div>
      </div>
    </div>
  )
}
