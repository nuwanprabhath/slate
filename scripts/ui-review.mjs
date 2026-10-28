#!/usr/bin/env node
// `npm run ui:review [-- <scenario file or filter>]`: builds the app, runs the UI scenarios
// (packages/desktop/e2e/ui/*.ui.spec.ts), each of which passes the UI audit and saves its
// screenshots to ui-review/shots/, then lays every screenshot out on one page, ui-review/index.html,
// grouped by state, one column per theme and window width. That page is what the lead reviews
// (.claude/skills/ui-review/SKILL.md). It is stamped with the commit and whether the tree was clean,
// so a page left from older code says so at the top. Windows stay hidden (SLATE_E2E=1).
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const OUT = join(root, 'ui-review')
const SHOTS = join(OUT, 'shots')
const args = process.argv.slice(2)
const targets = args.length > 0 ? args : ['ui/']

rmSync(OUT, { recursive: true, force: true })
mkdirSync(SHOTS, { recursive: true })
const run = spawnSync('npm', ['run', 'e2e', '-w', '@slate/desktop', '--', ...targets], { cwd: root, stdio: 'inherit' })

const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim()
const head = git('rev-parse', '--short', 'HEAD')
const dirty = git('status', '--porcelain') !== ''
const shots = existsSync(SHOTS) ? readdirSync(SHOTS).filter((f) => f.endsWith('.png')).sort() : []

const groups = new Map()
for (const f of shots) {
  const [state, variant] = f.replace(/\.png$/, '').split('--')
  if (!groups.has(state)) groups.set(state, [])
  groups.get(state).push({ f, variant })
}

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const sections = [...groups]
  .map(
    ([state, list]) => `
  <section>
    <h2>${esc(state.replace(/-/g, ' '))}</h2>
    <div class="row">${list
      .map(
        ({ f, variant }) => `
      <figure><a href="shots/${esc(f)}"><img src="shots/${esc(f)}" loading="lazy" alt="${esc(state)} ${esc(variant)}"></a>
      <figcaption>${esc(variant)}</figcaption></figure>`,
      )
      .join('')}
    </div>
  </section>`,
  )
  .join('')

writeFileSync(
  join(OUT, 'index.html'),
  `<!doctype html>
<meta charset="utf-8"><title>Slate UI review</title>
<style>
  body { margin: 0; padding: 16px; background: #111; color: #ddd; font: 13px system-ui, sans-serif; }
  h1 { font-size: 16px; } h2 { font-size: 14px; margin: 24px 0 8px; text-transform: capitalize; }
  .stamp { color: ${run.status === 0 && !dirty ? '#8c8' : '#e88'}; }
  .row { display: flex; gap: 12px; overflow-x: auto; align-items: flex-start; }
  figure { margin: 0; flex: none; } img { max-height: 420px; border: 1px solid #333; }
  figcaption { color: #999; padding-top: 4px; }
</style>
<h1>Slate UI review</h1>
<p class="stamp">${esc(head)}${dirty ? ' with uncommitted changes' : ''} · audit ${run.status === 0 ? 'passed' : 'FAILED (see the test output)'} · ${String(shots.length)} screenshots</p>
${sections}
`,
)
console.log(`\nui:review: ${String(shots.length)} screenshots, audit ${run.status === 0 ? 'passed' : 'FAILED'}; open ${join(OUT, 'index.html')}`)
process.exit(run.status ?? 1)
