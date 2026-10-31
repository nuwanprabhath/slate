import { describe, expect, it } from 'vitest'
import { CH } from '../shared/ipc'
import { registerEditIpc, UserInputClock } from './editCommands'
import type { Handler, IpcRegistrar } from './ipcGuard'

function setup() {
  let now = 10_000
  const input = new UserInputClock(() => now)
  const handlers = new Map<string, Handler>()
  const ipc: IpcRegistrar = { handle: (channel, handler) => void handlers.set(channel, handler), on: () => () => {} }
  registerEditIpc(ipc, input)
  const ran: string[] = []
  const sender = { cut: () => ran.push('cut'), copy: () => ran.push('copy'), paste: () => ran.push('paste'), pasteAndMatchStyle: () => ran.push('plain'), selectAll: () => ran.push('all'), reload: () => ran.push('reload') }
  const run = (command: unknown, from: object = sender) => handlers.get(CH.editCommand)!({ sender: from } as never, command)
  return { run, ran, sender, input, tick: (ms: number) => (now += ms) }
}

describe('UserInputClock', () => {
  it('counts a mouse press on that window in the last second as a person acting', () => {
    let now = 0
    const clock = new UserInputClock(() => now)
    const a = {}
    const b = {}
    expect(clock.recent(a)).toBe(false)
    clock.note(a, 'mouseUp')
    expect(clock.recent(a)).toBe(true)
    expect(clock.recent(b)).toBe(false)
    now = 1000
    expect(clock.recent(a)).toBe(true)
    now = 1001
    expect(clock.recent(a)).toBe(false)
    for (const type of ['mouseDown', 'mouseUp']) {
      clock.note(b, type)
      expect(clock.recent(b)).toBe(true)
      now += 2000
    }
  })

  it('does not count a key press: the text menu is mouse-only, and typing must not open a paste window', () => {
    const clock = new UserInputClock(() => 0)
    const a = {}
    for (const type of ['keyDown', 'rawKeyDown', 'keyUp', 'char']) clock.note(a, type)
    expect(clock.recent(a)).toBe(false)
  })

  it('ignores input that is not a press: moves, wheels, focus', () => {
    const clock = new UserInputClock(() => 0)
    const a = {}
    for (const type of ['mouseMove', 'mouseEnter', 'mouseLeave', 'mouseWheel', 'keyUp', 'char', 'gestureScrollBegin', 'touchStart', '']) clock.note(a, type)
    expect(clock.recent(a)).toBe(false)
  })
})

describe('registerEditIpc', () => {
  it('runs cut, copy and paste on the window that asked, right after a person pressed something there', () => {
    const { run, ran, sender, input } = setup()
    input.note(sender, 'mouseUp')
    run('cut')
    run('copy')
    run('paste')
    expect(ran).toEqual(['cut', 'copy', 'paste'])
  })

  it('refuses a command no recent press on that window asked for, so a page cannot paste the rich clipboard by itself', () => {
    const { run, ran, sender, input, tick } = setup()
    for (const command of ['paste', 'copy', 'cut']) expect(() => run(command)).toThrow(/user input/)
    input.note(sender, 'keyDown')
    expect(() => run('paste')).toThrow(/user input/)
    input.note(sender, 'mouseUp')
    tick(1500)
    expect(() => run('paste')).toThrow(/user input/)
    input.note({}, 'mouseUp')
    expect(() => run('paste')).toThrow(/user input/)
    expect(ran).toEqual([])
  })

  it('refuses any other command or value without touching the window', () => {
    const { run, ran, sender, input } = setup()
    input.note(sender, 'mouseUp')
    for (const command of ['reload', 'selectAll', 'pasteAndMatchStyle', 'constructor', '__proto__', 'toString', '', null, 1, ['paste'], { toString: () => 'paste' }]) {
      expect(() => run(command)).toThrow(/edit command/)
    }
    expect(ran).toEqual([])
  })
})
