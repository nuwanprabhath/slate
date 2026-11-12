// A deadline for regular expressions: the match runs in a worker, and a worker past its deadline is
// terminated and replaced, so one catastrophic backtrack cannot hang the suite.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

// A path, not a URL: a DOM test environment replaces the global URL, and Worker refuses that one.
const WORKER = join(dirname(fileURLToPath(import.meta.url)), 'fuzzRegexWorker.mjs')

export function regexDeadline(): { exec(source: string, flags: string, text: string, ms: number): Promise<'done' | 'timeout'>; close(): Promise<void> } {
  let worker = new Worker(WORKER)
  let next = 0
  // One match at a time: a timeout replaces the worker, which must not take another call's match with it.
  let queue: Promise<unknown> = Promise.resolve()
  const run = (source: string, flags: string, text: string, ms: number): Promise<'done' | 'timeout'> =>
    new Promise((resolve, reject) => {
      const id = next++
      const w = worker
      const finish = (): void => {
        clearTimeout(timer)
        w.off('message', onMessage)
        w.off('error', onError)
      }
      const onMessage = (msg: { id: number; result: 'done' }): void => {
        if (msg.id !== id) return
        finish()
        resolve(msg.result)
      }
      const onError = (e: Error): void => {
        finish()
        worker = new Worker(WORKER)
        reject(e)
      }
      const timer = setTimeout(() => {
        finish()
        worker = new Worker(WORKER)
        void w.terminate()
        resolve('timeout')
      }, ms)
      w.on('message', onMessage)
      w.on('error', onError)
      w.postMessage({ id, source, flags, text })
    })
  return {
    exec(source, flags, text, ms) {
      const p = queue.then(() => run(source, flags, text, ms))
      queue = p.catch(() => undefined)
      return p
    },
    async close() {
      await queue
      await worker.terminate()
    },
  }
}
