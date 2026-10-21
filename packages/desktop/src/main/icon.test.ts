import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const build = join(__dirname, '../../build')

describe('app icons', () => {
  it.each(['icon.ico', 'icon.icns', 'icon.png'])('%s exists and is non-empty', (name) => {
    expect(existsSync(join(build, name))).toBe(true)
    expect(statSync(join(build, name)).size).toBeGreaterThan(0)
  })

  it('exports every Linux size, each PNG matching its file name', () => {
    const files = readdirSync(join(build, 'icons')).sort()
    expect(files.length).toBe(8)
    for (const file of files) {
      const size = Number(/^(\d+)x\1\.png$/.exec(file)?.[1])
      expect(size, file).toBeGreaterThan(0)
      const png = readFileSync(join(build, 'icons', file))
      expect(png.readUInt32BE(16), `${file} width`).toBe(size)
      expect(png.readUInt32BE(20), `${file} height`).toBe(size)
    }
  })

  it('ships the runtime icon the main process loads', () => {
    expect(statSync(join(__dirname, '../../resources/icon.png')).size).toBeGreaterThan(0)
  })
})
