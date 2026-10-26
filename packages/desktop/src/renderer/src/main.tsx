import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
// Bundled so the Folio themes' fonts work offline (shared/theme/fonts.ts names them).
import '@fontsource-variable/inter'
import '@fontsource-variable/source-serif-4'
import './ai.css'
import './activity.css'
import './app.css'
import './controls.css'
import './sidebar.css'
import './toolbar.css'
import { installErrorForwarding } from './diagnosticsErrors'
import { LockScreen } from './lock/LockScreen'
import { SelfTestFailed } from './lock/SelfTestFailed'
import { selfTestFailedCode } from './lock/selfTestText'
import { MigrationBanner } from './lock/MigrationBanner'
import { QuickUnlockOffer } from './lock/QuickUnlockOffer'
import { installVaultRelay } from './lock/relay'
import { installTestHooks } from './testHooks'
import { ThemeLayer } from './theme/ThemeLayer'
import { EncryptWizard } from './vault/EncryptWizard'
import { VaultBanners } from './vault/VaultBanners'
import { startTheme } from './theme/themeState'
import './settings/QuickUnlockRow'

// The main process loads `?lock=1` while an encrypted vault is locked: nothing here may call note IPC.
const locked = new URLSearchParams(location.search).has('lock')
// `?selftest-failed=<id>` after a failed self-test (C6, S-6): the error screen and nothing else.
const selfTestFailed = selfTestFailedCode(location.search)

if (window.slate.isE2E && !locked && selfTestFailed === null) installTestHooks()
// Before the first render, so the first paint already has the theme.
startTheme()
if (!locked && selfTestFailed === null) {
  installErrorForwarding()
  installVaultRelay()
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeLayer />
    {selfTestFailed !== null ? (
      <SelfTestFailed code={selfTestFailed} />
    ) : locked ? (
      <LockScreen />
    ) : (
      <>
        <MigrationBanner />
        <QuickUnlockOffer />
        <VaultBanners />
        <App />
        <EncryptWizard />
      </>
    )}
  </StrictMode>,
)
