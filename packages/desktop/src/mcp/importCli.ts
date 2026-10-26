import { provideCliDbModule } from '../main/db/dbModule'
import { runImportCli } from '../main/onenote/importCli'

provideCliDbModule(__dirname)

// Run with ELECTRON_RUN_AS_NODE=1 (see bin/). stdout carries the JSON report only.
void runImportCli(process.argv.slice(2), {
  out: (t) => process.stdout.write(t),
  err: (t) => process.stderr.write(t + '\n'),
}).then((code) => process.exit(code))
