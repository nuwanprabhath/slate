import { describe, expect, it } from 'vitest'
import { PRINT_WIDTH_PX, printLayout } from './print'

describe('printLayout', () => {
  it('prints a page that fits at its own size, as tall as its lowest box', () => {
    expect(printLayout([{ left: 40, top: 30, width: 300, height: 80 }, { left: 360, top: 200, width: 200, height: 50 }])).toEqual({ width: 560, height: 250, zoom: 1 })
  })

  it('scales a page wider than the paper down to the paper width, keeping every box where it is', () => {
    const layout = printLayout([{ left: 100, top: 0, width: 1336, height: 400 }])
    expect(layout).toEqual({ width: 1436, height: 400, zoom: PRINT_WIDTH_PX / 1436 })
    expect(layout.width * layout.zoom).toBeCloseTo(PRINT_WIDTH_PX)
  })

  it('never scales up, and prints an empty page as nothing', () => {
    expect(printLayout([{ left: 0, top: 0, width: 10, height: 10 }]).zoom).toBe(1)
    expect(printLayout([])).toEqual({ width: 0, height: 0, zoom: 1 })
  })

  it('fits A4 with the PDF export margins (1 cm each side), the narrower of A4 and Letter', () => {
    const a4 = (210 / 25.4) * 96
    const margins = 2 * (10 / 25.4) * 96
    expect(PRINT_WIDTH_PX).toBeLessThanOrEqual(a4 - margins)
    expect(PRINT_WIDTH_PX).toBeGreaterThan(a4 - margins - 2)
  })
})
