import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'
import './styles/covers.css'
import './styles/layout.css'
import './styles/pages.css'
import './styles/reader.css'
import App from './App.tsx'
import { startApp } from './app/startup'
import { isNativeApp } from './platform'

startApp()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

if (!isNativeApp && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      // Offline support is best-effort; the online app works without a service worker.
    })
  })
}
