import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import { detectIntent, isReadOnlyOperation } from '../utils/intentDetector'
import { useHealth } from './HealthContext'
import { useAuth } from './AuthContext'
import { queueSync } from '../services/serverSyncQueue'
import { getSafetyStatus, setDefconLevel as apiSetDefconLevel } from '../services/safetyGateClient'

// DEFCON levels with their properties
export const DEFCON_LEVELS = {
  GREEN: { level: 5, name: 'GREEN', color: '#30ff90', approval: 'none', description: 'Safe operations' },
  BLUE: { level: 4, name: 'BLUE', color: '#3090ff', approval: 'log_only', description: 'Low risk, logged' },
  AMBER: { level: 3, name: 'AMBER', color: '#ffb030', approval: 'human_confirm', description: 'Requires confirmation' },
  ORANGE: { level: 2, name: 'ORANGE', color: '#ff6b30', approval: 'two_step', description: 'Two-step verification' },
  RED: { level: 1, name: 'RED', color: '#38bdf8', approval: 'manual_only', description: 'Authorization code required' }
}

// Default context value
const defaultSafetyState = {
  // Kill switch
  killSwitchActive: false,
  killSwitchActivatedAt: null,

  // DEFCON
  currentDefcon: 'GREEN',
  // quox#503: server-authoritative instance DEFCON, null until loaded
  serverDefcon: null,

  // Modes
  dryRunMode: false,

  // Pending operations
  pendingOperation: null,

  // Functions (will be overwritten by provider)
  activateKillSwitch: () => Promise.resolve(null),
  deactivateKillSwitch: () => Promise.resolve(false),
  setInstanceDefcon: () => Promise.resolve(false),
  setDryRunMode: () => {},
  requestOperation: () => Promise.resolve({ allowed: false }),
  clearPendingOperation: () => {},
  getDefconForOperation: () => 'GREEN'
}

const SafetyContext = createContext(defaultSafetyState)

// Generate deactivation code
function generateDeactivationCode() {
  const timestamp = Date.now().toString(36).slice(-4).toUpperCase()
  return `SAFE-${timestamp}`
}

// Load consolidated safety state from localStorage
function loadSafetyState() {
  try {
    const raw = localStorage.getItem('quox-safety-state')
    if (raw) return JSON.parse(raw)
  } catch { /* fall through */ }

  // Migrate from old per-key storage
  const migrated = {
    killSwitch: localStorage.getItem('quox-kill-switch') === 'true',
    killCode: localStorage.getItem('quox-kill-code') || null,
    defcon: localStorage.getItem('quox-defcon') || 'GREEN',
    dryRun: localStorage.getItem('quox-dry-run') === 'true',
  }
  const hadOld = ['quox-kill-switch', 'quox-kill-code', 'quox-defcon', 'quox-dry-run']
    .some(k => localStorage.getItem(k) !== null)
  if (hadOld) {
    localStorage.setItem('quox-safety-state', JSON.stringify(migrated))
    ;['quox-kill-switch', 'quox-kill-code', 'quox-defcon', 'quox-dry-run'].forEach(k => localStorage.removeItem(k))
    console.log('[Safety] Migrated from per-key to consolidated storage')
  }
  return migrated
}

function saveSafetyState(state) {
  try {
    localStorage.setItem('quox-safety-state', JSON.stringify(state))
    queueSync('safetyState', state)
  } catch { /* quota */ }
}

