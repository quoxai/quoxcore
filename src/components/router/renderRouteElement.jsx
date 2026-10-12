import { Suspense, createElement, isValidElement } from 'react'

// fleet #394: this is the shared fallback every lazy core route renders
// while its chunk loads, so it is "the page loading icon" the whole app
// shows. It had textAlign only — horizontally centred but pinned to the top
// of the content area, which reads as unstyled rather than as a deliberate
// loading state.
//
// Centred with flex on both axes. minHeight is 60vh rather than 100% or
// 100vh on purpose: this renders inside `.app-shell__content` (flex: 1,
// overflow-y: auto), so 100vh would overflow past the header and force a
// scrollbar, while `height: 100%` depends on the parent's height resolving
// — which it does today but is the kind of thing a layout change breaks
// silently. 60vh is tall enough to read as centred and cannot overflow.
export const ROUTE_FALLBACK_STYLE = {
  minHeight: '60vh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 40,
  textAlign: 'center',
  color: 'rgba(255,255,255,0.4)',
}

export function renderRouteElement(ComponentOrElement, fallbackText = 'Loading...') {
  if (isValidElement(ComponentOrElement)) {
    return ComponentOrElement
  }

  return (
    <Suspense fallback={<div style={ROUTE_FALLBACK_STYLE}>{fallbackText}</div>}>
      {createElement(ComponentOrElement)}
    </Suspense>
  )
}

export default renderRouteElement
