// Byte-level fuzzing helpers: seeded mutation of a corpus input, every way a stream can arrive in chunks, and a
// minimiser for a failing byte input (fast-check shrinks structured values; a raw input needs this).
import fc from 'fast-check'
import type { Rng } from './fuzz'

/** One to four seeded edits of `seed`: flip a bit, set a byte, insert, delete, repeat a span, truncate. */
export function mutateBytes(rng: Rng, seed: Uint8Array, maxLength = Math.max(64, seed.length * 2)): Uint8Array {
  let out = Array.from(seed)
  const interesting = [0x00, 0x01, 0x7f, 0x80, 0xff, 0x22, 0x3c, 0x5c, 0x7b, 0x7d]
  for (let edits = rng.int(1, 4); edits > 0; edits--) {
    const at = rng.int(0, Math.max(0, out.length - 1))
    switch (rng.int(0, 5)) {
      case 0:
        if (out.length) out[at] = out[at]! ^ (1 << rng.int(0, 7))
        break
      case 1:
        if (out.length) out[at] = rng.bool() ? rng.pick(interesting) : rng.int(0, 255)
        break
      case 2:
        out.splice(rng.int(0, out.length), 0, ...Array.from(rng.bytes(8, 1)))
        break
      case 3:
        out.splice(at, rng.int(1, 8))
        break
      case 4: {
        const span = out.slice(at, at + rng.int(1, 16))
        const times = rng.int(1, 16)
        out.splice(at, 0, ...Array.from({ length: times }, () => span).flat())
        break
      }
      default:
        out = out.slice(0, rng.int(0, out.length))
    }
  }
  return Uint8Array.from(out.slice(0, maxLength))
}

/** Every split of `bytes` into consecutive chunks (empty chunks included), as a stream reader may see it. */
export function chunkings(bytes: Uint8Array): fc.Arbitrary<Uint8Array[]> {
  return fc.array(fc.integer({ min: 0, max: bytes.length }), { maxLength: Math.min(32, bytes.length + 2) }).map((cuts) => {
    const points = [0, ...[...cuts].sort((a, b) => a - b), bytes.length]
    return points.slice(1).map((end, i) => bytes.slice(points[i]!, end))
  })
}

/**
 * Delta debugging over spans, then single bytes zeroed: returns an input `stillFails` accepts, never longer
 * than `input`. Throws if `input` itself does not fail, since a minimiser given a passing input proves nothing.
 */
export function minimizeBytes(input: Uint8Array, stillFails: (candidate: Uint8Array) => boolean): Uint8Array {
  if (!stillFails(input)) throw new Error('minimizeBytes: the input does not fail')
  let best = input
  for (let span = Math.max(1, best.length >> 1); span >= 1; span = span === 1 ? 0 : span >> 1) {
    let at = 0
    while (at < best.length) {
      const candidate = Uint8Array.from([...best.subarray(0, at), ...best.subarray(at + span)])
      if (stillFails(candidate)) best = candidate
      else at += span
    }
  }
  for (let i = 0; i < best.length; i++) {
    if (best[i] === 0) continue
    const candidate = Uint8Array.from(best)
    candidate[i] = 0
    if (stillFails(candidate)) best = candidate
  }
  return best
}
