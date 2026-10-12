import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import FeedbackModal from './components/feedback/FeedbackModal.jsx'
import ErrorToast from './components/feedback/ErrorToast.jsx'
import { initDummyDataSystem } from './services/dummyData'
import { initHeartbeat } from './services/heartbeatService'
import { initErrorCapture } from './services/errorCaptureService'
import { initializeCapabilityIndex } from './services/capabilityIndex'
import { initPluginHost, loadInstalledPlugins, markPluginsHydrated } from './services/thirdPartyPluginHost'
import { initAppearance } from './services/appearance'
import { initLivingFavicon } from './services/livingFavicon'
import { initGovernanceIncidentReporter } from './services/governanceIncidentReporter'

// One-time cleanup for legacy CLARITY-CONSOLE-8 garbage keys.
// Safe to remove after a few months when most users have rebooted.
;['setItem', '_dpRefreshTimeout'].forEach((k) => {
  try { localStorage.removeItem(k) } catch {}
})

// Apply saved background appearance BEFORE anything else paints
initAppearance()
initLivingFavicon()

// MON-GOV: browser-side policy alerts POST to the governance incidents API
initGovernanceIncidentReporter()

// Initialize dummy data system (syncs setting with data state)
initDummyDataSystem()

// Initialize telemetry heartbeat (only sends if user opted in)
initHeartbeat()

// Initialize global error capture (opt-in reporting)
initErrorCapture()

// Initialize capability index (loads assistants, tools, workflows for Cognitive Topology)
initializeCapabilityIndex()

// Initialize third-party plugin host (expose shared deps, set up registration callback)
initPluginHost()

// Load installed third-party plugins (async, non-blocking). Once this settles
// (success OR failure), mark hydration complete so the router's catch-all can
// safely redirect unmatched /plugins/* URLs — before this point a hard refresh
// on a plugin page would race the async route registration and bounce home.
loadInstalledPlugins().catch(err => {
    console.warn('[main] Failed to load third-party plugins:', err)
}).finally(() => {
    markPluginsHydrated()
})

// Note: StrictMode removed due to WebSocket connection issues
// StrictMode causes double-mounting in development which can interfere with WebSocket connections
const root = createRoot(document.getElementById('root'))

root.render(
  <ErrorBoundary>
    <App onReady={() => {
      // Hide boot loader once React is mounted
      if (window.hideBootLoader) {
        window.hideBootLoader()
      }
    }} />
    <FeedbackModal hideFab />
    <ErrorToast />
  </ErrorBoundary>
)
