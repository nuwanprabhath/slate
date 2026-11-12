// Runs one regular expression in a worker the test can terminate, so a catastrophic backtrack costs a
// deadline instead of the test process. Plain JavaScript so it loads the same under Node and Electron's Node.
import { parentPort } from 'node:worker_threads'

parentPort.on('message', ({ id, source, flags, text }) => {
  const re = new RegExp(source, flags)
  if (re.global || re.sticky) {
    let m
    while ((m = re.exec(text)) !== null) if (m[0] === '') re.lastIndex++
  } else re.exec(text)
  parentPort.postMessage({ id, result: 'done' })
})
