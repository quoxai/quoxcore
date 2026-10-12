/**
 * SETEC S2: GET /collector/api/v1/admin/instance-settings (instance admins only).
 * Returns { rows, gaps, authReported }. Throws an Error with .status on non-2xx
 * so the caller can show a clear 403 message instead of an empty table.
 */
export async function fetchInstanceSettings(authFetch) {
  if (!authFetch) throw new Error('Not signed in')
  const response = await authFetch('/collector/api/v1/admin/instance-settings')
  if (!response.ok) {
    const err = new Error(`Failed to load instance settings (${response.status})`)
    err.status = response.status
    throw err
  }
  const data = await response.json()
  return {
    rows: Array.isArray(data.rows) ? data.rows : [],
    gaps: Array.isArray(data.gaps) ? data.gaps : [],
    authReported: data.authReported !== false,
  }
}
