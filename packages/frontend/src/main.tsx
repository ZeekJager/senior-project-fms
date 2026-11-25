import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import App from './App'
import './index.css'
import { initErrorTracking } from './lib/errorTracking'

// Error tracking (FMS-109): off unless the build has VITE_SENTRY_DSN.
initErrorTracking()

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
