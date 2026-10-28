import { useState } from 'react'
import { NOTEBOOK_SCOPE } from '@slate/core'
import type { Library, NotebookEntry } from '../library'
import { cls } from '../treeUtils'
import { accessItems, accessTitle } from './accessMenu'
import { InlineRename } from './InlineRename'

interface Props {
  library: Library
  current: NotebookEntry
  onSelect: (notebookId: string) => void
  onImport: () => void
}

export function NotebookPicker({ library, current, onSelect, onImport }: Props) {
  const [open, setOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [armedDelete, setArmedDelete] = useState(false)
  const close = () => {
    setOpen(false)
    setArmedDelete(false)
  }
  const notebookAccess = current.doc.accessOf(NOTEBOOK_SCOPE)
  return (
    <div className="notebook-picker">
      {renaming ? (
        <InlineRename
          value={current.doc.name}
          onCommit={(name) => {
            current.doc.rename(name)
            setRenaming(false)
          }}
          onCancel={() => setRenaming(false)}
        />
      ) : (
        <button type="button" className="notebook-current" data-testid="notebook-picker" onClick={() => setOpen((o) => !o)}>
          <span className="label" title={current.doc.name}>{current.doc.name}</span>
          {notebookAccess && (
            <span className="ai-badge" data-testid="ai-badge" title={accessTitle(notebookAccess)}>
              AI
            </span>
          )}
          <span className="chevron">▾</span>
        </button>
      )}
      {open && (
        <div className="notebook-menu" role="menu">
          {library.notebooks().map((n) => (
            <button
              key={n.id}
              type="button"
              role="menuitem"
              className={cls(n.id === current.id && 'selected')}
              onClick={() => {
                onSelect(n.id)
                close()
              }}
            >
              {n.doc.name}
            </button>
          ))}
          <hr />
          <button
            type="button"
            role="menuitem"
            data-testid="new-notebook"
            onClick={() => {
              onSelect(library.createNotebook('New notebook').id)
              close()
              setRenaming(true)
            }}
          >
            New notebook
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="import-onenote"
            onClick={() => {
              close()
              onImport()
            }}
          >
            Import from OneNote…
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              close()
              setRenaming(true)
            }}
          >
            Rename notebook
          </button>
          {accessItems(current.doc, NOTEBOOK_SCOPE).map((item) =>
            'onSelect' in item ? (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                onClick={() => {
                  item.onSelect()
                  close()
                }}
              >
                {item.label}
              </button>
            ) : null,
          )}
          <button
            type="button"
            role="menuitem"
            className="danger"
            onClick={() => {
              if (!armedDelete) return setArmedDelete(true)
              void library.deleteNotebook(current.id)
              close()
            }}
          >
            {armedDelete ? 'Click again to delete notebook' : 'Delete notebook'}
          </button>
        </div>
      )}
    </div>
  )
}
