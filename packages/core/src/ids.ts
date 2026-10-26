// The one home of the Web Crypto global (lint rule `slate/no-web-crypto`), and the sanctioned
// replacement for Math.random (`slate/no-math-random`). Web Crypto exists in every process Slate runs.

export function newId(): string {
  return crypto.randomUUID()
}

/** A uniform integer in [0, n), by rejection sampling so no value is more likely than another. */
export function randomInt(n: number): number {
  if (!Number.isSafeInteger(n) || n <= 0 || n > 2 ** 32) throw new RangeError(`randomInt needs an integer bound in 1..2^32, got ${String(n)}`)
  const limit = 2 ** 32 - (2 ** 32 % n)
  const word = new Uint32Array(1)
  for (;;) {
    crypto.getRandomValues(word)
    const v = word[0]!
    if (v < limit) return v % n
  }
}

/** A uniform number in [0, 1) with 53 random bits. */
export function randomFraction(): number {
  const words = new Uint32Array(2)
  crypto.getRandomValues(words)
  return (words[0]! * 2 ** 21 + (words[1]! >>> 11)) / 2 ** 53
}
