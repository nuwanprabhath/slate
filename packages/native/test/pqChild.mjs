// Child process for pq.test.ts (PQ-A1): requireApprovedKeys and the FIPS provider are one-way for a process,
// so each runs here. Reads ML-DSA cases (hex) as JSON on stdin; prints what each step returned, as JSON.
// Usage: node pqChild.mjs latch | node pqChild.mjs fips <config> <modulesDir>
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const [mode, config, modulesDir] = process.argv.slice(2)
const native = createRequire(import.meta.url)(join(import.meta.dirname, '..', 'prebuilds', `${process.platform}-${process.arch}`, 'slate_native.node'))
const cases = JSON.parse(readFileSync(0, 'utf8'))
const hex = (s) => new Uint8Array(Buffer.from(s, 'hex'))
const verifyAll = () => cases.map((c) => native.mldsaVerify(c.level, hex(c.spki), hex(c.message), hex(c.context), hex(c.signature)))

let out
if (mode === 'latch') {
  native.init('', '', false)
  out = { before: native.status().approvedKeysOnly, latch: native.requireApprovedKeys() }
  out.results = verifyAll()
  out.approvedKeysOnly = native.status().approvedKeysOnly
} else {
  native.init(config, modulesDir, true)
  const s = native.status()
  out = { fipsActive: s.fipsActive, fipsModuleVersion: s.fipsModule?.version ?? null, pqAlgorithms: s.pqAlgorithms, pqInFipsBoundary: s.pqInFipsBoundary }
  out.results = verifyAll()
}
process.stdout.write(JSON.stringify(out))
