import type { ReactNode } from 'react'

export interface SelectOption<T extends string> {
  value: T
  label: string
}

/** A label, a drop-down of options and an optional help sentence. */
export function SelectSetting<T extends string>({ testId, label, help, value, options, onChange }: {
  testId: string
  label: ReactNode
  help?: ReactNode
  value: T
  options: ReadonlyArray<SelectOption<T>>
  onChange: (value: T) => void
}) {
  return (
    <label className="settings-inline">
      <span>{label}</span>
      <select data-testid={testId} value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {help && <span className="settings-help">{help}</span>}
    </label>
  )
}
