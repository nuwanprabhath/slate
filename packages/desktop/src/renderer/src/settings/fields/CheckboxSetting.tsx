import type { ReactNode } from 'react'

/** A checkbox, a bold label and a help sentence under it. */
export function CheckboxSetting({ testId, label, help, checked, onChange, disabled }: {
  testId: string
  label: ReactNode
  help?: ReactNode
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}) {
  return (
    <label className="settings-row">
      <input type="checkbox" data-testid={testId} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <strong>{label}</strong>
        {help && <span className="settings-help">{help}</span>}
      </span>
    </label>
  )
}
