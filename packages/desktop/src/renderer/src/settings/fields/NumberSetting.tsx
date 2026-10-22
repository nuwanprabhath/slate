/** A typed value that is not a number falls back to `min`; one out of range is clamped into it. */
export function clampInt(raw: string, min: number, max: number): number {
  const n = Number(raw)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : min
}

/** A label, a whole-number input clamped to [min, max], and a unit after it. */
export function NumberSetting({ testId, label, unit, min, max, value, onChange }: {
  testId: string
  label: string
  unit?: string
  min: number
  max: number
  value: number
  onChange: (value: number) => void
}) {
  return (
    <label className="settings-inline">
      <span>{label}</span>
      <input type="number" data-testid={testId} min={min} max={max} value={value} onChange={(e) => onChange(clampInt(e.target.value, min, max))} />
      {unit && <span>{unit}</span>}
    </label>
  )
}
