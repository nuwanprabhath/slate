import { describe, expect, it } from 'vitest'
import { reportFor } from './diagnosticsErrors'

describe('reportFor', () => {
  it('keeps the error name and stack frames, never the message', () => {
    const e = new TypeError('cannot read "my private note"')
    const r = reportFor('error', e)
    expect(r.name).toBe('TypeError')
    expect(JSON.stringify(r)).not.toContain('private note')
    expect(r.frames.every((f) => f.startsWith('at '))).toBe(true)
  })
  it('describes a non-error rejection by its type only', () => {
    expect(reportFor('unhandledrejection', 'some text the user typed')).toEqual({ kind: 'unhandledrejection', name: 'string', frames: [] })
  })
})
