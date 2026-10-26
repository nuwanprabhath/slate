import { mkdirSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createSlateMcpServer } from '@slate/mcp'
import { defaultUserDataDir } from '../main/paths'
import { provideCliDbModule } from '../main/db/dbModule'
import { vaultExists } from '../main/db/vaultGate'
import { storeDocSource } from '../main/mcp/docSource'
import { runProxy } from '../main/mcp/proxy'
import { checkSocketDir, mcpSocketPath, socketEnv } from '../main/mcp/socketPath'
import { DocStore } from '../main/store'

// stdout carries MCP protocol messages only; anything for a human goes to stderr.
async function main(): Promise<void> {
  const dir = defaultUserDataDir()
  mkdirSync(dir, { recursive: true })
  if (vaultExists(dir)) {
    // §9: encrypted notes are only ever opened by the app; this process relays to its socket.
    const uid = process.getuid?.() ?? 0
    const path = mcpSocketPath(dir, socketEnv({ platform: process.platform, env: process.env, tmpdir: tmpdir(), uid }))
    process.stderr.write(`slate-mcp: relaying to the Slate app at ${path}\n`)
    await runProxy({
      input: process.stdin,
      output: process.stdout,
      connect: () =>
        new Promise<Socket>((resolve, reject) => {
          try {
            // Another user could have made the temp folder first and be listening there for our requests.
            checkSocketDir(path, dir, uid)
          } catch (err) {
            process.stderr.write(`slate-mcp: refusing ${path}: ${err instanceof Error ? err.message : String(err)}\n`)
            reject(err as Error)
            return
          }
          const s = connect(path)
          s.once('connect', () => resolve(s))
          s.once('error', reject)
        }),
    })
    return
  }
  // Never compacts: the app owns compaction and may hold the same documents open.
  provideCliDbModule(__dirname)
  const store = new DocStore(join(dir, 'slate.db'), { compact: false })
  await createSlateMcpServer(storeDocSource(() => store)).connect(new StdioServerTransport())
  process.stderr.write(`slate-mcp: serving ${dir}\n`)
}

main().catch((error: unknown) => {
  process.stderr.write(`slate-mcp: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exit(1)
})
