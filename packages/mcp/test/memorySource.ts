import { NotebookDoc, PageDoc, writeContent } from '@slate/core'
import type { AuditEntry, DocSource } from '../src/source'

/** An in-memory DocSource with the same doc-id conventions as the desktop store. */
export function memorySource() {
  const docs = new Map<string, Uint8Array[]>()
  const audits: AuditEntry[] = []
  const save = (docId: string, update: Uint8Array) => {
    docs.set(docId, [...(docs.get(docId) ?? []), update])
  }
  const source: DocSource = {
    notebooks: async () =>
      [...docs.keys()].filter((k) => k.startsWith('notebook:')).map((k) => ({ id: k.slice('notebook:'.length), doc: NotebookDoc.fromUpdates(docs.get(k)!) })),
    loadPage: async (pageId) => PageDoc.fromUpdates(docs.get(`page:${pageId}`) ?? []),
    save: async (docId, update) => save(docId, update),
    audit: async (entry) => {
      audits.push(entry)
    },
  }
  /** Seeds one notebook "Work" with section "Ops" holding page "Deploy" (one public, one private box). */
  function seed() {
    const nb = NotebookDoc.create('Work')
    const ops = nb.addSection('Ops')
    const other = nb.addSection('Personal')
    const deploy = nb.addPage(ops, 'Deploy')
    const diary = nb.addPage(other, 'Diary')
    save('notebook:nb1', nb.doc.export({ mode: 'snapshot' }))
    const page = new PageDoc()
    const pub = page.addBox({ x: 0, y: 0, width: 300 })
    writeContent(page.contentMap(pub)!, [{ type: 'paragraph', content: [{ type: 'text', text: 'kubectl rollout status' }] }])
    const priv = page.addBox({ x: 0, y: 200, width: 300 })
    writeContent(page.contentMap(priv)!, [{ type: 'paragraph', content: [{ type: 'text', text: 'API_KEY=hunter2' }] }])
    page.doc.commit()
    page.updateBox(priv, { private: true })
    save(`page:${deploy.pageId}`, page.doc.export({ mode: 'snapshot' }))
    const diaryPage = new PageDoc()
    const d = diaryPage.addBox({ x: 0, y: 0, width: 300 })
    writeContent(diaryPage.contentMap(d)!, [{ type: 'paragraph', content: [{ type: 'text', text: 'kubectl dreams' }] }])
    diaryPage.doc.commit()
    save(`page:${diary.pageId}`, diaryPage.doc.export({ mode: 'snapshot' }))
    /** Grants in tests go through a saved update, as the app would make them. */
    const grant = (target: string, access: 'read' | 'readwrite' | null) => {
      const current = NotebookDoc.fromUpdates(docs.get('notebook:nb1')!)
      const from = current.doc.oplogVersion()
      current.setAccess(target as never, access)
      save('notebook:nb1', current.doc.export({ mode: 'update', from }))
    }
    return { ops, other, deploy, diary, grant }
  }
  return { source, docs, audits, seed }
}
