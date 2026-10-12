/**
 * agentToolCatalogClient.js
 *
 * Fetches per-agent tool catalogs from the collector. Cached in-memory
 * for the session — tool sets rarely change at runtime.
 *
 * Auth: requests carry credentials: 'include' so the JWT cookie rides along.
 * If the endpoint returns 401/403 (e.g. no session yet), the call returns []
 * defensively — DAEDALUS's prompt assembly must never crash because of this.
 *
 * The fetch pattern (credentials: 'include', /collector/ path prefix) follows
 * the same conventions as governanceIncidentsClient.js.
 *
 * CLARITY-CONSOLE-4: preloadAgentTools uses GET /collector/agents/tools/batch
 * (single request) instead of N per-agent GET requests, eliminating the N+1
 * network storm on /workflow-builder mount.
 */

const cache = new Map()
const inflightById = new Map()

/**
 * Fetch the tool catalog for a single agent.
 *
 * Returns an array of { name, description } objects.
 * Returns [] on any error — caller must not crash if tools are unavailable.
 *
 * @param {string} agentId  - Agent ID as registered in AGENT_TOOLS (e.g. 'nova', 'cipher')
 * @returns {Promise<Array<{ name: string, description: string }>>}
 */
export async function getAgentTools(agentId) {
  if (!agentId) return []

  if (cache.has(agentId)) return cache.get(agentId)

  if (inflightById.has(agentId)) return inflightById.get(agentId)

  const promise = (async () => {
    try {
      const resp = await fetch(`/collector/agents/${encodeURIComponent(agentId)}/tools`, {
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      })

      if (resp.status === 401 || resp.status === 403) {
        // Not authenticated — return empty gracefully
        return []
      }

      if (resp.status === 404) {
        // Unknown agent — cache empty so we don't hammer the server
        cache.set(agentId, [])
        return []
      }

      if (!resp.ok) {
        console.warn(`[agentToolCatalog] ${agentId}: unexpected ${resp.status}`)
        return []
      }

      const data = await resp.json()
      const tools = data.tools || []
      cache.set(agentId, tools)
      return tools
    } catch (err) {
      console.warn(`[agentToolCatalog] fetch failed for ${agentId}:`, err.message)
      return []
    } finally {
      inflightById.delete(agentId)
    }
  })()

  inflightById.set(agentId, promise)
  return promise
}

/**
 * Bulk preload — fetches all agent tool catalogs in a single batch request,
 * then seeds the in-memory cache so subsequent getAgentTools() calls are
 * instant cache hits with no further network activity.
 *
 * Falls back to per-agent fetches if the batch endpoint is unavailable (e.g.
 * during local dev against an older collector).
 *
 * @param {string[]} agentIds  - Agent IDs to warm. IDs present in the batch
 *                               response are cached with their tools; IDs
 *                               absent from the response (e.g. registry-only
 *                               agents the collector doesn't know about — see
 *                               CLARITY-CONSOLE-4C) are seeded with an empty
 *                               [] so getAgentTools() cache-hits instead of
 *                               firing an individual 404 GET.
 * @returns {Promise<void>}
 */
export async function preloadAgentTools(agentIds) {
  if (!Array.isArray(agentIds) || agentIds.length === 0) return

  try {
    const resp = await fetch('/collector/agents/tools/batch', {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    })

    if (resp.status === 401 || resp.status === 403) {
      // Not authenticated — silently abort, individual calls will also return []
      return
    }

    if (!resp.ok) {
      // Batch endpoint unavailable — fall back to per-agent requests
      await Promise.allSettled(agentIds.map((id) => getAgentTools(id)))
      return
    }

    const data = await resp.json()
    // Seed the cache for every agent returned by the batch endpoint
    for (const [agentId, tools] of Object.entries(data)) {
      if (Array.isArray(tools)) {
        cache.set(agentId, tools)
      }
    }
    // CLARITY-CONSOLE-4C: registry agents the collector doesn't know about
    // (e.g. archivist, architect, janus, argus, regula, linkedin, youtube,
    // quoxcode, triage-q, roady) are absent from the batch response. Seed an
    // empty cache entry for those so getAgentTools() cache-hits instead of
    // firing an individual GET that 404s.
    for (const agentId of agentIds) {
      if (!cache.has(agentId)) {
        cache.set(agentId, [])
      }
    }
  } catch (err) {
    console.warn('[agentToolCatalog] batch preload failed, falling back to per-agent:', err.message)
    await Promise.allSettled(agentIds.map((id) => getAgentTools(id)))
  }
}

/**
 * Test / utility — clear the in-memory session cache.
 * Not needed in production; exposed for unit tests.
 */
export function clearAgentToolCache() {
  cache.clear()
  inflightById.clear()
}
