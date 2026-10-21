import { useCallback, useEffect, useState } from 'react'
import type { ImportProgress, OneNoteNotebook, OneNoteSectionGroup } from '@slate/importer'
import type { BackupPick, OneNoteStatus } from '../../../shared/api'
import './import.css'

type Stage =
  | { kind: 'loading' }
  | { kind: 'backup'; pick: BackupPick | null }
  | { kind: 'not-configured' }
  | { kind: 'signed-out' }
  | { kind: 'picker'; account?: string; tree: OneNoteNotebook[] | null }
  | { kind: 'running' }
  | { kind: 'report'; result: ImportProgress }

interface Node {
  id: string
  name: string
  children: Node[]
}

const groupNode = (g: OneNoteSectionGroup): Node => ({
  id: g.id,
  name: g.name,
  children: [...g.sectionGroups.map(groupNode), ...g.sections.map((s) => ({ id: s.id, name: s.name, children: [] }))],
})

function toNodes(tree: OneNoteNotebook[]): Node[] {
  return tree.map((n) => ({
    id: n.id,
    name: n.name,
    children: [...n.sectionGroups.map(groupNode), ...n.sections.map((s) => ({ id: s.id, name: s.name, children: [] }))],
  }))
}

/** Section ids under a node (a section is its own only leaf). Groups without sections have none. */
function leaves(node: Node, isSection: (n: Node) => boolean): string[] {
  return isSection(node) ? [node.id] : node.children.flatMap((c) => leaves(c, isSection))
}

const ERROR_TEXT = (e: unknown): string => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))

export function ImportDialog({ onClose, initial = 'graph' }: { onClose: () => void; initial?: 'graph' | 'backup' }) {
  const [stage, setStage] = useState<Stage>({ kind: 'loading' })
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<ImportProgress | null>(null)

  const chooseBackup = useCallback(async () => {
    setError(null)
    setStage({ kind: 'backup', pick: null })
    try {
      const pick = await window.slate.onenote.pickBackup()
      if (!pick) return onClose()
      setStage({ kind: 'backup', pick })
    } catch (e) {
      setError(ERROR_TEXT(e))
    }
  }, [onClose])

  const refresh = useCallback(async () => {
    setError(null)
    if (initial === 'backup') return void chooseBackup()
    try {
      const status: OneNoteStatus = await window.slate.onenote.status()
      if (!status.configured) return setStage({ kind: 'not-configured' })
      if (!status.signedIn) return setStage({ kind: 'signed-out' })
      setStage({ kind: 'picker', account: status.account, tree: null })
      const tree = await window.slate.onenote.tree()
      setStage({ kind: 'picker', account: status.account, tree })
    } catch (e) {
      setError(ERROR_TEXT(e))
    }
  }, [initial, chooseBackup])

  useEffect(() => void refresh(), [refresh])
  useEffect(() => window.slate.onenote.onProgress(setProgress), [])

  const running = stage.kind === 'running'
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && !running && onClose()
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose, running])

  const run = async (go: () => Promise<ImportProgress>, backTo?: Stage) => {
    setProgress(null)
    setError(null)
    setStage({ kind: 'running' })
    try {
      setStage({ kind: 'report', result: await go() })
    } catch (e) {
      setError(ERROR_TEXT(e))
      if (backTo) setStage(backTo)
      else void refresh()
    }
  }

  return (
    <div className="import-backdrop">
      <section className="import-dialog" data-testid="import-dialog" role="dialog" aria-label="Import from OneNote">
        <header>
          <h2>Import from OneNote</h2>
          {!running && (
            <button type="button" data-testid="import-close" onClick={onClose} aria-label="Close">
              ✕
            </button>
          )}
        </header>
        {error && (
          <p className="import-error" role="alert">
            {error}
          </p>
        )}
        {stage.kind === 'loading' && <p className="muted">Checking your Microsoft account…</p>}
        {stage.kind === 'backup' && (
          <BackupPicker
            pick={stage.pick}
            onStart={(ids) => {
              const paths = stage.pick!.paths
              // A failed start returns to this list, not to the Graph sign-in.
              void run(() => window.slate.onenote.startBackup(paths, ids), stage)
            }}
          />
        )}
        {(stage.kind === 'not-configured' || stage.kind === 'signed-out' || stage.kind === 'picker') && (
          <p className="import-alt">
            No Microsoft account?{' '}
            <button type="button" className="link" data-testid="import-from-backup" onClick={() => void chooseBackup()}>
              Import from OneNote backup files
            </button>
          </p>
        )}
        {stage.kind === 'not-configured' && <NotConfigured onSaved={refresh} />}
        {stage.kind === 'signed-out' && (
          <div className="import-body">
            <p>Slate reads your notebooks through Microsoft Graph. Nothing in OneNote is changed.</p>
            <button
              type="button"
              className="primary"
              data-testid="import-sign-in"
              onClick={() =>
                void window.slate.onenote.signIn().then(refresh, (e: unknown) => setError(ERROR_TEXT(e)))
              }
            >
              Sign in with Microsoft
            </button>
          </div>
        )}
        {stage.kind === 'picker' && (
          <Picker
            account={stage.account}
            tree={stage.tree}
            onSignOut={() => void window.slate.onenote.signOut().then(refresh)}
            onStart={(ids) => void run(() => window.slate.onenote.start(ids))}
          />
        )}
        {stage.kind === 'running' && <Running progress={progress} />}
        {stage.kind === 'report' && (
          <Report result={stage.result} onRetry={() => void run(() => window.slate.onenote.retryFailed())} onDone={onClose} />
        )}
      </section>
    </div>
  )
}

