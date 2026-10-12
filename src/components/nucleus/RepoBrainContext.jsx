/**
 * RepoBrainContext — shared status for the RepoBrain surface.
 *
 * Replaces three duplicated per-tab health probes (CodeSearch, ManageRepos,
 * CodebaseGraph each ran their own getHealth() on mount) with a single probe
 * owned by RepoBrainView, shared via context. Also holds the target list and
 * the latest query latency so the command strip can show them.
 *
 * PERFORMANCE (Wave 1 + follow-up): the last-known status lives in a
 * MODULE-LEVEL cache that survives component unmount/remount. Navigating away
 * from RepoBrain and back (or any remount) renders the cached status INSTANTLY
 * and revalidates silently in the background, instead of showing a "Connecting
 * to RepoBrain..." spinner and blocking on a fresh (sometimes cold, 10-20s)
 * proxy round-trip every time. Only the very first probe of a session, when
 * there is nothing cached, shows the checking state.
 *
 * HEALTH STATES (fleet issue #363): `health` is one of 'checking' | 'online' |
 * 'offline' | 'unauthorized' | 'unlicensed'. The last two used to collapse into
 * 'offline': a 401 (no org context) or 403 (RepoBrain not licensed) from the
 * collector's nucleus proxy looked identical to the engine genuinely being down,
 * so a user with a healthy engine would go restart it. `reason` carries the
 * collector's own error string when one of those two fires, for consumers that
 * want to show it verbatim.
 */
import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { getHealth, getTargets } from '../../services/nucleusClient'

const RepoBrainContext = createContext(null)

// Survives unmount/remount for the life of the page (module scope). Health is
// null until the first probe resolves; after that it holds the last-known good
// value so remounts are instant.
const statusCache = { health: null, reason: null, targets: [], ts: 0 }
// How long a cached status is trusted as-is on remount. Within this window a
// remount shows the cached status immediately and revalidates in the background.
const FRESH_MS = 120000

export function RepoBrainProvider({ children }) {
  // Seed from the module cache so a remount paints the known status with no flash.
  const [health, setHealth] = useState(() => statusCache.health || 'checking')
  const [reason, setReason] = useState(() => statusCache.reason)
  const [targets, setTargets] = useState(() => statusCache.targets)
  const [lastQueryMs, setLastQueryMs] = useState(null)
  const inFlight = useRef(false)

  const probe = useCallback(async ({ silent = false } = {}) => {
    if (inFlight.current) return
    inFlight.current = true
    // Only surface the checking state when we have nothing to show yet. A silent
    // revalidate keeps the current (cached) status on screen while it refreshes.
    if (!silent && !statusCache.health) setHealth('checking')
    try {
      const [h, t] = await Promise.all([
        getHealth().catch(() => ({ status: 'offline' })),
        getTargets().catch(() => []),
      ])
      const status = h?.status === 'unauthorized' ? 'unauthorized'
        : h?.status === 'unlicensed' ? 'unlicensed'
        : h?.status === 'offline' ? 'offline'
        : 'online'
      const list = Array.isArray(t) ? t : []
      statusCache.health = status
      statusCache.reason = (status === 'unauthorized' || status === 'unlicensed') ? (h?.reason || null) : null
      // Keep the last non-empty target list if a revalidation transiently returns
      // empty (a cold blip), so the "N repos indexed" count does not flicker.
      statusCache.targets = list.length ? list : statusCache.targets
      statusCache.ts = Date.now()
      setHealth(status)
      setReason(statusCache.reason)
      setTargets(statusCache.targets)
    } finally {
      inFlight.current = false
    }
  }, [])

  useEffect(() => {
    const age = Date.now() - statusCache.ts
    const haveFresh = statusCache.health && age < FRESH_MS
    // Fresh cache: show it instantly, revalidate quietly. Stale or none: probe
    // (only shows "checking" if there is truly nothing cached yet).
    probe({ silent: haveFresh })
  }, [probe])

  const value = useMemo(() => ({
    health,
    reason,
    targets,
    targetCount: targets.length,
    lastQueryMs,
    setLastQueryMs,
    refresh: () => probe({ silent: false }),
  }), [health, reason, targets, lastQueryMs, probe])

  return (
    <RepoBrainContext.Provider value={value}>
      {children}
    </RepoBrainContext.Provider>
  )
}

export function useRepoBrainStatus() {
  const ctx = useContext(RepoBrainContext)
  if (!ctx) {
    throw new Error('useRepoBrainStatus must be used within a RepoBrainProvider')
  }
  return ctx
}
