// `npm run e2e [-- <filters and flags>]`: Playwright twice with the same arguments. First the `parallel` and
// `os-shared` projects side by side, then `perf` alone, so no other app skews the performance budgets
// (playwright.config.ts). A Playwright dependency would order them too, but a dependency project ignores file
// filters: `npm run e2e -- spec/` would run the whole suite. A run that names its own --project is passed through.
// A phase its filters match nothing in is skipped; a run that matches nothing at all fails, as Playwright does.
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
const projectArgs = (projects) => projects.map((p) => `--project=${p}`) // `--project a b` would take the filters as project names
const playwright = (extra, options) => spawnSync('npx', ['playwright', 'test', ...extra, ...args], options)

/** How many tests these projects hold under the run's filters. Only "No tests found" counts as none: any other
 * listing error (a spec that fails to load, a duplicate title) would empty the phase, so it stops the run. */
function count(projects) {
  const listed = playwright([...projectArgs(projects), '--list', '--reporter=json'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  let report
  try {
    report = JSON.parse(listed.stdout)
  } catch {
    process.stderr.write(`${listed.stdout ?? ''}${listed.stderr ?? ''}`)
    throw new Error(`e2e: could not list the tests of ${projects.join(', ') || 'the named projects'}`)
  }
  const errors = (report.errors ?? []).filter((e) => !/^Error: No tests found/.test(e.message ?? ''))
  if (errors.length > 0) {
    for (const e of errors) process.stderr.write(`${e.message ?? JSON.stringify(e)}\n`)
    process.exit(1)
  }
  const tests = (suite) => (suite.specs ?? []).reduce((n, s) => n + s.tests.length, 0) + (suite.suites ?? []).reduce((n, s) => n + tests(s), 0)
  return (report.suites ?? []).reduce((n, s) => n + tests(s), 0)
}

const phases = args.some((a) => a === '--project' || a.startsWith('--project=')) ? [[]] : [['parallel', 'os-shared'], ['perf']]
const runnable = phases.filter((projects) => count(projects) > 0)
if (runnable.length === 0) {
  process.stderr.write(`e2e: no tests found for: ${args.join(' ') || '(no filter)'}\n`)
  process.exit(1)
}
let status = 0
for (const projects of runnable) status = (playwright(projectArgs(projects), { stdio: 'inherit' }).status ?? 1) || status
process.exit(status)
