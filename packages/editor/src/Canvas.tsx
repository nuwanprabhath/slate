import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FocusEvent, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'
import type { PMJSON } from '@slate/core'
import { activeEditor } from './activeEditor'
import { Box, type GroupDrag } from './Box'
import { CanvasMenu } from './CanvasMenu'
import { imageFilesFrom } from './images'
import { linkedTextBlocks, pastePlain } from './links'
import type { PageSession } from './PageSession'
import { useEditorServices } from './services'
import './canvas.css'

interface CanvasProps {
  session: PageSession
  /** Boxes whose edits were merged with another device's: they show a "merged edits" chip. */
  conflicts?: Set<string>
  onConflictClick?: (boxId: string) => void
}

type Point = { x: number; y: number }
/** Input that reached the canvas before the box it creates had a focused editor. */
type PendingInput = { text: string } | { enter: true } | { html: string; plain: string } | { readClipboard: true }

const isMod = (e: KeyboardEvent) => e.metaKey || e.ctrlKey
/** Cmd on macOS, Ctrl elsewhere: the multi-select modifier, as in the platform's file managers. */
const isSelectMod = (e: { metaKey: boolean; ctrlKey: boolean }) => (navigator.platform.startsWith('Mac') ? e.metaKey : e.ctrlKey)
/** `.slate-box-bar`'s height in canvas.css. */
const HANDLE_HEIGHT = 18
const NO_SELECTION: ReadonlySet<string> = new Set()

