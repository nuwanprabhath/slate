import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LOCKED_MESSAGE } from '../mcp/proxy'
import { vaultExists } from './vaultGate'
import { runImportCli } from '../onenote/importCli'

const MCP_BUNDLE = join(__dirname, '../../../out/main/mcp.js')

describe('CLIs on an encrypted data folder', () => {
  it('vaultExists follows vault.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slate-gate-'))
    expect(vaultExists(dir)).toBe(false)
    writeFileSync(join(dir, 'vault.json'), '{}')
    expect(vaultExists(dir)).toBe(true)
  })

  it('the import CLI refuses and opens nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slate-gate-'))
    writeFileSync(join(dir, 'vault.json'), '{}')
    const err: string[] = []
    const code = await runImportCli(['--backup', join(dir, 'x'), '--user-data', dir], { out: () => {}, err: (t) => err.push(t) })
    expect(code).not.toBe(0)
    expect(err.join('\n')).toMatch(/Run the import from the app/)
    expect(existsSync(join(dir, 'slate.db'))).toBe(false)
  })

  // Needs the built slate-mcp bundle (npm run e2e builds it); skipped in a checkout that never built.
  it.skipIf(!existsSync(MCP_BUNDLE))('slate-mcp relays to the app, says it is locked when the app is not there, and opens no database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slate-gate-'))
    writeFileSync(join(dir, 'vault.json'), '{}')
    const input = [
      { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_tree', arguments: {} } },
    ]
      .map((m) => JSON.stringify(m) + '\n')
      .join('')
    const run = spawnSync(process.execPath, [MCP_BUNDLE], { env: { ...process.env, SLATE_USER_DATA: dir }, encoding: 'utf8', input })
    expect(run.status).toBe(0)
    const replies = run.stdout.trim().split('\n').map((l) => JSON.parse(l) as { id?: number; result?: { isError?: boolean; content?: Array<{ text: string }> } })
    const call = replies.find((r) => r.id === 1)!
    expect(call.result?.isError).toBe(true)
    expect(call.result?.content?.[0]?.text).toBe(LOCKED_MESSAGE)
    expect(existsSync(join(dir, 'slate.db'))).toBe(false)
  })
})
