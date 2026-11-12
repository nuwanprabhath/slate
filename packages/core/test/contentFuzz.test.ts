// @fuzz F3a: contentToJSON / writeContent round trips, and readers over documents a hostile peer wrote.
import fc from 'fast-check'
import { LoroDoc, LoroList, LoroMap, LoroText } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { contentToJSON, writeContent } from '../src/content'
import { toMarkdown } from '../src/markdown'
import { PageDoc } from '../src/page'
import { toPlainText, type PMJSON } from '../src/plaintext'
import { fcRuns } from '../../desktop/test/fuzz'

// Text without lone surrogates (Loro stores UTF-8) and without the empty string (an empty run is dropped).
const word = fc.string({ minLength: 1, maxLength: 6, unit: 'binary' }).map((s) => s.toWellFormed())
const markArb = fc.constantFrom<{ type: string; attrs?: Record<string, unknown> }>({ type: 'bold' }, { type: 'italic' }, { type: 'strike' })
// Adjacent runs with the same marks would merge into one, so each run alternates its marks.
const inlineRuns = fc.array(fc.tuple(word, fc.uniqueArray(markArb, { maxLength: 2, selector: (m) => m.type })), { minLength: 1, maxLength: 3 }).map((runs) =>
  runs.map(([text, marks], i): PMJSON => ({ type: 'text', text: `${text}${i}`, ...(marks.length > 0 && i % 2 === 0 ? { marks } : {}) })),
)
const block: fc.Arbitrary<PMJSON> = fc.oneof(
  inlineRuns.map((content) => ({ type: 'paragraph', content })),
  fc.tuple(fc.integer({ min: 1, max: 3 }), inlineRuns).map(([level, content]) => ({ type: 'heading', attrs: { level }, content })),
  fc.array(inlineRuns.map((content): PMJSON => ({ type: 'listItem', content: [{ type: 'paragraph', content }] })), { minLength: 1, maxLength: 3 }).map((content) => ({ type: 'bulletList', content })),
)

/** Mark order is not part of the model (Loro keeps a run's attributes sorted by key), nor is a mark's empty attrs. */
const norm = (n: PMJSON): PMJSON => ({
  ...n,
  ...(n.marks ? { marks: n.marks.map((m) => ({ type: m.type, ...(m.attrs && Object.keys(m.attrs).length > 0 ? { attrs: m.attrs } : {}) })).sort((a, b) => a.type.localeCompare(b.type)) } : {}),
  ...(n.content ? { content: mergeText(n.content.map(norm)) } : {}),
})

/** Adjacent text nodes with equal marks are one run in a LoroText. */
function mergeText(nodes: PMJSON[]): PMJSON[] {
  const out: PMJSON[] = []
  for (const n of nodes) {
    const last = out[out.length - 1]
    if (last?.type === 'text' && n.type === 'text' && JSON.stringify(last.marks) === JSON.stringify(n.marks)) out[out.length - 1] = { ...last, text: (last.text ?? '') + (n.text ?? '') }
    else out.push(n)
  }
  return out
}

describe('content fuzz', () => {
  it('T-F3A-11: contentToJSON after writeContent gives back the blocks written', () => {
    fc.assert(
      fc.property(fc.array(block, { minLength: 1, maxLength: 4 }), (blocks) => {
        const doc = new LoroDoc()
        const root = doc.getMap('c')
        writeContent(root, blocks, doc)
        doc.commit()
        expect(norm(contentToJSON(root)!)).toEqual(norm({ type: 'doc', content: blocks }))
      }),
      fcRuns(4, 100),
    )
  })

  /** A box whose content a hostile peer shaped by hand with raw Loro writes. */
  function hostileDoc(seed: number[]): PageDoc {
    const page = new PageDoc()
    page.addBox({ x: 1, y: 2, width: 300, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'good' }] }] })
    const boxes = page.doc.getMap('boxes')
    seed.forEach((kind, i) => {
      switch (kind % 7) {
        case 0:
          boxes.set(`s${i}`, 'a string')
          break
        case 1:
          boxes.setContainer(`l${i}`, new LoroList())
          break
        case 2:
          boxes.setContainer(`t${i}`, new LoroText())
          break
        case 3: {
          const m = boxes.setContainer(`m${i}`, new LoroMap())
          m.set('x', 'not a number')
          m.setContainer('content', new LoroList())
          break
        }
        case 4: {
          const m = boxes.setContainer(`n${i}`, new LoroMap())
          m.setContainer('content', new LoroMap()).set('nodeName', 7)
          break
        }
        case 5: {
          const m = boxes.setContainer(`c${i}`, new LoroMap())
          const content = m.setContainer('content', new LoroMap())
          content.set('nodeName', 'weird')
          content.setContainer('attributes', new LoroList())
          content.setContainer('children', new LoroMap())
          break
        }
        default: {
          const m = boxes.setContainer(`k${i}`, new LoroMap())
          m.setContainer('content', new LoroMap()).set('children', 'text')
        }
      }
    })
    page.doc.commit()
    return page
  }

  it('T-F3A-12: readers do not throw on a hand-built hostile document, and the good box stays readable', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 6 }), { maxLength: 8 }), (seed) => {
        const page = hostileDoc(seed)
        const boxes = page.listBoxes()
        expect(boxes.some((b) => b.width === 300)).toBe(true)
        for (const b of boxes) {
          const content = page.contentMap(b.id)
          if (!content) continue
          const json = contentToJSON(content)
          const blocks = json?.content ?? []
          expect(typeof toMarkdown(blocks)).toBe('string')
          expect(typeof toPlainText(blocks)).toBe('string')
        }
      }),
      fcRuns(10, 50),
    )
  })

  it('T-F3A-13: an unknown node type in the content tree reads back instead of throwing', () => {
    const doc = new LoroDoc()
    const root = doc.getMap('c')
    writeContent(root, [{ type: 'mystery', attrs: { a: [1, { b: null }] }, content: [{ type: 'paragraph' }] }], doc)
    expect(contentToJSON(root)).toEqual({ type: 'doc', content: [{ type: 'mystery', attrs: { a: [1, { b: null }] }, content: [{ type: 'paragraph' }] }] })
    expect(typeof toMarkdown(contentToJSON(root)!.content ?? [])).toBe('string')
  })
})
