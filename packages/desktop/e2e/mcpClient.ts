import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { join } from 'node:path'

const BIN = join(__dirname, '..', '..', '..', 'bin', 'slate-mcp')

/** Starts bin/slate-mcp exactly as Claude Code would, against a test data folder. */
export async function connectMcp(userData: string): Promise<{ client: Client; close(): Promise<void> }> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && k !== 'ELECTRON_RUN_AS_NODE')) as Record<string, string>
  const transport = new StdioClientTransport({ command: BIN, env: { ...env, SLATE_USER_DATA: userData }, stderr: 'pipe' })
  const client = new Client({ name: 'slate-e2e', version: '0.0.0' })
  await client.connect(transport)
  return { client, close: () => client.close() }
}

export const textOf = (r: object) => (((r as { content?: unknown }).content as Array<{ type: string; text: string }>)[0]?.text ?? '')
