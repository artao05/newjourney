import { StrictMode, lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

/**
 * `?harness` mounts the map-layer dev harness instead of the app. Lazy so the
 * harness never ships in the main bundle, and dev-only so a stray query string
 * in production cannot replace the app.
 */
const LayerHarness = lazy(() =>
  import('./dev/LayerHarness').then((m) => ({ default: m.LayerHarness })),
)

const useHarness =
  import.meta.env.DEV && new URLSearchParams(location.search).has('harness')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {useHarness ? (
      <Suspense fallback={null}>
        <LayerHarness />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
)

// Offline shell. Registered late so a broken SW can never block first paint.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js').catch(() => {
      /* offline support is a bonus, not a requirement for the app to run */
    })
  })
}
