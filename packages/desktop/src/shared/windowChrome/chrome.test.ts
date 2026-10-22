import { describe, expect, it } from 'vitest'
import { builtinTheme } from '../theme/builtins'
import { chromeOptions, isHexColor, TITLE_BAR_HEIGHT, titleBarColors, windowChromeFor } from './chrome'

describe('window chrome', () => {
  it('draws its own bar unless the system bar is asked for', () => {
    expect(windowChromeFor('darwin', false)).toBe('mac')
    expect(windowChromeFor('linux', false)).toBe('overlay')
    expect(windowChromeFor('win32', false)).toBe('overlay')
    expect(windowChromeFor('darwin', true)).toBe('system')
    expect(windowChromeFor('linux', true)).toBe('system')
  })

  it('maps each chrome to BrowserWindow options', () => {
    const colors = { background: '#112233', symbol: '#eeeeee' }
    expect(chromeOptions('system', colors)).toEqual({})
    const mac = chromeOptions('mac', colors)
    expect(mac.titleBarStyle).toBe('hiddenInset')
    // Traffic lights are about 16 px tall with their shadow: centred in the bar.
    expect(mac.trafficLightPosition?.y).toBe(Math.round((TITLE_BAR_HEIGHT - 16) / 2))
    expect(chromeOptions('overlay', colors)).toEqual({
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#112233', symbolColor: '#eeeeee', height: TITLE_BAR_HEIGHT },
    })
  })

  it('colours the bar from the toolbar token, opaque over the window colour', () => {
    const dark = titleBarColors(builtinTheme('builtin:dark')!.spec)
    expect(isHexColor(dark.background)).toBe(true)
    expect(isHexColor(dark.symbol)).toBe(true)
    const paper = titleBarColors(builtinTheme('builtin:paper')!.spec)
    expect(isHexColor(paper.background)).toBe(true)
    expect(paper.background).not.toBe(dark.background)
  })

  it('accepts only #rrggbb', () => {
    expect(isHexColor('#a1b2c3')).toBe(true)
    expect(isHexColor('red')).toBe(false)
    expect(isHexColor('#a1b2c3ff')).toBe(false)
  })
})
