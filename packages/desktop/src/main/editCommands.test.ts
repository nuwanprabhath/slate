import { describe, expect, it } from 'vitest'
import { CH } from '../shared/ipc'
import { registerEditIpc } from './editCommands'
import type { Handler, IpcRegistrar } from './ipcGuard'

function setup() {
  const handlers = new Map<string, Handler>()
  const ipc: IpcRegistrar = { handle: (channel, handler) => void handlers.set(channel, handler), on: () => () => {} }
  registerEditIpc(ipc)
  const ran: string[] = []
  const sender = { cut: () => ran.push('cut'), copy: () => ran.push('copy'), paste: () => ran.push('paste'), pasteAndMatchStyle: () => ran.push('plain'), selectAll: () => ran.push('all'), reload: () => ran.push('reload') }
  const run = (command: unknown) => handlers.get(CH.editCommand)!({ sender } as never, command)
  return { run, ran }
}

describe('registerEditIpc', () => {
  it('runs cut, copy and paste on the window that asked, as the Edit menu does', () => {
    const { run, ran } = setup()
    run('cut')
    run('copy')
    run('paste')
    expect(ran).toEqual(['cut', 'copy', 'paste'])
  })

  it('refuses any other command or value without touching the window', () => {
    const { run, ran } = setup()
    for (const command of ['reload', 'selectAll', 'pasteAndMatchStyle', 'constructor', '__proto__', 'toString', '', null, 1, ['paste'], { toString: () => 'paste' }]) {
      expect(() => run(command)).toThrow(/edit command/)
    }
    expect(ran).toEqual([])
  })
})
