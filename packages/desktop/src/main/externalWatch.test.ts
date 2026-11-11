import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc } from 'loro-crdt'
import { createExternalWatch } from './externalWatch'
import { DocStore } from './store'

describe('createExternalWatch', () => {
  it('emits updates other processes write, grouped by document, and nothing otherwise', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'slate-watch-')), 'slate.db')
    const app = new DocStore(file)
    const cli = new DocStore(file, { compact: false })
    const seen: Array<Array<{ docId: string; updates: Uint8Array[] }>> = []
    const watch = createExternalWatch(app, (b) => seen.push(b))
    watch.check()
    expect(seen).toEqual([])
    cli.append('page:a', new Uint8Array([1]))
    cli.append('page:a', new Uint8Array([2]))
    cli.append('notebook:n', new Uint8Array([3]))
    watch.check()
    expect(seen).toHaveLength(1)
    expect(seen[0]!.map((b) => [b.docId, b.updates.map((u) => Array.from(u))])).toEqual([
      ['page:a', [[1], [2]]],
      ['notebook:n', [[3]]],
    ])
    watch.check()
    expect(seen).toHaveLength(1)
    watch.stop()
    app.close()
    cli.close()
  })

  it('delivers another connection\'s rows before compaction deletes them', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'slate-watch-')), 'slate.db')
    const cli = new DocStore(file, { compact: false })
    const doc = new LoroDoc()
    doc.getText('t').insert(0, 'cli ')
    doc.commit()
    const seen: Array<{ docId: string; updates: Uint8Array[] }> = []
    // The hook the app's wiring installs: poll once, so the rows reach the renderer while they exist.
    const app = new DocStore(file, { beforeCompact: () => watch.check() })
    const watch = createExternalWatch(app, (b) => seen.push(...b))
    cli.append('page:a', doc.export({ mode: 'update' }))
    app.compact('page:a')
    expect(seen.map((b) => b.docId)).toEqual(['page:a'])
    watch.stop()
    app.close()
    cli.close()
  })
})
