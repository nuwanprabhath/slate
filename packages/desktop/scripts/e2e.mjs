// `npm run e2e [-- <filters and flags>]`: Playwright twice with the same arguments. First the `parallel` and
// `os-shared` projects side by side, then `perf` alone, so no other app skews the performance budgets
// (playwright.config.ts). A Playwright dependency would order them too, but a dependency project ignores file
// filters: `npm run e2e -- spec/` would run the whole suite. A run that names its own --project is passed through.
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
const playwright = (projects) =>
  spawnSync('npx', ['playwright', 'test', ...projects.flatMap((p) => ['--project', p]), '--pass-with-no-tests', ...args], { stdio: 'inherit' }).status ?? 1

const phases = args.some((a) => a === '--project' || a.startsWith('--project=')) ? [[]] : [['parallel', 'os-shared'], ['perf']]
let status = 0
for (const projects of phases) status = playwright(projects) || status
process.exit(status)
