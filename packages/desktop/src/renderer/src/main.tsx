import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './ai.css'
import './activity.css'
import './app.css'
import './sidebar.css'
import './toolbar.css'
import { installErrorForwarding } from './diagnosticsErrors'
import { installTestHooks } from './testHooks'

if (window.slate.isE2E) installTestHooks()
installErrorForwarding()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
