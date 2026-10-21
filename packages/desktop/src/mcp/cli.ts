import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { NotebookDoc, PageDoc } from '@slate/core'
import { createSlateMcpServer, type DocSource } from '@slate/mcp'
import { defaultUserDataDir } from '../main/paths'
import { DocStore } from '../main/store'

// stdout carries MCP protocol messages only; anything for a human goes to stderr.
async function main(): Promise<void> {
  const dir = defaultUserDataDir()
  mkdirSync(dir, { recursive: true })
  // Never compacts: the app owns compaction and may hold the same documents open.
  const store = new DocStore(join(dir, 'slate.db'), { compact: false })
  const source: DocSource = {
    notebooks: async () =>
      store.list('notebook:').map((docId) => ({ id: docId.slice('notebook:'.length), doc: NotebookDoc.fromUpdates(store.load(docId)) })),
    loadPage: async (pageId) => PageDoc.fromUpdates(store.load(`page:${pageId}`)),
    save: async (docId, update) => store.append(docId, update),
    audit: async (entry) => store.appendAudit(entry),
  }
  await createSlateMcpServer(source).connect(new StdioServerTransport())
  process.stderr.write(`slate-mcp: serving ${dir}\n`)
}

main().catch((error: unknown) => {
  process.stderr.write(`slate-mcp: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exit(1)
})
