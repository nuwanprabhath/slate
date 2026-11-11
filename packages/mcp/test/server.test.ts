import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createSlateMcpServer } from '../src/server'
import { memorySource } from './memorySource'

async function connect() {
  const mem = memorySource()
  const server = createSlateMcpServer(mem.source)
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(clientSide)
  return { client, ...mem }
}

const textOf = (r: object) => (((r as { content?: unknown }).content as Array<{ type: string; text: string }>)[0]?.text ?? '')

describe('Slate MCP server', () => {
  it('exposes exactly the five tools', async () => {
    const { client } = await connect()
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['append_to_page', 'create_page', 'list_tree', 'read_page', 'search'])
  })

  it('returns tool errors as isError results, not protocol errors', async () => {
    const { client } = await connect()
    const r = await client.callTool({ name: 'read_page', arguments: { pageId: 'missing' } })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toBe('not found or not permitted')
  })

  it('reads a granted page end to end', async () => {
    const { client, seed } = await connect()
    const { ops, deploy, grant } = seed()
    grant(ops, 'read')
    const r = await client.callTool({ name: 'read_page', arguments: { pageId: deploy.pageId } })
    expect(textOf(r)).toContain('kubectl rollout status')
    expect(textOf(r)).not.toContain('hunter2')
  })
})

describe('input bounds (A2)', () => {
  it('refuses a markdown body over 1 MiB, a query or title over 1,000 characters and an id over 128', async () => {
    const { client, seed } = await connect()
    const { ops, deploy, grant } = seed()
    grant(ops, 'readwrite')
    const tooBig = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: args })
      expect(r.isError, name).toBe(true)
      expect(textOf(r), name).toMatch(/Too big|validation/)
    }
    await tooBig('append_to_page', { pageId: deploy.pageId, markdown: 'x'.repeat(1024 * 1024 + 1) })
    await tooBig('search', { query: 'q'.repeat(1001) })
    await tooBig('create_page', { notebookId: 'nb1', sectionId: ops, title: 't'.repeat(1001) })
    await tooBig('read_page', { pageId: 'p'.repeat(129) })
    // The page is untouched: nothing oversized was written.
    expect(textOf(await client.callTool({ name: 'read_page', arguments: { pageId: deploy.pageId } }))).not.toContain('xxxx')
  })

  it('truncates the audit target to 200 characters', async () => {
    const { client, audits } = await connect()
    await client.callTool({ name: 'search', arguments: { query: 'z'.repeat(1000) } })
    expect(audits.at(-1)!.target).toHaveLength(200)
  })
})
