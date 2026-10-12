/**
 * agentToolsTruth.js — runtime source of truth for agent → tool grants.
 *
 * AGENT-OVERHAUL-2 (census fix). Before this module, every UI surface that
 * showed "tools this agent has" read straight from src/config/agentRegistry.js,
 * which is the UI's DECLARED/advertised list and can drift from what the
 * collector actually wires up (census-confirmed: REGULA advertised 21 tools
 * the runtime lacked, ARCHIVIST 6). agentRegistry.js stays authoritative for
 * everything else (capabilities, workflows, delegation, system prompts) — this
 * module narrows scope to just the tool-grant list.
 *
 * Truth source: GET /collector/api/v1/tools/agents → { agentTools, toolAgents }
 * (services/collector/server.js ~line 5133, mirrors the collector's in-memory
 * AGENT_TOOLS map — the same object the collector uses to actually gate tool
 * execution). Requires an authenticated session (same-origin JWT cookie, same
 * as every other collector data client) — NOT literally unauthenticated
 * despite the route having no explicit `requireAuth()` call, because the
 * default-deny collectorAuthGate (COLLECTOR_AUTH_ENFORCE=enforce) applies to
 * any route not on its allowlist, and this one isn't.
 *
 * Server-side is ALWAYS the source of truth (data-persistence rule). This
 * module caches in-memory for the session and mirrors to sessionStorage
 * purely as an offline/network-blip fallback — sessionStorage is never read
 * in preference to a fresh fetch, only when the fetch itself fails.
 *
 * agentRegistry.agents[id].tools is used ONLY as the fallback when the
 * collector is unreachable (never logged in yet, network error, etc.), and
 * callers get `source: 'fallback'` so they can be honest about it rather than
 * silently re-presenting the un-verified declared list as fact.
 */

import { useState, useEffect } from 'react'
import { agentRegistry } from '../config/agentRegistry'

const ENDPOINT = '/collector/api/v1/tools/agents'
const STORAGE_KEY = 'quox-agent-tools-truth'

// Module-level cache, shared by every component that mounts the hook —
// one network request per session, not one per component.
let cache = null // Record<agentId, string[]> | null (null until a fetch succeeds)
let cacheSource = null // 'runtime' | 'fallback' | null (null = not yet resolved)
let inflight = null

function fallbackTools(agentId) {
  return agentRegistry.agents?.[agentId]?.tools || []
}

function loadSessionCache() {
  if (typeof window === 'undefined' || !window.sessionStorage) return null
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed?.agentTools || null
  } catch {
    return null
  }
}

function saveSessionCache(agentTools) {
  if (typeof window === 'undefined' || !window.sessionStorage) return
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ agentTools, ts: Date.now() }))
  } catch {
    /* quota or disabled — best-effort, not the source of truth anyway */
  }
}

/**
 * Fetch (or return the already-resolved) runtime tool grants for ALL agents.
 * Dedupes concurrent calls; resolves at most once per page session unless
 * `force` is passed.
 *
 * @returns {Promise<{ agentTools: Record<string,string[]>, source: 'runtime'|'fallback' }>}
 */
export async function loadAgentToolsTruth(force = false) {
  if (cache && !force) return { agentTools: cache, source: cacheSource }
  if (inflight && !force) return inflight

  inflight = (async () => {
    try {
      const resp = await fetch(ENDPOINT, {
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      })

      if (!resp.ok) {
        // 401/403 (no session yet) or any other non-2xx. Collector reachable
        // but not authoritative for us right now — fall back to registry.
        cacheSource = 'fallback'
        cache = null
        return { agentTools: {}, source: 'fallback' }
      }

      const data = await resp.json()
      const agentTools = data?.agentTools || {}
      cache = agentTools
      cacheSource = 'runtime'
      saveSessionCache(agentTools)
      return { agentTools, source: 'runtime' }
    } catch (err) {
      // Network error — try the same-tab sessionStorage mirror before giving
      // up to the registry fallback entirely.
      console.warn('[agentToolsTruth] fetch failed, checking sessionStorage cache:', err.message)
      const sessionCached = loadSessionCache()
      if (sessionCached) {
        cache = sessionCached
        cacheSource = 'runtime'
        return { agentTools: sessionCached, source: 'runtime' }
      }
      cacheSource = 'fallback'
      cache = null
      return { agentTools: {}, source: 'fallback' }
    } finally {
      inflight = null
    }
  })()

  return inflight
}

function deriveState(agentId) {
  if (cache) {
    return { tools: cache[agentId] || [], source: 'runtime', loading: false }
  }
  return { tools: fallbackTools(agentId), source: 'fallback', loading: cacheSource === null }
}

/**
 * React hook — per-agent granted tool list from runtime truth.
 *
 * Returns { tools, source, loading }:
 *  - source: 'runtime'  → tools[] is exactly what the collector grants this
 *            agent right now (may be [] if the agent genuinely has none —
 *            that's the honest answer, not a bug).
 *  - source: 'fallback' → collector unreachable; tools[] is the UI's
 *            DECLARED list from agentRegistry (unverified — caller should
 *            mark this in the UI rather than presenting it as fact).
 *  - loading: true only during the very first in-flight fetch of the
 *            session; every agentId switch after that resolves synchronously
 *            from the shared cache.
 */
export function useAgentToolsTruth(agentId) {
  const [state, setState] = useState(() => deriveState(agentId))

  useEffect(() => {
    let cancelled = false
    setState(deriveState(agentId))
    loadAgentToolsTruth().then(() => {
      if (!cancelled) setState(deriveState(agentId))
    })
    return () => {
      cancelled = true
    }
  }, [agentId])

  return state
}

/**
 * Test / utility — clear the in-memory + sessionStorage cache.
 */
export function clearAgentToolsTruthCache() {
  cache = null
  cacheSource = null
  inflight = null
  if (typeof window !== 'undefined' && window.sessionStorage) {
    try {
      window.sessionStorage.removeItem(STORAGE_KEY)
    } catch {
      /* ignore */
    }
  }
}