export function Canvas({ session, conflicts, onConflictClick }: CanvasProps) {
  const boxes = useSyncExternalStore(session.subscribe, session.getBoxes)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null)
  const [caret, setCaretState] = useState<Point | null>(null)
  // Mirrors of state for the document paste listener and the synchronous keystroke path.
  const caretRef = useRef<Point | null>(null)
  const queueRef = useRef<{ boxId: string; inputs: PendingInput[] } | null>(null)
  const services = useEditorServices()
  const [selection, setSelection] = useState<ReadonlySet<string>>(NO_SELECTION)
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  const [groupDrag, setGroupDrag] = useState<GroupDrag | null>(null)
  const [menu, setMenu] = useState<Point | null>(null)
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])

  // Back to front: each box's place in the stack (z, then id), so overlapping boxes layer the same everywhere.
  const layers = useMemo(() => {
    const order = [...boxes].sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    return new Map(order.map((b, i) => [b.id, i + 1]))
  }, [boxes])

  // A handle bar stacks above every box body, so where one lies over another box it would catch
  // clicks on that box's text unseen: those handles are always drawn.
  const coveringHandles = useMemo(() => {
    const out = new Set<string>()
    for (const b of boxes) {
      const top = b.y - HANDLE_HEIGHT
      for (const o of boxes) {
        if (o.id === b.id) continue
        const oh = Math.max(session.heightOf(o.id) ?? 0, o.height ?? 0)
        if (b.x < o.x + o.width && o.x < b.x + b.width && top < o.y + oh && o.y < b.y) {
          out.add(b.id)
          break
        }
      }
    }
    return out
  }, [boxes, session])

  // A selected box that was deleted (here, by undo or on another device) leaves the selection.
  useEffect(() => {
    if (selection.size === 0) return
    const live = new Set(boxes.map((b) => b.id))
    if ([...selection].some((id) => !live.has(id))) setSelection(new Set([...selection].filter((id) => live.has(id))))
  }, [boxes, selection])

  const onBoxPress = useCallback((id: string, e: PointerEvent<HTMLElement>): boolean => {
    const target = e.target as HTMLElement
    if (isSelectMod(e) && !target.closest('a, button')) {
      const next = new Set(selectionRef.current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      setSelection(next)
      // Out of the text, so Delete and Escape act on the selection and cannot edit text.
      canvasRef.current?.focus({ preventScroll: true })
      return true
    }
    // A plain press on a selected box's handle drags the selection; anywhere else it selects only that box.
    const onHandle = target.closest('.slate-box-handle') !== null
    if (!(onHandle && selectionRef.current.has(id)) && selectionRef.current.size > 0) setSelection(NO_SELECTION)
    return false
  }, [])

  const onGroupDrag = useCallback(
    (drag: GroupDrag | null, commit: boolean) => {
      if (!commit) {
        setGroupDrag(drag)
        return
      }
      setGroupDrag(null)
      if (!drag || (drag.dx === 0 && drag.dy === 0)) return
      const patches = new Map<string, { x: number; y: number }>()
      for (const b of session.getBoxes()) {
        if (selectionRef.current.has(b.id)) patches.set(b.id, { x: Math.max(0, Math.round(b.x + drag.dx)), y: Math.max(0, Math.round(b.y + drag.dy)) })
      }
      session.updateBoxes(patches)
    },
    [session],
  )

  useEffect(() => {
    if (selection.size === 0) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelection(NO_SELECTION)
        return
      }
      // Only while no text has focus (a Cmd/Ctrl+click moves focus to the canvas), so these keys never eat text.
      if ((e.key === 'Delete' || e.key === 'Backspace') && document.activeElement === canvasRef.current) {
        e.preventDefault()
        session.deleteBoxes([...selectionRef.current])
        setSelection(NO_SELECTION)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selection, session])

  const setCaret = (p: Point | null) => {
    caretRef.current = p
    setCaretState(p)
  }

  /** Makes a box at the caret; what was typed waits in the queue until its editor takes focus. */
  const startBox = useCallback(
    (input?: PendingInput) => {
      const at = caretRef.current!
      const boxId = session.createBox(at.x, at.y)
      queueRef.current = { boxId, inputs: input ? [input] : [] }
      setCaret(null)
      setFocusId(boxId)
    },
    [session],
  )

  const onBoxFocus = useCallback(
    (id: string) => {
      setCaret(null)
      setFocusId(id)
      const queue = queueRef.current
      if (queue?.boxId !== id) return
      queueRef.current = null
      const view = activeEditor.get()?.view
      if (!view) return
      for (const input of queue.inputs) {
        if ('text' in input) view.dispatch(view.state.tr.insertText(input.text))
        else if ('enter' in input) activeEditor.get()!.commands.splitBlock()
        else if ('html' in input) {
          if (input.html) view.pasteHTML(input.html)
          else view.pasteText(input.plain)
        } else
          void services.readClipboardText().then((text) => {
            if (!view.isDestroyed) pastePlain(view, text)
          })
      }
    },
    [services],
  )

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.closest('.slate-box, input, textarea, [contenteditable="true"]')) return
      const at = caretRef.current
      const files = imageFilesFrom(e.clipboardData)
      const text = e.clipboardData?.getData('text/plain') ?? ''
      const html = e.clipboardData?.getData('text/html') ?? ''
      if (files.length === 0 && text.trim() === '' && html.trim() === '') return
      e.preventDefault()
      if (at && files.length === 0) {
        // Text goes through the box editor's own paste path, so it is cleaned like any other paste.
        startBox({ html, plain: text })
        return
      }
      const x = at?.x ?? 40
      const y = at?.y ?? (scrollRoot?.scrollTop ?? 0) + 40
      setCaret(null)
      void (async () => {
        const blocks: PMJSON[] =
          files.length > 0
            ? await Promise.all(files.map(async (f) => ({ type: 'image', attrs: { src: await services.putBlob(new Uint8Array(await f.arrayBuffer()), f.type) } })))
            : linkedTextBlocks(text, services.linkPastedUrls)
        session.createBoxWithContent(x, y, blocks)
      })()
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [session, services, scrollRoot, startBox])

  const pointFrom = (e: MouseEvent<HTMLDivElement>): Point => {
    const rect = e.currentTarget.getBoundingClientRect()
    return { x: Math.max(0, Math.round(e.clientX - rect.left)), y: Math.max(0, Math.round(e.clientY - rect.top)) }
  }

  const onMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || e.button !== 0) return
    e.preventDefault()
    setSelection(NO_SELECTION)
    queueRef.current = null
    setFocusId(null)
    setCaret(pointFrom(e))
    // Focusing the canvas blurs any box editor, which removes that box if it was left empty.
    e.currentTarget.focus({ preventScroll: true })
  }

  const onContextMenu = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY })
  }

  const onDoubleClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || e.button !== 0) return
    caretRef.current = pointFrom(e)
    startBox()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    // Undo's menu accelerator is not registered (box editors own the key), so the focused canvas must.
    const key = e.key.toLowerCase()
    if (isMod(e) && (key === 'z' || key === 'y')) {
      e.preventDefault()
      if (key === 'z' && !e.shiftKey) session.undo()
      else session.redo()
      return
    }
    const queue = queueRef.current
    if (!queue && !caretRef.current) return
    let input: PendingInput | undefined
    if (isMod(e)) {
      // Other shortcuts (undo, find, menus) must pass through untouched.
      if (!(e.shiftKey && e.key.toLowerCase() === 'v')) return
      input = { readClipboard: true }
    } else if (e.key === 'Escape') {
      if (queue) return
      setCaret(null)
      return
    } else if (e.key === 'Enter') input = queue ? { enter: true } : undefined
    else if (e.key.length === 1) input = { text: e.key }
    else if (!(e.key === 'Process' || e.nativeEvent.isComposing)) return
    e.preventDefault()
    if (queue) {
      if (input) queue.inputs.push(input)
    } else startBox(input)
  }

  const onCompositionStart = () => {
    // A composition starting on the bare canvas has nowhere to go: give it a box to land in.
    if (caretRef.current && !queueRef.current) startBox()
  }

  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && !queueRef.current) setCaret(null)
  }

  const bottom = boxes.reduce((max, b) => Math.max(max, b.y + (session.heightOf(b.id) ?? 0)), 0)
  const right = boxes.reduce((max, b) => Math.max(max, b.x + b.width), 0)
  return (
    <div className="slate-scroll" ref={setScrollRoot} data-testid="canvas-scroll">
      <div
        ref={canvasRef}
        className="slate-canvas"
        data-testid="canvas"
        tabIndex={-1}
        onContextMenu={onContextMenu}
        style={{ minHeight: bottom + 400, minWidth: right + 200 }}
        onMouseDown={onMouseDown}
        onDoubleClick={onDoubleClick}
        onKeyDown={onKeyDown}
        onCompositionStart={onCompositionStart}
        onBlur={onBlur}
      >
        {caret && <div className="slate-pending-caret" data-testid="pending-caret" style={{ left: caret.x, top: caret.y }} />}
        {scrollRoot &&
          boxes.map((b) => (
            <Box
              key={b.id}
              box={b}
              session={session}
              scrollRoot={scrollRoot}
              autoFocus={b.id === focusId}
              onFocus={onBoxFocus}
              conflict={conflicts?.has(b.id) ?? false}
              onConflictClick={onConflictClick}
              layer={layers.get(b.id) ?? 1}
              selected={selection.has(b.id)}
              handleShown={coveringHandles.has(b.id)}
              onPress={onBoxPress}
              onGroupDrag={onGroupDrag}
              groupDrag={groupDrag}
            />
          ))}
      </div>
      {menu && (
        <CanvasMenu
          at={menu}
          onClose={closeMenu}
          items={[{ label: 'Re-arrange boxes', testId: 'arrange-boxes', disabled: !session.canArrange(), onSelect: () => session.arrange() }]}
        />
      )}
    </div>
  )
}
