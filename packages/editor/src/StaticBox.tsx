import { useLayoutEffect, useRef } from 'react'
import { LoroMap, type ContainerID, type LoroDoc } from 'loro-crdt'
import { onThemeChange } from './colorContrast'
import { schema } from './extensions'
import { renderStaticHtml } from './staticRender'

interface Props {
  doc: LoroDoc
  contentId: ContainerID
  onActivate: () => void
}

/** Lightweight rendering for off-screen boxes; becomes a real editor when scrolled into view or clicked. */
export function StaticBox({ doc, contentId, onActivate }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current!
    const render = () => {
      const fragment = renderStaticHtml(schema, doc, contentId, document)
      el.replaceChildren(...(fragment ? [fragment] : []))
    }
    render()
    const offTheme = onThemeChange(render)
    const container = doc.getContainerById(contentId)
    const offDoc = container instanceof LoroMap ? container.subscribe(render) : undefined
    return () => {
      offTheme()
      offDoc?.()
    }
  }, [doc, contentId])
  return (
    <div
      ref={ref}
      className="slate-box-content"
      data-testid="box-static"
      onMouseDown={(e) => {
        e.preventDefault()
        onActivate()
      }}
    />
  )
}
