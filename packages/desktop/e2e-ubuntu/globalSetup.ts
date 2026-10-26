import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import tmpRoot from '../e2e/tmpRoot'
import { prepare, removeStaleBeds, startBed, stopBed } from './bed'

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer()
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      server.close(() => done(port))
    })
  })
}

/**
 * Builds what the scenarios need (v0.1.0 on this Mac, the Ubuntu image), then starts one container for
 * the run. Its name, port and the shared folder reach the workers through the environment.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const removeRoot = tmpRoot()
  await removeStaleBeds()
  await prepare()
  // /private/tmp is shared with Docker Desktop by default; the run's TMPDIR (under /var/folders) is too,
  // but a short path keeps the clone paths in git's messages readable.
  const shared = mkdtempSync(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'slate-xdev-'))
  const bed = await startBed(shared, await freePort())
  process.env.SLATE_XDEV_BED = JSON.stringify(bed)
  return async () => {
    // Debugging (README.md): keep the container and the shared folder to look at after the run.
    if (process.env.SLATE_XDEV_KEEP === '1') {
      console.log(`SLATE_XDEV_KEEP: container ${bed.name} (docker exec -it ${bed.name} bash), shared folder ${shared}`)
      return
    }
    await stopBed(bed.name)
    rmSync(shared, { recursive: true, force: true, maxRetries: 3 })
    removeRoot()
  }
}
