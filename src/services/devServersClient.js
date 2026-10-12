/**
 * Dev Servers Client (OnboardView)
 *
 * Minimal read wrapper over the collector's dev-servers registry
 * (GET /collector/api/v1/dev-servers, same endpoint DevServersHubPanel
 * fetches). Used by the tenant onboarding wizard's "Check host" affordance
 * to show whether a host id is dev-enabled (profile_verified) before running.
 */

const BASE = '/collector/api/v1/dev-servers'

export async function listDevServers({ authFetch } = {}) {
  const fetcher = authFetch || fetch
  const res = await fetcher(BASE, { credentials: 'include' })
  if (!res.ok) throw new Error(`Request failed: HTTP ${res.status}`)
  const data = await res.json().catch(() => ({}))
  return Array.isArray(data.servers) ? data.servers : []
}
