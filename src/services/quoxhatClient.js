/**
 * QUOXHAT P1 — client for hat management + manual selection (auth service).
 *
 * Server is the source of truth (quoxhat_* tables); no browser cache here —
 * the surfaces are low-traffic settings/Mirror panels and stale hats would
 * be worse than a second fetch. All calls go through AuthContext's
 * authFetch, same idiom as llmRoutingPolicyClient.js.
 */

export async function fetchHats(authFetch, orgId) {
  if (!authFetch || !orgId) return { hats: [], settings: null, error: 'not_authenticated' }
  try {
    const resp = await authFetch(`/api/orgs/${orgId}/quoxhat/hats`)
    if (!resp.ok) return { hats: [], settings: null, error: `HTTP ${resp.status}` }
    const data = await resp.json()
    return { hats: data.hats || [], settings: data.settings || null }
  } catch (err) {
    return { hats: [], settings: null, error: err?.message || 'network_error' }
  }
}

export async function fetchEffectiveHat(authFetch, orgId, conversationId = null) {
  if (!authFetch || !orgId) return { error: 'not_authenticated' }
  try {
    const qs = conversationId ? `?conversation_id=${encodeURIComponent(conversationId)}` : ''
    const resp = await authFetch(`/api/orgs/${orgId}/quoxhat/resolve${qs}`)
    if (!resp.ok) return { error: `HTTP ${resp.status}` }
    return await resp.json()
  } catch (err) {
    return { error: err?.message || 'network_error' }
  }
}

export async function setOrgDefaultHat(authFetch, orgId, hatId) {
  const resp = await authFetch(`/api/orgs/${orgId}/quoxhat/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ default_hat_id: hatId }),
  })
  const body = await resp.json().catch(() => null)
  if (!resp.ok) throw new Error(body?.validation_errors?.join('; ') || body?.error || `HTTP ${resp.status}`)
  return body.settings
}

export async function setUserDefaultHat(authFetch, orgId, hatId) {
  const resp = await authFetch(`/api/orgs/${orgId}/quoxhat/user-pref`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ default_hat_id: hatId }),
  })
  const body = await resp.json().catch(() => null)
  if (!resp.ok) throw new Error(body?.validation_errors?.join('; ') || body?.error || `HTTP ${resp.status}`)
  return true
}

export async function setOrgEnforcement(authFetch, orgId, enforcement) {
  const resp = await authFetch(`/api/orgs/${orgId}/quoxhat/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enforcement }),
  })
  const body = await resp.json().catch(() => null)
  if (!resp.ok) throw new Error(body?.validation_errors?.join('; ') || body?.error || `HTTP ${resp.status}`)
  return body.settings
}

export async function setOrgSelectionMode(authFetch, orgId, selectionMode) {
  const resp = await authFetch(`/api/orgs/${orgId}/quoxhat/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ selection_mode: selectionMode }),
  })
  const body = await resp.json().catch(() => null)
  if (!resp.ok) throw new Error(body?.validation_errors?.join('; ') || body?.error || `HTTP ${resp.status}`)
  return body.settings
}
