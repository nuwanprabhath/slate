import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { DocSource } from './source'
import { appendToPage, createPage, listTree, readPage, search } from './tools'

/** Every tool input is bounded: an unbounded string from a client is memory the app must hold. */
const MARKDOWN_MAX = 1024 * 1024
const TEXT_MAX = 1000
const ID_MAX = 128
const id = () => z.string().max(ID_MAX)

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

async function respond(run: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const value = await run()
    return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] }
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }
  }
}

export function createSlateMcpServer(src: DocSource): McpServer {
  const server = new McpServer({ name: 'slate', version: '0.1.0' })
  server.registerTool(
    'list_tree',
    { description: 'List the notebooks, sections and pages the user has shared with AI agents, with each item\'s access ("read" or "readwrite"). Use the pageId values with read_page.' },
    () => respond(() => listTree(src)),
  )
  server.registerTool(
    'read_page',
    { description: 'Read a shared page as Markdown. Boxes are separated by "---". Private boxes appear as "[private box omitted]".', inputSchema: { pageId: id() } },
    ({ pageId }) => respond(() => readPage(src, pageId)),
  )
  server.registerTool(
    'search',
    { description: 'Case-insensitive text search across shared pages. Returns page ids, titles and snippets.', inputSchema: { query: z.string().min(1).max(TEXT_MAX) } },
    ({ query }) => respond(() => search(src, query)),
  )
  server.registerTool(
    'append_to_page',
    { description: 'Add a new box with Markdown content below the existing boxes of a page shared with read & write access.', inputSchema: { pageId: id(), markdown: z.string().max(MARKDOWN_MAX) } },
    ({ pageId, markdown }) => respond(() => appendToPage(src, pageId, markdown)),
  )
  server.registerTool(
    'create_page',
    {
      description: 'Create a page in a section shared with read & write access. notebookId and sectionId come from list_tree.',
      inputSchema: { notebookId: id(), sectionId: id(), title: z.string().min(1).max(TEXT_MAX), markdown: z.string().max(MARKDOWN_MAX).optional() },
    },
    ({ notebookId, sectionId, title, markdown }) => respond(() => createPage(src, notebookId, sectionId, title, markdown)),
  )
  return server
}
