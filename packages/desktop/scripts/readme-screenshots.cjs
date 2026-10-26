// Renders the README screenshots (docs/screenshots/*.png) from a dummy notebook on a fresh profile.
// The window stays hidden (SLATE_E2E=1), so nothing appears on screen.
//
//   npm run build -w @slate/desktop && npm run screenshots -w @slate/desktop
const { _electron: electron } = require('@playwright/test')
const { mkdirSync, mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const desktop = join(__dirname, '..')
const out = join(desktop, '../../docs/screenshots')
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

const text = (t, marks) => ({ type: 'text', text: t, ...(marks ? { marks } : {}) })
const p = (...content) => ({ type: 'paragraph', content: content.map((c) => (typeof c === 'string' ? text(c) : c)) })
const h = (level, t) => ({ type: 'heading', attrs: { level }, content: [text(t)] })
const code = (t) => text(t, [{ type: 'code' }])
const bold = (t) => text(t, [{ type: 'bold' }])
const link = (t, href) => text(t, [{ type: 'link', attrs: { href } }])
const li = (...content) => ({ type: 'listItem', content: [p(...content)] })
const ol = (...items) => ({ type: 'orderedList', content: items })
const ul = (...items) => ({ type: 'bulletList', content: items })
const block = (language, t) => ({ type: 'codeBlock', attrs: { language }, content: [text(t)] })
const cell = (t, header) => ({ type: header ? 'tableHeader' : 'tableCell', content: [p(t)] })
const table = (rows) => ({ type: 'table', content: rows.map((r, i) => ({ type: 'tableRow', content: r.map((c) => cell(c, i === 0)) })) })

async function addSection(page, name) {
  await page.getByTestId('add-section').click()
  await page.getByTestId('inline-rename').fill(name)
  await page.keyboard.press('Enter')
}

async function addPage(page, title) {
  await page.getByTestId('add-page').click()
  await page.getByTestId('page-title').fill(title)
}

const addBox = (page, x, y, blocks, width) =>
  page.evaluate(([x, y, blocks, width]) => window.slateTest.addBox(x, y, blocks, width), [x, y, blocks, width])

async function theme(page, themeId) {
  await page.evaluate((themeId) => window.slate.settings.set({ themeId, followSystem: false }), themeId)
  await page.waitForTimeout(700)
}

;(async () => {
  mkdirSync(out, { recursive: true })
  const { ELECTRON_RUN_AS_NODE: _ignored, ...env } = process.env
  const app = await electron.launch({
    args: [join(desktop, 'out/main/index.js')],
    cwd: desktop,
    env: { ...env, SLATE_E2E: '1', SLATE_USER_DATA: mkdtempSync(join(tmpdir(), 'slate-shots-')) },
  })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByTestId('canvas').waitFor()

  // Sections and pages, through the real sidebar.
  for (const name of ['Platform', 'Incidents', 'Learning']) await addSection(page, name)
  await page.getByTestId('section-item').filter({ hasText: 'Platform' }).click()
  await page.getByTestId('page-title').fill('Release 2.4 runbook')
  for (const title of ['On-call handover', 'Postgres upgrade plan', 'API rate limits']) await addPage(page, title)
  await page.getByTestId('page-item').filter({ hasText: 'Release 2.4 runbook' }).click()
  await page.getByTestId('canvas').waitFor()

  await addBox(page, 40, 30, [
    h(2, 'Deploy'),
    ol(
      li('Freeze merges to ', code('main'), ' and tag ', code('v2.4.0')),
      li('Run the migration dry run (prints SQL only):'),
      li('Roll out the API, then watch error rates for 10 min'),
    ),
    block('bash', 'kubectl -n api rollout restart deploy/api\nkubectl -n api rollout status deploy/api --timeout=120s\n./scripts/smoke.sh https://staging.example.com'),
    p('Copying these gives clean text: real numbers, no smart quotes, no stray characters.'),
  ], 560)
  await addBox(page, 640, 30, [
    h(3, 'Checklist'),
    ul(li('☑ Changelog reviewed'), li('☑ Feature flags default ', bold('off')), li('☐ Status page drafted'), li('☐ Ping #release when done')),
    p('PR: ', link('github.com/acme/api/pull/1842', 'https://github.com/acme/api/pull/1842')),
  ], 380)
  await addBox(page, 640, 270, [
    h(3, 'Owners'),
    table([
      ['Service', 'Owner', 'Status'],
      ['api', 'Priya', 'ready'],
      ['billing', 'Sam', 'blocked'],
      ['search', 'Wei', 'ready'],
    ]),
  ], 380)
  const secret = await addBox(page, 40, 470, [
    h(3, 'Rollback'),
    p('Credentials live in the vault, never in notes. This box is private: AI agents never see it.'),
    block('bash', 'helm rollback api 41 -n api'),
  ], 560)
  await page.locator(`[data-box-id="${secret}"] [data-testid="box-lock"]`).click()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)

  await theme(page, 'builtin:dark')
  await page.screenshot({ path: join(out, 'dark.png') })
  for (const [id, file] of [['builtin:paper', 'paper.png'], ['builtin:glass', 'glass.png'], ['builtin:folio', 'folio.png'], ['builtin:light', 'light.png']]) {
    await theme(page, id)
    await page.screenshot({ path: join(out, file) })
  }

  // Search across notes, scoped to a section.
  await theme(page, 'builtin:dark')
  await page.keyboard.press(`${MOD}+Shift+f`)
  await page.keyboard.type('kubectl')
  await page.waitForTimeout(800)
  await page.screenshot({ path: join(out, 'search.png') })

  // Settings > Appearance.
  await page.keyboard.press(`${MOD}+,`)
  await page.getByText('Appearance', { exact: true }).first().click()
  await page.waitForTimeout(600)
  await page.screenshot({ path: join(out, 'themes.png') })

  await app.close()
  console.log(`screenshots written to ${out}`)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
