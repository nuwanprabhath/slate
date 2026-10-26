import { describe, expect, it } from 'vitest'
import { gatedNoteHandler } from './protocols'

describe('note-data protocols refuse while locked', () => {
  it('answers 423 (no-store) without calling the handler while the notes are closed, and serves once open', async () => {
    let open = false
    let calls = 0
    const handle = gatedNoteHandler(
      () => open,
      async () => {
        calls++
        return new Response('bytes')
      },
    )
    const locked = await handle(new Request('slate-blob://img/x.png'))
    expect(locked.status).toBe(423)
    expect(locked.headers.get('Cache-Control')).toBe('no-store')
    expect(calls).toBe(0)
    open = true
    expect(await (await handle(new Request('slate-blob://img/x.png'))).text()).toBe('bytes')
    expect(calls).toBe(1)
  })
})
