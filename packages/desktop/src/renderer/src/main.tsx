import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './ai.css'
import './activity.css'
import './app.css'
import './controls.css'
import './sidebar.css'
import './toolbar.css'
import { installErrorForwarding } from './diagnosticsErrors'
import { installTestHooks } from './testHooks'
import { ThemeLayer } from './theme/ThemeLayer'
import { startTheme } from './theme/themeState'

if (window.slate.isE2E) installTestHooks()
// Before the first render, so the first paint already has the theme.
startTheme()
installErrorForwarding()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeLayer />
    <App />
  </StrictMode>,
)
