import { randomUUID } from 'node:crypto'
import type { SavedTheme } from '../../shared/theme/resolve'
import { validateTheme } from '../../shared/theme/validate'
import type { DocStore } from '../store'

const KEY = 'themes'

type Listener = (saved: SavedTheme[]) => void

/**
 * The user's own themes, kept in the settings table under `themes`. Everything read back is
 * validated again, so a theme stored by another version (or edited by hand) can only reach a window
 * through `validateTheme`; an entry that cannot be read is dropped and the rest kept.
 */
export class ThemeStore {
  private readonly listeners = new Set<Listener>()

  constructor(private readonly db: DocStore) {}

  list(): SavedTheme[] {
    const raw = this.db.getSetting<unknown>(KEY)
    if (!Array.isArray(raw)) return []
    const out: SavedTheme[] = []
    for (const o of raw as unknown[]) {
      if (typeof o !== 'object' || o === null) continue
      const { id, prompt, createdAt, spec } = o as Record<string, unknown>
      if (typeof id !== 'string' || !id.startsWith('user:')) continue
      const valid = validateTheme(spec).spec
      out.push({ id, name: valid.name, prompt: typeof prompt === 'string' ? prompt : null, createdAt: typeof createdAt === 'number' ? createdAt : 0, spec: valid })
    }
    return out
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  save(spec: unknown, prompt: string | null = null): SavedTheme {
    const valid = validateTheme(spec).spec
    const theme: SavedTheme = { id: `user:${randomUUID()}`, name: valid.name, prompt: typeof prompt === 'string' ? prompt.slice(0, 2000) : null, createdAt: Date.now(), spec: valid }
    this.write([...this.list(), theme])
    return theme
  }

  rename(id: string, name: string): SavedTheme {
    const list = this.list()
    const t = list.find((x) => x.id === id)
    if (t === undefined) throw new Error('Only a saved theme can be renamed.')
    const spec = validateTheme({ ...t.spec, name }).spec
    const next = { ...t, name: spec.name, spec }
    this.write(list.map((x) => (x.id === id ? next : x)))
    return next
  }

  remove(id: string): void {
    this.write(this.list().filter((x) => x.id !== id))
  }

  private write(list: SavedTheme[]): void {
    this.db.setSetting(KEY, list)
    this.listeners.forEach((l) => l(list))
  }
}