function NotConfigured({ onSaved }: { onSaved: () => void }) {
  const [id, setId] = useState('')
  return (
    <div className="import-body">
      <p>Importing needs your own Azure app registration (free, about two minutes):</p>
      <ol>
        <li>
          Open <strong>portal.azure.com</strong> and go to <strong>App registrations</strong>.
        </li>
        <li>
          Choose <strong>New registration</strong> and give it any name, such as “Slate”.
        </li>
        <li>
          Under supported account types, pick <strong>Accounts in any organizational directory and personal Microsoft accounts</strong>.
        </li>
        <li>
          Add the redirect URI <strong>Public client/native</strong> → <code>http://localhost</code>, then register.
        </li>
        <li>
          Copy the <strong>Application (client) ID</strong> from the overview and paste it here.
        </li>
      </ol>
      <form
        className="import-client-id"
        onSubmit={(e) => {
          e.preventDefault()
          if (id.trim()) void window.slate.onenote.setClientId(id.trim()).then(onSaved)
        }}
      >
        <input
          data-testid="import-client-id"
          value={id}
          onChange={(e) => setId(e.target.value)}
          placeholder="00000000-0000-0000-0000-000000000000"
          spellCheck={false}
          autoComplete="off"
          aria-label="Application (client) ID"
        />
        <button type="submit" className="primary" disabled={!id.trim()}>
          Save
        </button>
      </form>
    </div>
  )
}

function Picker({ account, tree, onSignOut, onStart }: { account?: string; tree: OneNoteNotebook[] | null; onSignOut: () => void; onStart: (ids: string[]) => void }) {
  const [checked, setChecked] = useState<Set<string>>(new Set())
  if (!tree) return <p className="muted">Loading your notebooks…</p>
  const sectionIds = new Set(tree.flatMap(function all(n: OneNoteNotebook | OneNoteSectionGroup): string[] {
    return [...n.sections.map((s) => s.id), ...n.sectionGroups.flatMap(all)]
  }))
  const isSection = (n: Node) => sectionIds.has(n.id)

  const toggle = (node: Node) => {
    const ids = leaves(node, isSection)
    const all = ids.length > 0 && ids.every((id) => checked.has(id))
    const next = new Set(checked)
    for (const id of ids) {
      if (all) next.delete(id)
      else next.add(id)
    }
    setChecked(next)
  }

  const render = (node: Node, depth: number) => {
    const ids = leaves(node, isSection)
    const count = ids.filter((id) => checked.has(id)).length
    const state = ids.length > 0 && count === ids.length ? 'true' : count > 0 ? 'mixed' : 'false'
    return (
      <li key={node.id} role="none">
        <div
          role="treeitem"
          aria-checked={state}
          aria-label={node.name}
          aria-selected={false}
          tabIndex={0}
          className="import-tree-row"
          style={{ paddingLeft: 8 + depth * 18 }}
          onClick={() => toggle(node)}
          onKeyDown={(e) => {
            if (e.key === ' ' || e.key === 'Enter') {
              e.preventDefault()
              toggle(node)
            }
          }}
        >
          <span className={`import-check is-${state}`} aria-hidden="true" />
          <span>{node.name}</span>
        </div>
        {node.children.length > 0 && <ul role="group">{node.children.map((c) => render(c, depth + 1))}</ul>}
      </li>
    )
  }

  const n = checked.size
  return (
    <div className="import-body">
      <p className="import-account">
        Signed in as <strong>{account}</strong> ·{' '}
        <button type="button" className="link" data-testid="import-sign-out" onClick={onSignOut}>
          Sign out
        </button>
      </p>
      {tree.length === 0 ? (
        <p className="muted">This account has no OneNote notebooks.</p>
      ) : (
        <ul className="import-tree" role="tree" aria-label="OneNote notebooks">
          {toNodes(tree).map((node) => render(node, 0))}
        </ul>
      )}
      <footer>
        <button type="button" className="primary" data-testid="import-start" disabled={n === 0} onClick={() => onStart([...checked])}>
          Import {n} {n === 1 ? 'section' : 'sections'}
        </button>
      </footer>
    </div>
  )
}