export function SafetyProvider({ children }) {
  const initialState = useRef(loadSafetyState()).current

  // Kill switch state. localStorage (initialState) is a CACHE for instant
  // paint only — quox#503 makes the collector's instance-wide DEFCON the
  // source of truth (org_id-scoped, services/collector/lib/killSwitchStore.js).
  // A fresh browser with no cache must see the same halt state as the one
  // that pressed E-STOP; the server-load effect below reconciles this local
  // guess against the server the moment auth is available.
  const [killSwitchActive, setKillSwitchActive] = useState(initialState.killSwitch || false)
  const [killSwitchActivatedAt, setKillSwitchActivatedAt] = useState(null)
  const [deactivationCode, setDeactivationCode] = useState(initialState.killCode || null)

  // DEFCON state. `currentDefcon` keeps its pre-existing meaning (a local,
  // per-operation risk classification driven by getDefconForOperation() /
  // the health-based escalation effect below — unrelated to quox#503).
  // `serverDefcon` is the NEW, org-scoped, server-authoritative instance
  // DEFCON level; the console kill switch (E-STOP) maps onto it at RED,
  // which is the same "full halt" meaning killSwitchStore.js's level table
  // gives DEFCON RED server-side.
  const [currentDefcon, setCurrentDefcon] = useState(initialState.defcon || 'GREEN')
  const [serverDefcon, setServerDefcon] = useState(null)
  const { isAuthenticated } = useAuth()

  // Health-aware DEFCON — raise level when services are down
  // `unreachable` means we could not ask, not that services are down. Raising
  // DEFCON on a browser-side connection blip would cry wolf; the health badge
  // says "Platform unreachable" instead, which is the honest place for it.
  const { downCount = 0, degradedCount = 0, overallStatus } = useHealth() || {}
  const healthKnown = overallStatus !== 'unreachable'
  useEffect(() => {
    if (killSwitchActive) return // kill switch overrides everything
    if (!healthKnown) return // cannot ask: leave DEFCON where it is
    if (downCount > 0 && (currentDefcon === 'GREEN' || currentDefcon === 'BLUE')) {
      setCurrentDefcon('AMBER')
    } else if (degradedCount > 0 && currentDefcon === 'GREEN') {
      setCurrentDefcon('BLUE')
    } else if (downCount === 0 && degradedCount === 0 && (currentDefcon === 'AMBER' || currentDefcon === 'BLUE')) {
      setCurrentDefcon('GREEN')
    }
  }, [downCount, degradedCount, killSwitchActive, healthKnown])

  // quox#503: load the server's authoritative safety state once auth is
  // available (same isAuthenticated gate HealthContext uses, so this never
  // fires unauthenticated network calls on the login route). The server
  // WINS over the localStorage cache: a stale local "halted" from a browser
  // that never got the deactivation, or a stale local "clear" on a browser
  // that missed another operator's E-STOP, are both corrected here. Runs
  // once per session (not polled) — see SafetyContext.jsx module docs for
  // why this is "on load", not live-synced.
  useEffect(() => {
    if (!isAuthenticated) return
    let cancelled = false
    ;(async () => {
      try {
        const status = await getSafetyStatus()
        if (cancelled) return
        setServerDefcon(status.defcon)
        setKillSwitchActive(status.defcon === 'RED')
      } catch (err) {
        // Fail-open for the OPTIMISTIC UI flag only — the actual dispatch
        // gate (services/collector's checkAgentInvokeSafetyGate /
        // services/tasks's safetyGate.js) fails CLOSED independently of
        // whether this fetch succeeds, so a console that can't reach the
        // collector shows stale state rather than lying about a halt, but
        // never grants execution the server itself would refuse.
        console.warn('[Safety] Failed to load server safety status:', err.message)
      }
    })()
    return () => { cancelled = true }
  }, [isAuthenticated])

  // Dry run mode
  const [dryRunMode, setDryRunModeState] = useState(initialState.dryRun || false)

  // Pending operation awaiting approval
  const [pendingOperation, setPendingOperation] = useState(null)

  // Persist all safety state changes to consolidated key
  useEffect(() => {
    saveSafetyState({
      killSwitch: killSwitchActive,
      killCode: deactivationCode,
      defcon: currentDefcon,
      dryRun: dryRunMode,
    })
  }, [killSwitchActive, deactivationCode, currentDefcon, dryRunMode])

  // quox#503: set the server's instance-wide DEFCON level. Exposed for any
  // DEFCON-setting UI (the kill switch below is the only caller today);
  // fire-and-forget from the caller's perspective — errors are logged, not
  // thrown, so a network blip never blocks the optimistic local UI update
  // the caller already made (design requirement: "keep the optimistic
  // local flag"). The actual enforcement gate fails closed independently
  // of whether this write succeeds (see killSwitchStore.js / safetyGate.js).
  const setInstanceDefcon = useCallback(async (level, reason) => {
    try {
      const result = await apiSetDefconLevel(level, reason)
      setServerDefcon(result.new_level)
      return true
    } catch (err) {
      console.warn(`[Safety] Failed to set server DEFCON to ${level}:`, err.message)
      return false
    }
  }, [])

  // Activate kill switch. Optimistic local state first (instant UI, no
  // network round-trip needed to arm/confirm the console), then AWAIT the
  // server-side instance DEFCON RED write that makes the halt real for
  // every dispatch chokepoint (agentScheduler pre-dispatch, loopDispatch
  // turn boundary, the collector's chat/invoke chokepoints).
  //
  // quox#503 residual: a non-admin used to see the optimistic local flip
  // stick around (fire-and-forget write) even though the server rejected
  // it — a fake HALTED state no dispatch chokepoint was actually
  // enforcing. On a 403 (not admin) the local flip is reverted here rather
  // than fail-opened; any OTHER failure (network blip, 5xx) still fails
  // open for this UI flag only, matching setInstanceDefcon's existing
  // behavior — the real per-dispatch gate fails closed independently,
  // server-side, regardless of whether this write succeeds.
  const activateKillSwitch = useCallback(async () => {
    const code = generateDeactivationCode()
    setDeactivationCode(code)
    setKillSwitchActive(true)
    setKillSwitchActivatedAt(new Date())
    console.log('[SAFETY] Kill switch ACTIVATED. Deactivation code:', code)
    try {
      const result = await apiSetDefconLevel('RED', 'Kill switch activated from console')
      setServerDefcon(result.new_level)
      return code
    } catch (err) {
      console.warn('[Safety] Failed to set server DEFCON to RED:', err.message)
      if (err.status === 403) {
        setKillSwitchActive(false)
        setKillSwitchActivatedAt(null)
        setDeactivationCode(null)
        return null
      }
      return code
    }
  }, [])

  // Deactivate kill switch. A local code is only meaningful when THIS
  // browser generated it (deactivationCode !== null); a server-loaded halt
  // — another operator's E-STOP, or this browser's own halt rehydrated
  // from the server on a fresh load — has deactivationCode === null, and
  // no code equality check can ever be satisfied for it. Skip straight to
  // the server write in that case: the real authority is the server's
  // requireHumanAdmin gate, not this client-side equality check (quox#503
  // residual — previously a fresh browser could load a server-set halt but
  // could never lift it).
  //
  // Never optimistically clears local state before the server confirms —
  // a fake "resumed" UI while the server is still RED is the more
  // dangerous asymmetry (an operator believing ops are unblocked when the
  // real gate still blocks them). killSwitchActive only flips to false on
  // an awaited 2xx.
  const deactivateKillSwitch = useCallback(async (inputCode) => {
    if (deactivationCode !== null && inputCode !== deactivationCode) {
      console.warn('[SAFETY] Invalid deactivation code')
      return false
    }
    const ok = await setInstanceDefcon('GREEN', 'Kill switch deactivated from console')
    if (ok) {
      setKillSwitchActive(false)
      setKillSwitchActivatedAt(null)
      setDeactivationCode(null)
      console.log('[SAFETY] Kill switch DEACTIVATED')
    } else {
      console.warn('[SAFETY] Deactivation rejected by server; kill switch remains active')
    }
    return ok
  }, [deactivationCode, setInstanceDefcon])

  // Set dry run mode
  const setDryRunMode = useCallback((enabled) => {
    setDryRunModeState(enabled)
    console.log('[SAFETY] Dry run mode:', enabled ? 'ENABLED' : 'DISABLED')
  }, [])

  // Determine DEFCON level for an operation
  const getDefconForOperation = useCallback((query, targetCount = 1) => {
    const q = query.toLowerCase()

    // First, check intent - informational queries are always safe
    const intent = detectIntent(query)
    if (intent.isInformational && !intent.isDestructive) {
      // Informational queries don't need safety checks
      return targetCount > 10 ? 'BLUE' : 'GREEN'
    }

    // Read-only operations are safe even on multiple hosts
    if (isReadOnlyOperation(query)) {
      return targetCount > 20 ? 'BLUE' : 'GREEN'
    }

    // RED - Destructive operations (requires explicit action verbs)
    const redPatterns = [
      /\b(delete|destroy|remove)\s+(the\s+)?(vm|container|host)\b/i,
      /^destroy\b/i,  // Imperative destroy
      /\brm\s+-rf\b/i,
      /\bqm\s+destroy\b/i,
      /\bpct\s+destroy\b/i,
      /\bpvesh\s+delete\b/i,
      /\bformat\s+(the\s+)?(disk|drive|partition)/i,  // More specific
      /\bmkfs\./i  // mkfs.ext4, etc
    ]
    if (redPatterns.some(p => p.test(q))) {
      return 'RED'
    }

    // ORANGE - Production or mass operations (only for action intents)
    if (intent.type === 'action' || intent.type === 'destructive' || intent.type === 'modification') {
      if (targetCount > 20 || /\b(production|prod)\b/i.test(q) || /\ball\s+(servers?|hosts?)\b/i.test(q)) {
        return 'ORANGE'
      }
    }

    // AMBER - Service modifications (only when explicitly requesting action)
    const amberPatterns = [
      /^(restart|stop|start)\s/i,  // Imperative at start
      /\b(please|can you)\s+(restart|stop|start)\b/i,  // Polite request
      /\b(update|upgrade|patch)\s+(the\s+)?(server|system|host|package)/i,  // Specific targets
      /\b(modify|change|edit)\s+(the\s+)?config/i,
      /^migrate\b/i
    ]
    // Only trigger AMBER if it looks like an action AND matches patterns
    if ((intent.type === 'action' || intent.type === 'modification') && amberPatterns.some(p => p.test(q))) {
      return 'AMBER'
    }

    // Multi-host operations (non-read-only) still need confirmation
    if (targetCount > 5 && !isReadOnlyOperation(query)) {
      return 'AMBER'
    }

    // BLUE - Single host non-destructive
    if (targetCount === 1 && /\b(status|check|show|list|get|info)\b/i.test(q)) {
      return 'BLUE'
    }

    // GREEN - Safe operations
    return 'GREEN'
  }, [])

  // Request an operation (returns whether it can proceed)
  const requestOperation = useCallback(async (operation) => {
    // Kill switch blocks everything
    if (killSwitchActive) {
      return {
        allowed: false,
        reason: 'Kill switch is active. All operations are blocked.',
        requiresCode: false
      }
    }

    const defconLevel = getDefconForOperation(operation.query, operation.targetCount || 1)
    const defcon = DEFCON_LEVELS[defconLevel]

    // Update current DEFCON display
    setCurrentDefcon(defconLevel)

    // Dry run mode - log but don't execute
    if (dryRunMode) {
      return {
        allowed: false,
        reason: 'Dry run mode is enabled. Command logged but not executed.',
        dryRun: true,
        defconLevel
      }
    }

    // GREEN/BLUE - auto proceed
    if (defconLevel === 'GREEN' || defconLevel === 'BLUE') {
      return { allowed: true, defconLevel }
    }

    // AMBER/ORANGE/RED - requires approval
    return {
      allowed: false,
      requiresApproval: true,
      defconLevel,
      approval: defcon.approval,
      reason: `${defcon.name} operation requires ${defcon.approval === 'manual_only' ? 'authorization code' : 'confirmation'}`
    }
  }, [killSwitchActive, dryRunMode, getDefconForOperation])

  // Clear pending operation
  const clearPendingOperation = useCallback(() => {
    setPendingOperation(null)
  }, [])

  // Keyboard shortcut for kill switch (Ctrl+Shift+K)
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'K') {
        e.preventDefault()
        if (killSwitchActive) {
          // Show deactivation prompt
          const code = prompt(`Kill switch is ACTIVE.\nEnter deactivation code to disable:`)
          if (code) {
            void deactivateKillSwitch(code)
          }
        } else {
          void activateKillSwitch().then((code) => {
            if (code) {
              alert(`Kill switch ACTIVATED!\n\nDeactivation code: ${code}\n\nSave this code to re-enable operations.`)
            } else {
              alert('Kill switch could not be activated: admin required.')
            }
          })
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [killSwitchActive, activateKillSwitch, deactivateKillSwitch])

  const value = {
    killSwitchActive,
    killSwitchActivatedAt,
    deactivationCode,
    currentDefcon,
    // quox#503: the server-authoritative instance DEFCON (null until the
    // on-load fetch resolves), and the action that sets it.
    serverDefcon,
    setInstanceDefcon,
    dryRunMode,
    pendingOperation,
    activateKillSwitch,
    deactivateKillSwitch,
    setDryRunMode,
    requestOperation,
    clearPendingOperation,
    getDefconForOperation,
    setPendingOperation
  }

  return (
    <SafetyContext.Provider value={value}>
      {children}
    </SafetyContext.Provider>
  )
}

export function useSafety() {
  const context = useContext(SafetyContext)
  if (!context) {
    throw new Error('useSafety must be used within a SafetyProvider')
  }
  return context
}

export default SafetyContext
