import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ImportProgress } from '@slate/importer'
import { FileBlobStore } from '../blobs'
import { IMPORT_ENCRYPTED_MESSAGE, vaultExists } from '../db/vaultGate'
import { runningHolder } from '../lock'
import { defaultUserDataDir } from '../paths'
import { converterPath, defaultConverterDirs } from './backup'
import { ImportService } from './importService'

export interface CliIo {
  out: (text: string) => void
  err: (text: string) => void
}

interface Args {
  backup: string[]
  sections: string[]
  userData?: string
}

function parseArgs(argv: string[]): Args | string {
  const args: Args = { backup: [], sections: [] }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!
    if (flag === '--backup') {
      // Takes every value up to the next flag.
      while (i + 1 < argv.length && !argv[i + 1]!.startsWith('--')) args.backup.push(argv[++i]!)
    } else if (flag === '--sections') {
      args.sections = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    } else if (flag === '--user-data') {
      args.userData = argv[++i]
    } else return `Unknown argument ${flag}`
  }
  return args.backup.length === 0 ? 'Usage: import-cli --backup <path>… [--sections <name,…>] [--user-data <dir>]' : args
}

/** Imports OneNote backup files into a Slate data folder with no window. Returns the exit code. */
export async function runImportCli(argv: string[], io: CliIo): Promise<number> {
  const args = parseArgs(argv)
  if (typeof args === 'string') {
    io.err(args)
    return 2
  }
  const dir = args.userData ?? defaultUserDataDir()
  mkdirSync(dir, { recursive: true })
  if (vaultExists(dir)) {
    io.err(IMPORT_ENCRYPTED_MESSAGE)
    return 3
  }
  const holder = runningHolder(dir)
  if (holder !== null) {
    io.err(`Slate is running (pid ${holder}) and has this data folder open. Quit it, then run the import again.`)
    return 3
  }
  const noAuth = {
    status: async () => ({ configured: false, signedIn: false }),
    signIn: async () => {},
    signOut: async () => {},
    token: async (): Promise<string> => {
      throw new Error('Not available in the headless import')
    },
  }
  let last = ''
  const service = new ImportService({
    dbFile: join(dir, 'slate.db'),
    blobs: new FileBlobStore(join(dir, 'blobs')),
    auth: noAuth,
    graphUrl: '',
    converter: converterPath(defaultConverterDirs()),
    emit: (p: ImportProgress) => {
      const line = `section ${Math.min(p.sectionsDone + 1, p.sectionsTotal)}/${p.sectionsTotal} page ${p.pagesDone}/${p.pagesTotal} ${p.currentTitle ?? ''}`.trim()
      if (line !== last) io.err(line)
      last = line
    },
  })
  try {
    const result = await service.startBackup(args.backup, args.sections)
    io.out(JSON.stringify(result, null, 2) + '\n')
    return result.failed.length > 0 ? 1 : 0
  } catch (e) {
    io.err(e instanceof Error ? e.message : String(e))
    return 1
  } finally {
    service.close()
  }
}
