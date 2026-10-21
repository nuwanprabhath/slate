import { useState, type MouseEvent, type ReactNode } from 'react'
import { SECTION_COLORS, type NotebookDoc, type TreeItem } from '@slate/core'
import { cls } from '../treeUtils'
import { ContextMenu, type MenuItem, type MenuState } from './ContextMenu'
import { applyDrop, DRAG_MIME, dropZone, type DropZone, type NodeId } from './dnd'
import { InlineRename } from './InlineRename'

interface Props {
  nb: NotebookDoc
  items: TreeItem[]
  selectedSectionId: string | null
  onSelect: (sectionId: string) => void
  onDeleted: (pageIds: string[]) => void
}

export function SectionList({ nb, items, selectedSectionId, onSelect, onDeleted }: Props) {
  const [renaming, setRenaming] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [hint, setHint] = useState<{ id: string; zone: DropZone } | null>(null)

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })

  const addSection = (parent?: NodeId) => {
    const id = nb.addSection('New section', parent)
    nb.addPage(id)
    onSelect(id)
    setRenaming(id)
  }

  const openMenu = (e: MouseEvent, item: TreeItem) => {
    e.preventDefault()
    const entries: MenuItem[] = [{ label: 'Rename', onSelect: () => setRenaming(item.id) }]
    if (item.kind === 'section') entries.push({ swatches: SECTION_COLORS, onPick: (c) => nb.setColor(item.id, c) })
    if (item.kind === 'sectionGroup') entries.push({ label: 'New section in group', onSelect: () => addSection(item.id) })
    entries.push({ label: 'Delete', confirm: true, onSelect: () => onDeleted(nb.delete(item.id)) })
    setMenu({ x: e.clientX, y: e.clientY, items: entries })
  }

  const renderItem = (item: TreeItem, depth: number): ReactNode => {
    if (item.kind === 'page') return null
    const isGroup = item.kind === 'sectionGroup'
    const open = !collapsed.has(item.id)
    return (
      <li key={item.id}>
        <div
          className={cls('tree-row', item.id === selectedSectionId && 'selected', hint?.id === item.id && `drop-${hint.zone}`)}
          data-testid={isGroup ? 'group-item' : 'section-item'}
          style={{ paddingLeft: 8 + depth * 14 }}
          draggable
          onDragStart={(e) => e.dataTransfer.setData(DRAG_MIME, item.id)}
          onDragOver={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setHint({ id: item.id, zone: dropZone(e, isGroup) })
          }}
          onDragLeave={() => setHint(null)}
          onDrop={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setHint(null)
            const dragged = e.dataTransfer.getData(DRAG_MIME) as NodeId
            if (!dragged) return
            const zone = nb.get(dragged)?.kind === 'page' ? 'inside' : dropZone(e, isGroup)
            applyDrop(nb, dragged, item, zone)
          }}
          onClick={() => (isGroup ? toggle(item.id) : onSelect(item.id))}
          onDoubleClick={() => setRenaming(item.id)}
          onContextMenu={(e) => openMenu(e, item)}
        >
          {isGroup ? <span className="chevron">{open ? '▾' : '▸'}</span> : <span className="color-bar" style={{ background: item.color ?? SECTION_COLORS[0] }} />}
          {renaming === item.id ? (
            <InlineRename
              value={item.title}
              onCommit={(title) => {
                nb.setTitle(item.id, title)
                setRenaming(null)
              }}
              onCancel={() => setRenaming(null)}
            />
          ) : (
            <span className="label">{item.title}</span>
          )}
        </div>
        {isGroup && open && <ul>{item.children.map((c) => renderItem(c, depth + 1))}</ul>}
      </li>
    )
  }

  return (
    <div className="sidebar-col">
      <ul
        className="tree"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          // Dropped on empty space: move the section/group to the end of the notebook root.
          const dragged = e.dataTransfer.getData(DRAG_MIME) as NodeId
          if (dragged && nb.get(dragged)?.kind !== 'page') {
            try {
              nb.moveInto(dragged, undefined)
            } catch {
              // not movable to root
            }
          }
        }}
      >
        {items.map((i) => renderItem(i, 0))}
      </ul>
      <div className="sidebar-actions">
        <button type="button" data-testid="add-section" onClick={() => addSection()}>
          Add section
        </button>
        <button type="button" className="secondary" data-testid="add-group" onClick={() => setRenaming(nb.addSectionGroup('New group'))}>
          Add group
        </button>
      </div>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  )
}
