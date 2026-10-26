import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FocusEvent, type KeyboardEvent, type MouseEvent } from 'react'
import type { PMJSON } from '@slate/core'
import { activeEditor } from './activeEditor'
import { Box } from './Box'
import { imageFilesFrom } from './images'
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

export function Canvas({ session, conflicts, onConflictClick }: CanvasProps) {
  const boxes = useSyncExternalStore(session.subscribe, session.getBoxes)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null)
  const [caret, setCaretState] = useState<Point | null>(null)
  // Mirrors of state for the document paste listener and the synchronous keystroke path.
  const caretRef = useRef<Point | null>(null)
  const queueRef = useRef<{ boxId: string; inputs: PendingInput[] } | null>(null)
  const services = useEditorServices()

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
            if (!view.isDestroyed) view.pasteText(text)
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
            : text.replace(/\r\n?/g, '\n').split('\n').map((line) => ({ type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [] }))
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
    queueRef.current = null
    setFocusId(null)
    setCaret(pointFrom(e))
    // Focusing the canvas blurs any box editor, which removes that box if it was left empty.
    e.currentTarget.focus({ preventScroll: true })
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
        className="slate-canvas"
        data-testid="canvas"
        tabIndex={-1}
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
            />
          ))}
      </div>
    </div>
  )
}
