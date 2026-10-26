// POAM-16, maintainer decision 2026-10-26 ("Force setuid sandbox; AppImage warns"): every launch of the .deb
// carries --disable-namespace-sandbox on the real command line (Chromium reads it before the zygote starts, so
// app.commandLine.appendSwitch is too late), so the renderers, the lock screen's included, run in the setuid
// sandbox: seccomp-bpf AND non-dumpable. Both launch paths need it: the desktop entry (deb.executableArgs) and
// the `slate` command (the /usr/bin wrapper the after-install writes), and chrome-sandbox must be setuid root.
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { read, ROOT } from './repo'

const FLAG = '--disable-namespace-sandbox'
const config = createRequire(join(ROOT, 'packages/desktop/'))('./electron-builder.cjs') as {
  deb?: { executableArgs?: string[]; afterInstall?: string; afterRemove?: string }
  linux?: { executableArgs?: string[] }
}

describe('POAM-16: the .deb always runs the setuid sandbox', () => {
  it(`the .deb's desktop entry passes ${FLAG}`, () => {
    expect(config.deb?.executableArgs ?? [], `put '${FLAG}' in deb.executableArgs in packages/desktop/electron-builder.cjs`).toContain(FLAG)
  })

  it('the flag is the .deb\'s only: the AppImage has no setuid chrome-sandbox, and the flag would stop it starting', () => {
    expect(config.linux?.executableArgs ?? []).not.toContain(FLAG)
  })

  const install = read(join('packages/desktop', config.deb?.afterInstall ?? 'build/linux-after-install.sh'))

  it(`the after-install makes /usr/bin/slate a wrapper that passes ${FLAG}, not a bare link`, () => {
    expect(install, 'the after-install must not link /usr/bin straight to the binary').not.toMatch(/ln\s+-s\S*\s+'\/opt\/[^']+'\s+'\/usr\/bin\//)
    expect(install).toMatch(new RegExp(`exec '/opt/\\$\\{sanitizedProductName\\}/\\$\\{executable\\}' ${FLAG} "\\$@"`))
  })

  it('the after-install makes chrome-sandbox root-owned and setuid (4755), and does not swallow a failure', () => {
    expect(install).toMatch(/chown root:root '\/opt\/\$\{sanitizedProductName\}\/chrome-sandbox'/)
    expect(install).toMatch(/chmod 4755 '\/opt\/\$\{sanitizedProductName\}\/chrome-sandbox'(?!\s*\|\|)/)
  })

  it('the after-remove removes the wrapper', () => {
    expect(config.deb?.afterRemove, 'set deb.afterRemove so the /usr/bin wrapper goes with the package').toBeDefined()
    expect(read(join('packages/desktop', config.deb?.afterRemove ?? ''))).toMatch(/rm -f '\/usr\/bin\/\$\{executable\}'/)
  })
})
