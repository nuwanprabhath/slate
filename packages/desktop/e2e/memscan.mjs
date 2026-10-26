#!/usr/bin/env node
// T-ZERO-04 (audit §6.3, C7), Linux only: reads another process's memory through /proc/<pid>/mem and
// reports where each needle occurs. Slate makes itself non-dumpable (PR_SET_DUMPABLE 0, Z-9), so reading
// its memory needs CAP_SYS_PTRACE: memory.linux.ts runs this file with sudo, and the app itself stays an
// ordinary user's process (Chromium refuses to run as root with its sandbox on).
// Usage: node memscan.mjs <pid> <needles.json>, needles as [{ "label": "mk/raw", "hex": "c4a1…" }];
// prints the hits as JSON: [{ "label", "address", "mapping" }].
import { closeSync, openSync, readFileSync, readSync } from 'node:fs'

function readableRegions(pid) {
  const out = []
  for (const line of readFileSync(`/proc/${pid}/maps`, 'utf8').split('\n')) {
    const m = /^([0-9a-f]+)-([0-9a-f]+) (\S{4}) \S+ \S+ \S+\s*(.*)$/.exec(line)
    if (!m || m[3][0] !== 'r') continue
    const mapping = m[4] ?? ''
    // Kernel-backed pages cannot be read through /proc/<pid>/mem and hold no Slate data.
    if (mapping === '[vvar]' || mapping === '[vsyscall]' || mapping === '[vvar_vclock]') continue
    out.push({ start: BigInt('0x' + m[1]), end: BigInt('0x' + m[2]), mapping })
  }
  return out
}

/** Every readable mapping in 4 MiB chunks; chunks overlap by the longest needle so no match straddles a gap. */
export function scanProcess(pid, needles) {
  const overlap = Math.max(...needles.map((n) => n.bytes.length)) - 1
  const CHUNK = 4 * 1024 * 1024
  const buf = Buffer.alloc(CHUNK + overlap)
  const hits = []
  const fd = openSync(`/proc/${pid}/mem`, 'r')
  try {
    for (const r of readableRegions(pid)) {
      for (let at = r.start; at < r.end; at += BigInt(CHUNK)) {
        const want = Number(r.end - at < BigInt(CHUNK + overlap) ? r.end - at : BigInt(CHUNK + overlap))
        let got = 0
        try {
          got = readSync(fd, buf, 0, want, at)
        } catch {
          break // a guard page, or a mapping that went away while scanning
        }
        const view = buf.subarray(0, got)
        for (const n of needles) {
          for (let i = view.indexOf(n.bytes); i !== -1; i = view.indexOf(n.bytes, i + 1)) {
            // A match inside the overlap is found again at the start of the next chunk.
            if (i >= CHUNK && at + BigInt(CHUNK) < r.end) continue
            hits.push({ label: n.label, address: '0x' + (at + BigInt(i)).toString(16), mapping: r.mapping })
          }
        }
      }
    }
  } finally {
    closeSync(fd)
  }
  return hits
}

const [pid, file] = process.argv.slice(2)
if (pid && file) {
  const needles = JSON.parse(readFileSync(file, 'utf8')).map((n) => ({ label: n.label, bytes: Buffer.from(n.hex, 'hex') }))
  process.stdout.write(JSON.stringify(scanProcess(Number(pid), needles)))
}
