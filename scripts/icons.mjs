// Regenerates every app icon from packages/desktop/build/icon.svg. Run: node scripts/icons.mjs
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const build = join(root, 'packages/desktop/build')
const svg = join(build, 'icon.svg')

function run(tool, args) {
  const r = spawnSync(tool, args, { encoding: 'utf8' })
  if (r.error?.code === 'ENOENT') {
    console.error(`icons: "${tool}" is not installed or not on PATH (needs rsvg-convert, iconutil, magick).`)
    process.exit(1)
  }
  if (r.status !== 0) {
    console.error(`icons: ${tool} ${args.join(' ')} failed:\n${r.stderr}`)
    process.exit(1)
  }
}

const png = (size, out) => run('rsvg-convert', ['-w', String(size), '-h', String(size), '-o', out, svg])

const tmp = mkdtempSync(join(tmpdir(), 'slate-icons-'))
try {
  mkdirSync(join(build, 'icons'), { recursive: true })
  for (const s of [16, 32, 48, 64, 128, 256, 512, 1024]) png(s, join(build, 'icons', `${s}x${s}.png`))
  copyFileSync(join(build, 'icons/1024x1024.png'), join(build, 'icon.png'))

  const iconset = join(tmp, 'icon.iconset')
  mkdirSync(iconset)
  for (const s of [16, 32, 128, 256, 512]) {
    png(s, join(iconset, `icon_${s}x${s}.png`))
    png(s * 2, join(iconset, `icon_${s}x${s}@2x.png`))
  }
  run('iconutil', ['-c', 'icns', iconset, '-o', join(build, 'icon.icns')])

  const icoPngs = []
  for (const s of [16, 24, 32, 48, 64, 128, 256]) {
    const p = join(tmp, `ico-${s}.png`)
    png(s, p)
    icoPngs.push(p)
  }
  run('magick', [...icoPngs, join(build, 'icon.ico')])
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
console.log('icons: regenerated')
