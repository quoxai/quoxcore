/**
 * useSoundStubs — Placeholder sound API for Cognitive Core 3D.
 *
 * Phase CC-14: Sound design stubs.
 * No actual audio playback — just the function signatures and event mapping.
 * When real audio is added, replace the noop implementations with Howler/Tone.js.
 *
 * Usage in scene components:
 *   const { playHeartbeat, playSelect, playDelegate, playAlert } = useSoundStubs()
 */
import { useCallback, useRef } from 'react'

// Stub: logs to console in dev mode only
const isDev = typeof process !== 'undefined' && process.env?.NODE_ENV === 'development'
const noop = () => {}
const devLog = isDev ? (name) => { /* console.debug(`[Sound] ${name}`) */ } : noop

/**
 * Sound event stubs for CC3D.
 * Each returns a no-op function that can be called from scene components.
 * When real audio is implemented, these become actual playback triggers.
 */
export default function useSoundStubs({ enabled = false } = {}) {
  const lastPlayRef = useRef({})

  // Rate limiter: prevent sound spam (min interval per event type)
  const throttled = useCallback((name, minIntervalMs = 200) => {
    if (!enabled) return
    const now = Date.now()
    if (now - (lastPlayRef.current[name] || 0) < minIntervalMs) return
    lastPlayRef.current[name] = now
    devLog(name)
  }, [enabled])

  return {
    // Ambient: periodic heartbeat pulse
    playHeartbeat: useCallback(() => throttled('heartbeat', 5000), [throttled]),

    // Interaction: node selection click
    playSelect: useCallback(() => throttled('select', 100), [throttled]),

    // Interaction: void click (deselect)
    playDeselect: useCallback(() => throttled('deselect', 100), [throttled]),

    // System: delegation arc fired
    playDelegate: useCallback(() => throttled('delegate', 500), [throttled]),

    // System: task completed
    playComplete: useCallback(() => throttled('complete', 300), [throttled]),

    // System: alert / blocked agent
    playAlert: useCallback(() => throttled('alert', 2000), [throttled]),

    // Navigation: zone change
    playZoneChange: useCallback(() => throttled('zone-change', 1000), [throttled]),

    // Navigation: zoom to target (double-click)
    playZoom: useCallback(() => throttled('zoom', 500), [throttled]),

    // Ambient: simulation phase change
    playPhaseChange: useCallback(() => throttled('phase-change', 2000), [throttled]),
  }
}