function BackupPicker({ pick, onStart }: { pick: BackupPick | null; onStart: (ids: string[]) => void }) {
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set())
  if (!pick) return <p className="muted">Choose your OneNote backup files…</p>
  if (pick.sections.length === 0) return <p className="muted">No OneNote sections (.one files) were found there.</p>
  const ids = pick.sections.filter((s) => !unchecked.has(s.id)).map((s) => s.id)
  const toggle = (id: string) => {
    const next = new Set(unchecked)
    if (!next.delete(id)) next.add(id)
    setUnchecked(next)
  }
  const notebooks = [...new Set(pick.sections.map((s) => s.notebook))]
  return (
    <div className="import-body" data-testid="backup-picker">
      <p>
        Slate converts each section with the <code>one2html</code> tool and imports it. The newest backup of each section is used; nothing in OneNote is changed.
      </p>
      <ul className="import-tree" role="group" aria-label="Sections in the backup">
        {notebooks.map((nb) => (
          <li key={nb} role="none">
            <div className="import-tree-row import-nb">
              <strong>{nb}</strong>
            </div>
            <ul role="group">
              {pick.sections
                .filter((s) => s.notebook === nb)
                .map((s) => {
                  const on = !unchecked.has(s.id)
                  return (
                    <li key={s.id} role="none">
                      <div
                        role="checkbox"
                        aria-checked={on}
                        aria-label={s.name}
                        tabIndex={0}
                        className="import-tree-row"
                        style={{ paddingLeft: 26 }}
                        onClick={() => toggle(s.id)}
                        onKeyDown={(e) => {
                          if (e.key === ' ' || e.key === 'Enter') {
                            e.preventDefault()
                            toggle(s.id)
                          }
                        }}
                      >
                        <span className={`import-check is-${on}`} aria-hidden="true" />
                        <span>{s.name}</span>
                        {s.date && <span className="muted import-date">backup of {s.date}</span>}
                      </div>
                    </li>
                  )
                })}
            </ul>
          </li>
        ))}
      </ul>
      <footer>
        <button type="button" className="primary" data-testid="import-start" disabled={ids.length === 0} onClick={() => onStart(ids)}>
          Import {ids.length} {ids.length === 1 ? 'section' : 'sections'}
        </button>
      </footer>
    </div>
  )
}

function Running({ progress }: { progress: ImportProgress | null }) {
  const p = progress
  const fraction = p && p.sectionsTotal > 0 ? (p.sectionsDone + (p.pagesTotal > 0 ? p.pagesDone / p.pagesTotal : 0)) / p.sectionsTotal : 0
  return (
    <div className="import-body" data-testid="import-running">
      <progress max={1} value={Math.min(1, fraction)} />
      {p && (
        <p>
          Section {Math.min(p.sectionsDone + 1, p.sectionsTotal)} of {p.sectionsTotal} · Page {p.pagesDone} of {p.pagesTotal}
        </p>
      )}
      <p className="muted import-current">{p?.currentTitle ?? 'Starting…'}</p>
      <footer>
        <button type="button" data-testid="import-cancel" onClick={() => void window.slate.onenote.cancel()}>
          Cancel
        </button>
      </footer>
    </div>
  )
}

function Report({ result, onRetry, onDone }: { result: ImportProgress; onRetry: () => void; onDone: () => void }) {
  return (
    <div className="import-body" data-testid="import-report">
      <p data-testid="import-counts">
        {result.phase === 'cancelled' ? 'Import cancelled. ' : ''}
        {result.imported} imported · {result.skipped} skipped · {result.failed.length} failed
      </p>
      {result.failed.length > 0 && (
        <>
          <h3>Failed pages</h3>
          <ul className="import-failed">
            {result.failed.map((f) => (
              <li key={f.pageId}>
                <strong>{f.title}</strong>: {f.error}
              </li>
            ))}
          </ul>
          <button type="button" data-testid="import-retry" onClick={onRetry}>
            Retry failed
          </button>
        </>
      )}
      {result.lossy.length > 0 && (
        <>
          <h3>Couldn’t import exactly</h3>
          <ul className="import-lossy" data-testid="import-lossy">
            {result.lossy.map((l, i) => (
              <li key={i}>
                <strong>{l.title}</strong>: {l.items.join(', ')}
              </li>
            ))}
          </ul>
        </>
      )}
      <footer>
        <button type="button" className="primary" data-testid="import-done" onClick={onDone}>
          Done
        </button>
      </footer>
    </div>
  )
}
