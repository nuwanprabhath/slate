import { describe, expect } from 'vitest'
import { redactString } from '../src/shared/redact'
import { replayCorpus } from './fuzzCorpus'

// T-F4E's past counterexamples (src/shared/redactFuzz.test.ts): each file in test/corpus/redact is a line the soak
// found a second pass would still change, so redaction stays final for it for good (FX-56, seed 64).
describe('T-F4E corpus: past counterexamples are redacted once and for all', () => {
  replayCorpus('desktop', 'redact', (bytes) => {
    const once = redactString(new TextDecoder().decode(bytes))
    expect(redactString(once)).toBe(once)
  })
})
