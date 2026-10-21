import { describe, expect, it } from 'vitest'
import { PageDoc, agentPageMarkdown } from '@slate/core'
import { appendToPage, createPage, listTree, NOT_PERMITTED, readPage, search } from '../src/tools'
import { memorySource } from './memorySource'

describe('MCP tools', () => {
  it('shows nothing without a grant, and audits the denial', async () => {
    const { source, audits, seed } = memorySource()
    const { deploy } = seed()
    expect(await listTree(source)).toEqual([])
    await expect(readPage(source, deploy.pageId)).rejects.toThrow(NOT_PERMITTED)
    expect(audits.at(-1)).toEqual({ tool: 'read_page', target: deploy.pageId, outcome: 'denied' })
  })

  it('gives the same error for unknown and forbidden pages', async () => {
    const { source, audits } = memorySource()
    await expect(readPage(source, 'does-not-exist')).rejects.toThrow(NOT_PERMITTED)
    expect(audits.at(-1)!.outcome).toBe('not-found')
  })

  it('lists only granted branches, with their access level', async () => {
    const { source, seed } = memorySource()
    const { ops, deploy, grant } = seed()
    grant(ops, 'read')
    const tree = await listTree(source)
    expect(tree).toHaveLength(1)
    expect(tree[0]).toMatchObject({ notebookId: 'nb1', name: 'Work' })
    expect(tree[0].items).toEqual([{ id: ops, kind: 'section', title: 'Ops', access: 'read', children: [{ id: deploy.id, kind: 'page', title: 'Deploy', pageId: deploy.pageId, access: 'read', children: [] }] }])
  })

  it('reads a granted page with private boxes omitted', async () => {
    const { source, seed } = memorySource()
    const { ops, deploy, grant } = seed()
    grant(ops, 'read')
    const md = await readPage(source, deploy.pageId)
    expect(md).toContain('kubectl rollout status')
    expect(md).toContain('[private box omitted]')
    expect(md).not.toContain('hunter2')
  })

  it('searches only granted, non-private content', async () => {
    const { source, seed } = memorySource()
    const { ops, deploy, grant } = seed()
    grant(ops, 'read')
    const hits = await search(source, 'KUBECTL')
    expect(hits.map((h) => h.pageId)).toEqual([deploy.pageId])
    expect(await search(source, 'hunter2')).toEqual([])
    expect(await search(source, 'dreams')).toEqual([])
  })

  it('appends only with readwrite, below the existing boxes', async () => {
    const { source, docs, seed } = memorySource()
    const { ops, deploy, grant } = seed()
    grant(ops, 'read')
    await expect(appendToPage(source, deploy.pageId, 'nope')).rejects.toThrow(NOT_PERMITTED)
    grant(ops, 'readwrite')
    await appendToPage(source, deploy.pageId, '# Agent note\n\n- step one')
    const page = PageDoc.fromUpdates(docs.get(`page:${deploy.pageId}`)!)
    expect(page.listBoxes()).toHaveLength(3)
    const md = agentPageMarkdown(page)
    expect(md.indexOf('# Agent note')).toBeGreaterThan(md.indexOf('kubectl rollout status'))
    expect(md).toContain('- step one')
  })

  it('creates a page in a readwrite section only', async () => {
    const { source, seed } = memorySource()
    const { ops, other, grant } = seed()
    grant(ops, 'readwrite')
    await expect(createPage(source, 'nb1', other, 'X')).rejects.toThrow(NOT_PERMITTED)
    const { pageId } = await createPage(source, 'nb1', ops, 'Runbook', 'step 1')
    expect(await readPage(source, pageId)).toBe('step 1')
    const tree = await listTree(source)
    expect(JSON.stringify(tree)).toContain('Runbook')
  })
})
