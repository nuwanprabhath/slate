import { describe, expect, it } from 'vitest'
import { isSafeExternalUrl, openExternalSafe } from './openExternal'

describe('openExternalSafe', () => {
  it('hands https and mailto links to the system', async () => {
    const opened: string[] = []
    const open = (url: string) => {
      opened.push(url)
      return Promise.resolve()
    }
    expect(await openExternalSafe('https://example.com/docs', open)).toBe(true)
    expect(await openExternalSafe('MAILTO:ann@example.com', open)).toBe(true)
    expect(opened).toEqual(['https://example.com/docs', 'mailto:ann@example.com'])
  })

  it('refuses every other scheme, so a link in a note cannot launch a program or read a file', async () => {
    const opened: string[] = []
    const open = (url: string) => {
      opened.push(url)
      return Promise.resolve()
    }
    for (const url of ['http://example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'smb://host/share', 'vscode://x', 'ms-msdt:/id', ' https://x.dev', 'https:', 'not a url', '', 42, null]) {
      expect(await openExternalSafe(url, open), String(url)).toBe(false)
    }
    expect(opened).toEqual([])
  })

  it('refuses control characters the URL parser would silently drop (security review LOW-1)', async () => {
    const opened: string[] = []
    const open = (url: string) => {
      opened.push(url)
      return Promise.resolve()
    }
    for (const url of ['\x01mailto:x@y', '\x00mailto:x', 'ma\nilto:x@y', 'm\tailto:\\\\host\\share\\a.exe', 'https://x.dev/\x7fa', 'https://x.dev/a\tb']) {
      expect(await openExternalSafe(url, open), JSON.stringify(url)).toBe(false)
    }
    expect(opened).toEqual([])
  })

  it('hands the system the canonical URL it validated, not the raw string', async () => {
    const opened: string[] = []
    await openExternalSafe('HTTPS://Example.com/a b', (u) => {
      opened.push(u)
      return Promise.resolve()
    })
    expect(opened).toEqual(['https://example.com/a%20b'])
  })

  it('judges by the parsed URL, not a prefix', () => {
    expect(isSafeExternalUrl('https://example.com')).toBe(true)
    expect(isSafeExternalUrl('https:\\\\evil')).toBe(false)
    expect(isSafeExternalUrl('https://')).toBe(false)
  })
})
