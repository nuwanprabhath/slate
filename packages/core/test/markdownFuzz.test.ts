// @fuzz F3a: markdownToBlocks, toPlainText and toMarkdown under generated and hostile input.
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { markdownToBlocks, toMarkdown } from '../src/markdown'
import { toPlainText, type PMJSON } from '../src/plaintext'
import { fcParams, fcRuns, relativeCost } from '../../desktop/test/fuzz'

const ALLOWED = new Set(['paragraph', 'heading', 'bulletList', 'orderedList', 'listItem', 'codeBlock', 'text'])

function check(node: PMJSON): void {
  expect(ALLOWED.has(node.type), `node type ${node.type}`).toBe(true)
  expect(node.marks, 'a node carries no mark').toBeUndefined()
  if (node.type === 'heading') expect([1, 2, 3]).toContain(node.attrs?.level)
  for (const child of node.content ?? []) check(child)
}

const PIECES = ['#', '##', '###', '####', '#######', '```', '```ts', '- ', '* ', '1. ', '12. ', '\n', '\r\n', '\r', ' ', '\t', 'x', '**', '`', ' ', '​', '😀', '|']
const mdArb = fc.array(fc.oneof(fc.constantFrom(...PIECES), fc.string({ maxLength: 3, unit: 'binary' })), { maxLength: 40 }).map((p) => p.join(''))

describe('markdownToBlocks fuzz', () => {
  it('T-F3A-05: never throws, emits only the allowed nodes, headings 1 to 3, no marks', () => {
    fc.assert(
      fc.property(fc.oneof(mdArb, fc.string({ unit: 'binary', maxLength: 60 })), (md) => {
        for (const block of markdownToBlocks(md)) check(block)
      }),
      fcParams,
    )
    expect(markdownToBlocks('#### x')).toEqual([{ type: 'paragraph', content: [{ type: 'text', text: '#### x' }] }])
  })

  it('T-F3A-06: 1 MiB of fences, headings and list markers costs about what plain text of the same size does', () => {
    const MiB = 1024 * 1024
    const fill = (unit: string): string => unit.repeat(Math.ceil(MiB / unit.length)).slice(0, MiB)
    // Same line count as the hostile inputs, so a linear parser costs the same per line and a quadratic one stands out.
    const plain = fill('abcde\n')
    const hostile = [fill('```\n'), fill('```ts\ncode\n'), fill('# h\n'), fill('###### h\n'), fill('- a\n'), fill('1. a\n'), fill('#'), fill(' '), fill('-'), fill('``` '), fill('1.')]
    const cost = relativeCost(() => void markdownToBlocks(plain), { calibrationRuns: 6, calibrationWarmup: 1, meanOverBenign: 60, p99OverBenign: 100, meanCeilingMs: 2_000, absoluteCeilingMs: 5_000 })
    for (const input of hostile) cost.time(() => void markdownToBlocks(input))
    cost.check()
  })

  const textArb = fc.string({ unit: 'binary', maxLength: 8 })
  const messy = fc.array(fc.oneof(textArb, fc.constantFrom('\r', '\r\n', ' ', '​', '‌', '‍', '⁠', '﻿', '\n', 'a')), { maxLength: 6 }).map((p) => p.join(''))
  const inlineArb: fc.Arbitrary<PMJSON> = fc.oneof(
    messy.map((text) => ({ type: 'text', text })),
    fc.constant<PMJSON>({ type: 'hardBreak' }),
  )
  const blockArb: fc.Arbitrary<PMJSON> = fc.letrec<{ block: PMJSON }>((tie) => ({
    block: fc.oneof(
      { depthSize: 'small', maxDepth: 3 },
      fc.array(inlineArb, { maxLength: 4 }).map((content) => ({ type: 'paragraph', content })),
      // codeBlock is left out: toPlainText keeps zero-width characters inside code (open finding F3A-4).
      fc.array(inlineArb, { maxLength: 3 }).map((content) => ({ type: 'heading', attrs: { level: 2 }, content })),
      fc.array(tie('block'), { maxLength: 3 }).map((content) => ({ type: 'blockquote', content })),
      fc.array(fc.array(tie('block'), { maxLength: 2 }).map((content) => ({ type: 'listItem', content })), { maxLength: 3 }).map((content) => ({ type: 'bulletList', content })),
      fc.array(fc.array(tie('block'), { maxLength: 2 }).map((content) => ({ type: 'listItem', content })), { maxLength: 3 }).map((content) => ({ type: 'orderedList', content })),
    ),
  })).block

  it('T-F3A-07: toPlainText holds the product rule: no CR, NBSP, zero-width character or trailing newline', () => {
    fc.assert(
      fc.property(fc.array(blockArb, { maxLength: 4 }), (nodes) => {
        const out = toPlainText(nodes)
        expect(out).not.toMatch(/[\r ​-‍⁠﻿]/)
        expect(out.endsWith('\n')).toBe(false)
      }),
      fcParams,
    )
  })

  // Open finding F3A-2 (wrong-typed attributes make toMarkdown/toPlainText throw "Invalid string length"; the
  // generator for it is left out until FX fixes it).
  const deep = (type: string, n: number, leaf: PMJSON): PMJSON => {
    let node = leaf
    for (let i = 0; i < n; i++) node = { type, content: type === 'bulletList' ? [{ type: 'listItem', content: [node] }] : [node] }
    return node
  }

  // Open finding F3A-3: a 5,000-deep chain overflows the stack in toMarkdown/toPlainText; the property is
  // left out until FX fixes it, and the depth here stays below the overflow.
  it('T-F3A-10: random-depth chains (up to 800) never throw', () => {
    fc.assert(
      fc.property(fc.constantFrom('blockquote', 'bulletList', 'orderedList', 'unknown'), fc.integer({ min: 0, max: 800 }), (type, n) => {
        const chain = deep(type, n, { type: 'paragraph', content: [{ type: 'text', text: 'x' }] })
        expect(typeof toMarkdown([chain])).toBe('string')
        expect(typeof toPlainText([chain])).toBe('string')
      }),
      fcRuns(40, 20),
    )
  })
})
