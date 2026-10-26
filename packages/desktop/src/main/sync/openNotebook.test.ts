import { describe, expect, it } from 'vitest'
import { pickNotebook, type NotebookFacts } from './openNotebook'

const nb = (id: string, openOn: Record<string, number>, modifiedAt = 0, empty = false): NotebookFacts => ({ id, openOn, modifiedAt, empty })
const ME = 'me'

describe('pickNotebook', () => {
  it("picks the notebook another device opened most recently over the empty default", () => {
    const notebooks = [nb('default', { me: 500 }, 500, true), nb('work', { mac: 300 }), nb('home', { mac: 100, pc: 400 })]
    expect(pickNotebook({ notebooks, deviceId: ME, current: 'default', userChose: false })).toBe('home')
  })

  it("ignores this device's own openings", () => {
    const notebooks = [nb('default', { me: 500 }, 500, true), nb('work', { mac: 300 }), nb('old', { me: 900 })]
    expect(pickNotebook({ notebooks, deviceId: ME, current: 'default', userChose: false })).toBe('work')
  })

  it('falls back to the most recently modified notebook', () => {
    const notebooks = [nb('default', {}, 0, true), nb('a', {}, 10), nb('b', {}, 30), nb('c', {}, 20)]
    expect(pickNotebook({ notebooks, deviceId: ME, current: 'default', userChose: false })).toBe('b')
  })

  it('switches when nothing is open yet', () => {
    expect(pickNotebook({ notebooks: [nb('work', { mac: 1 })], deviceId: ME, current: null, userChose: false })).toBe('work')
  })

  it('never switches once the user chose', () => {
    const notebooks = [nb('default', {}, 0, true), nb('work', { mac: 300 })]
    expect(pickNotebook({ notebooks, deviceId: ME, current: 'default', userChose: true })).toBeNull()
  })

  it('never switches away from a notebook with content', () => {
    const notebooks = [nb('mine', { me: 1 }), nb('work', { mac: 300 })]
    expect(pickNotebook({ notebooks, deviceId: ME, current: 'mine', userChose: false })).toBeNull()
  })

  it('does not move from one empty notebook to another', () => {
    const notebooks = [nb('default', {}, 0, true), nb('their-default', { mac: 300 }, 300, true)]
    expect(pickNotebook({ notebooks, deviceId: ME, current: 'default', userChose: false })).toBeNull()
  })

  it('is null when there is nothing else to open', () => {
    expect(pickNotebook({ notebooks: [nb('default', {}, 0, true)], deviceId: ME, current: 'default', userChose: false })).toBeNull()
  })
})
