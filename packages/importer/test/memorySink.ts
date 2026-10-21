import type { ImportRecord, ImportSink, ImportState, MappedPage } from '../src/types'

export interface MemorySection {
  treeId: string
  name: string
  parent: string | null
  pages: Map<string, { title: string; level: number; page: MappedPage }>
}

export interface MemoryNotebook {
  id: string
  name: string
  groups: Map<string, { treeId: string; name: string; parent: string | null }>
  sections: Map<string, MemorySection>
}

export interface MemorySink extends ImportSink {
  notebooks: Map<string, MemoryNotebook>
  writes: number
  blobs: number
}

export function memorySink(): MemorySink {
  let nb = 0
  let sg = 0
  let s = 0
  const notebooks = new Map<string, MemoryNotebook>()
  const byId = (id: string): MemoryNotebook => {
    const n = [...notebooks.values()].find((x) => x.id === id)
    if (!n) throw new Error(`no notebook ${id}`)
    return n
  }
  const sink: MemorySink = {
    notebooks,
    writes: 0,
    blobs: 0,
    async ensureNotebook(onenoteId, name) {
      let n = notebooks.get(onenoteId)
      if (!n) {
        n = { id: `nb-${++nb}`, name, groups: new Map(), sections: new Map() }
        notebooks.set(onenoteId, n)
      }
      return n.id
    },
    async ensureGroup(notebookId, parent, onenoteId, name) {
      const n = byId(notebookId)
      let g = n.groups.get(onenoteId)
      if (!g) {
        g = { treeId: `sg-${++sg}`, name, parent }
        n.groups.set(onenoteId, g)
      }
      return g.treeId
    },
    async ensureSection(notebookId, parent, onenoteId, name) {
      const n = byId(notebookId)
      let sec = n.sections.get(onenoteId)
      if (!sec) {
        sec = { treeId: `s-${++s}`, name, parent, pages: new Map() }
        n.sections.set(onenoteId, sec)
      }
      return sec.treeId
    },
    async writePage(notebookId, sectionTreeId, onenotePageId, meta, page) {
      const sec = [...byId(notebookId).sections.values()].find((x) => x.treeId === sectionTreeId)
      if (!sec) throw new Error(`no section ${sectionTreeId}`)
      sec.pages.set(onenotePageId, { ...meta, page })
      sink.writes++
    },
    async putBlob() {
      return `slate-blob://blob/${++sink.blobs}.png`
    }
  }
  return sink
}

export function memoryState(): ImportState & { map: Map<string, ImportRecord> } {
  const map = new Map<string, ImportRecord>()
  return {
    map,
    async get(id) {
      return map.get(id)
    },
    async set(id, record) {
      map.set(id, record)
    }
  }
}
