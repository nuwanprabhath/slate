import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { builtinTheme } from '../../shared/theme/builtins'
import { DocStore } from '../store'
import { ThemeGenerator, type ThemeRunner } from './themeGenerator'
import { ThemeStore } from './themeStore'

const dirs: string[] = []
function tempStore(): DocStore {
  const dir = mkdtempSync(join(tmpdir(), 'slate-themes-'))
  dirs.push(dir)
  return new DocStore(join(dir, 'slate.db'))
}
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

const nord = builtinTheme('builtin:nord')!.spec

describe('ThemeStore', () => {
  it('validates on save and keeps themes in the database across instances', () => {
    const db = tempStore()
    const store = new ThemeStore(db)
    const saved = store.save({ ...nord, name: 'Mine', palette: { ...nord.palette, text: 'url(evil)', nope: '#fff' } }, 'calm')
    expect(saved.id).toMatch(/^user:/)
    expect(saved.spec.palette.text).toBeUndefined()
    expect(saved.prompt).toBe('calm')
    expect(Object.keys(saved.spec.palette)).not.toContain('nope')
    expect(new ThemeStore(db).list()).toEqual([saved])
  })

  it('re-validates on load and drops what cannot be read', () => {
    const db = tempStore()
    db.setSetting('themes', [
      { id: 'user:a', name: 'A', prompt: null, createdAt: 1, spec: { ...nord, palette: { text: 'javascript:1' } } },
      { id: 42, spec: {} },
      'junk',
    ])
    const list = new ThemeStore(db).list()
    expect(list).toHaveLength(1)
    expect(list[0]!.spec.palette.text).toBeUndefined()
    expect(list[0]!.spec.font).toBe('system')
  })

  it('renames, duplicates and deletes', () => {
    const store = new ThemeStore(tempStore())
    const a = store.save(nord)
    expect(store.rename(a.id, '  Night  ').name).toBe('Night')
    expect(store.list()[0]!.spec.name).toBe('Night')
    store.remove(a.id)
    expect(store.list()).toEqual([])
    expect(() => store.rename('builtin:dark', 'x')).toThrow()
  })
})

function stubRunner(reply: (prompt: string) => Promise<string>): ThemeRunner & { prompts: string[]; cancelled: number } {
  const r = {
    prompts: [] as string[],
    cancelled: 0,
    busy: false,
    async run(req: { prompt: string }) { r.prompts.push(req.prompt); return reply(req.prompt) },
    cancel() { r.cancelled += 1 },
  }
  return r
}

describe('ThemeGenerator', () => {
  it('validates what Claude designs', async () => {
    const runner = stubRunner(async () => JSON.stringify({ structured_output: { name: 'Forest', palette: { page: '#10241aff', text: '#203020' }, material: 'solid', texture: 'none', font: 'system', effects: [] } }))
    const { spec, note } = await new ThemeGenerator({ runner }).generate({ request: 'calm forest', current: null })
    expect(spec.name).toBe('Forest')
    expect(note).toContain('adjusted for readability')
    expect(runner.prompts[0]).toContain('calm forest')
  })

  it('says so when the reply has no theme in it', async () => {
    const runner = stubRunner(async () => 'not json at all')
    await expect(new ThemeGenerator({ runner }).generate({ request: 'x', current: null })).rejects.toThrow(/no theme/)
  })

  it('refuses an empty description', async () => {
    const runner = stubRunner(async () => '{}')
    await expect(new ThemeGenerator({ runner }).generate({ request: '  ', current: null })).rejects.toThrow(/Describe/)
  })

  it('passes a timeout on, and its error through', async () => {
    let timeout = 0
    const runner = stubRunner(async () => '')
    runner.run = async (req: { prompt: string; timeoutMs: number }) => { timeout = req.timeoutMs; throw new Error('Claude took too long to answer.') }
    await expect(new ThemeGenerator({ runner }).generate({ request: 'x', current: null })).rejects.toThrow(/too long/)
    expect(timeout).toBe(150_000)
  })
})
