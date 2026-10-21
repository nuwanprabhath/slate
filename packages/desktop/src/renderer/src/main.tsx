import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './app.css'
import './sidebar.css'
import './toolbar.css'
import { installTestHooks } from './testHooks'

if (window.slate.isE2E) installTestHooks()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
