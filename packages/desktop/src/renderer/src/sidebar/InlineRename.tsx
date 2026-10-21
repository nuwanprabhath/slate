import { useState } from 'react'

interface Props {
  value: string
  onCommit: (value: string) => void
  onCancel: () => void
}

export function InlineRename({ value, onCommit, onCancel }: Props) {
  const [text, setText] = useState(value)
  const commit = () => onCommit(text.trim() || value)
  return (
    <input
      className="inline-rename"
      data-testid="inline-rename"
      autoFocus
      spellCheck={false}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => e.target.select()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') onCancel()
      }}
      onBlur={commit}
      onClick={(e) => e.stopPropagation()}
    />
  )
}
