import { useState, type MouseEvent } from 'react'
import type { NotebookDoc, TreeItem } from '@slate/core'
import { cls } from '../treeUtils'
import { ContextMenu, type MenuState } from './ContextMenu'
import { applyDrop, DRAG_MIME, dropZone, type DropZone, type NodeId } from './dnd'
import { accessItems, accessTitle } from './accessMenu'
import { InlineRename } from './InlineRename'

interface Props {
  nb: NotebookDoc
  section: TreeItem | undefined
  selectedPageId: string | null
  onSelect: (pageTreeId: string) => void
  onDeleted: (pageIds: string[]) => void
}

export function PageList({ nb, section, selectedPageId, onSelect, onDeleted }: Props) {
  const [renaming, setRenaming] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [hint, setHint] = useState<{ id: string; zone: DropZone } | null>(null)
  const pages = section?.children.filter((c) => c.kind === 'page') ?? []

  const openMenu = (e: MouseEvent, page: TreeItem) => {
    e.preventDefault()
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Rename', onSelect: () => setRenaming(page.id) },
        { label: 'Make subpage', onSelect: () => nb.setLevel(page.id, page.level + 1) },
        { label: 'Promote subpage', onSelect: () => nb.setLevel(page.id, page.level - 1) },
        ...accessItems(nb, page.id),
        { label: 'Delete', confirm: true, onSelect: () => onDeleted(nb.delete(page.id)) },
      ],
    })
  }

  return (
    <div className="sidebar-col">
      <ul className="tree">
        {pages.map((page) => (
          <li key={page.id}>
            <div
              className={cls('tree-row', 'page-row', page.id === selectedPageId && 'selected', hint?.id === page.id && `drop-${hint.zone}`)}
              data-testid="page-item"
              data-level={page.level}
              style={{ paddingLeft: 12 + page.level * 16 }}
              draggable
              onDragStart={(e) => e.dataTransfer.setData(DRAG_MIME, page.id)}
              onDragOver={(e) => {
                e.preventDefault()
                setHint({ id: page.id, zone: dropZone(e, false) })
              }}
              onDragLeave={() => setHint(null)}
              onDrop={(e) => {
                e.preventDefault()
                setHint(null)
                const dragged = e.dataTransfer.getData(DRAG_MIME) as NodeId
                if (dragged) applyDrop(nb, dragged, page, dropZone(e, false))
              }}
              onClick={() => onSelect(page.id)}
              onDoubleClick={() => setRenaming(page.id)}
              onContextMenu={(e) => openMenu(e, page)}
            >
              {renaming === page.id ? (
                <InlineRename
                  value={page.title}
                  onCommit={(title) => {
                    nb.setTitle(page.id, title)
                    setRenaming(null)
                  }}
                  onCancel={() => setRenaming(null)}
                />
              ) : (
                <span className="label" title={page.title || 'Untitled page'}>{page.title || 'Untitled page'}</span>
              )}
              {page.access && (
                <span className="ai-badge" data-testid="ai-badge" title={accessTitle(page.access)}>
                  AI
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
      {section && (
        <div className="sidebar-actions">
          <button type="button" data-testid="add-page" onClick={() => onSelect(nb.addPage(section.id).id)}>
            Add page
          </button>
        </div>
      )}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  )
}
