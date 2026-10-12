import ErrorBoundary from '../ErrorBoundary'

// Outer boundary for the Qortex renderer switch (Phase 0 — stabilize the hero).
//
// Without this, a WebGL context loss or an R3F/three throw inside the brain or
// 3D renderer bubbles all the way to the GLOBAL app ErrorBoundary and blanks the
// ENTIRE /brain2 route (the "blank page" the paintNode guard comment warns about).
// Catching it locally keeps the rail, search, toolbar and note reader operable,
// and offers a route back into the always-safe 2D canvas renderer.
//
// Keyed by `mode`: the shared ErrorBoundary has no resetKeys, so we remount it on
// every view-mode change. That means switching renderer — via the toolbar OR the
// fallback's "Switch to 2D" button — clears a caught error automatically, rather
// than leaving the boundary stuck showing its fallback after the user has already
// moved to a renderer that would have worked.
export default function BrainRendererBoundary({ mode, onUse2D, children }) {
  const title =
    mode === 'brain' ? 'The brain visualiser hit a rendering error'
    : mode === '3d' ? 'The 3D graph hit a rendering error'
    : 'The graph hit a rendering error'

  return (
    <ErrorBoundary
      key={mode}
      fallback={({ error, retry }) => (
        <div className="qx-renderer-fallback" role="alert">
          <p className="qx-renderer-fallback__title">{title}</p>
          <p className="qx-renderer-fallback__body">
            Your notes and search are unaffected.{' '}
            {mode !== '2d'
              ? 'Switch to the 2D view to keep exploring, or try again.'
              : 'Try again to reload the view.'}
          </p>
          {error?.message && (
            <p className="qx-renderer-fallback__detail">{error.message}</p>
          )}
          <div className="qx-renderer-fallback__actions">
            {mode !== '2d' && (
              <button
                type="button"
                className="qx-btn qx-btn--primary"
                onClick={() => onUse2D?.()}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <path d="M3 9h18M9 21V9" />
                </svg>
                Switch to 2D view
              </button>
            )}
            <button type="button" className="qx-btn qx-btn--ghost" onClick={retry}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                <path d="M21 3v6h-6" />
              </svg>
              Try again
            </button>
          </div>
        </div>
      )}
    >
      {children}
    </ErrorBoundary>
  )
}
