// Review C6 (LOW, S-7 c): database calls reach the module-fault watch too. A connection opened through
// openDatabase reports every error of its constructor, its statements and itself to `onDatabaseError`, which
// index.ts classifies (`databaseFault`) and escalates like any other module fault.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SlateNative } from '@slate/native'
import { afterEach, describe, expect, it } from 'vitest'
import { databaseFault } from '../vault/selftest/supervisor'
import { dbModule, provideDbModule, type DbModule } from './dbModule'
import { openDatabase } from './openDatabase'

let restore: DbModule | null = null
afterEach(() => {
  const back = restore
  if (back) provideDbModule(() => back)
  restore = null
})

describe('database errors reach the module-fault watch', () => {
  it('reports errors from the constructor, a statement and the connection, and rethrows each', () => {
    restore = dbModule()
    const seen: unknown[] = []
    provideDbModule(() => ({ native: restore!.native, requireFips: false, onDatabaseError: (e) => void seen.push(e) }))
    const dir = mkdtempSync(join(tmpdir(), 'slate-dbwatch-'))
    // A URI file name is refused by the module (SCC_1) before SQLite sees it.
    expect(() => openDatabase(`file:${join(dir, 'x.db')}`, null)).toThrow()
    const db = openDatabase(join(dir, 'a.db'), null)
    expect(() => db.prepare('SELEC nothing')).toThrow()
    const stmt = db.prepare('SELECT ? AS v')
    expect(() => stmt.get()).toThrow()
    expect(stmt.get(1)).toEqual({ v: 1 })
    expect(() => db.exec('CREATE TABLE')).toThrow()
    db.close()
    expect(seen).toHaveLength(4)
  })

  it('classifies a database error: an SCC code as a module error, a plain SQLite error only in the error state', () => {
    const status = (errorState: boolean) => ({ status: () => ({ errorState }) }) as unknown as SlateNative
    const scc = (code: string) => Object.assign(new Error(code), { code })
    expect(databaseFault(scc('SCC_12'), status(false))).toBe('error-state')
    expect(databaseFault(scc('SQLITE_ERROR'), status(false))).toBeNull()
    // A provider fault SQLCipher's codec met first surfaces as a plain SQLite error; the module latched meanwhile.
    expect(databaseFault(scc('SQLITE_ERROR'), status(true))).toBe('error-state')
    expect(databaseFault(scc('SCC_1'), status(false))).toBeNull()
  })
})
