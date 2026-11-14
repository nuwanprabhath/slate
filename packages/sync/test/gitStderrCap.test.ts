// FX-18: a remote chooses how much a git child prints on stderr, so the collected string is bounded.
import { describe, expect, it } from 'vitest'
import { MAX_STDERR_CHARS, nodeGitRunner } from '../src/gitRunner'

const printing = (chars: number) =>
  nodeGitRunner(process.execPath)(
    ['-e', `const line = 'remote: x'.padEnd(99, 'y') + '\\n'; let left = ${chars}; while (left > 0) { const n = Math.min(left, 100); process.stderr.write(line.slice(0, n)); left -= n }`],
    { timeoutMs: 60_000 },
  )

describe('FX-18: stderr is capped', () => {
  it('keeps the first part and says how much was dropped', async () => {
    const total = MAX_STDERR_CHARS * 4
    const res = await printing(total)
    expect(res.stderr.startsWith('remote: x')).toBe(true)
    expect(res.stderr.endsWith(`…[+${String(total - MAX_STDERR_CHARS)} chars]`)).toBe(true)
    expect(res.stderr.length).toBeLessThan(MAX_STDERR_CHARS + 64)
  })

  it('leaves a message at the cap untouched', async () => {
    const res = await printing(MAX_STDERR_CHARS)
    expect(res.stderr).toHaveLength(MAX_STDERR_CHARS)
    expect(res.stderr).not.toContain('chars]')
  })
})
