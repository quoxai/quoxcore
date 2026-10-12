/**
 * agentProfileClient.js
 *
 * Fetches per-agent catalog profile counts from the collector.
 * Follows the same conventions as agentToolCatalogClient.js and
 * governanceIncidentsClient.js: /collector/ prefix, credentials: 'include'.
 *
 * QSKL-AP-2
 */

/**
 * Fetch the catalog profile for a single agent.
 * Returns an object with: agentId, skill_count, tool_count, workflow_count,
 * top_5_skills, top_5_tools. crystal_count is OMITTED when not available
 * on the backend — callers must not assume it is present.
 *
 * Returns parsed JSON directly (no data unwrap needed — endpoint returns the
 * profile object at the top level).
 *
 * @param {string} agentId
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<object>}
 * @throws {Error} on non-2xx or network failure
 */
export async function fetchAgentProfile(agentId, { signal } = {}) {
  const resp = await fetch(`/collector/agents/${encodeURIComponent(agentId)}/profile`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    signal,
  })

  if (!resp.ok) {
    const body = await resp.json().catch(() => null)
    const msg = body?.error || `Agent profile fetch failed: ${resp.status}`
    const err = new Error(msg)
    err.status = resp.status
    throw err
  }

  return resp.json()
}

/**
 * Fetch the aggregated profile summary for all agents.
 * Returns: { agent_count, skill_total, tool_total, workflow_total, crystal_total, per_agent: [...] }
 * per_agent items may have an 'error' field if that agent's profile failed.
 *
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<object>}
 * @throws {Error} on non-2xx or network failure
 */
export async function fetchProfileSummary({ signal } = {}) {
  const resp = await fetch('/collector/agents/profile-summary', {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    signal,
  })

  if (!resp.ok) {
    const body = await resp.json().catch(() => null)
    const msg = body?.error || `Profile summary fetch failed: ${resp.status}`
    const err = new Error(msg)
    err.status = resp.status
    throw err
  }

  return resp.json()
}
