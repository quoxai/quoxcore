/**
 * fileObjectsClient — FU-3
 *
 * Thin adapter over the FU-1 file_objects HTTP API. Plugins adopt this
 * gradually to replace direct fileStorage.js reads/writes. No state,
 * no localStorage — pure fetch wrapper. Every method throws on !ok so
 * callers can rely on success-path data or handle in try/catch.
 */

async function asJson(resp) {
  const data = await resp.json().catch(() => ({}))
  return data
}

function assertOk(resp, body, action) {
  if (!resp.ok) {
    const err = (body && body.error) || `HTTP ${resp.status}`
    const e = new Error(`${action} failed: ${err}`)
    e.status = resp.status
    throw e
  }
}

/** POST /api/orgs/:orgId/files/upload */
export async function upload({ authFetch, orgId, namespace, file, sourceRef, sourcePlugin, virtualPath, metadata }) {
  const form = new FormData()
  form.append('file', file, file.name)
  form.append('namespace', namespace)
  if (sourceRef) form.append('source_ref', sourceRef)
  if (sourcePlugin) form.append('source_plugin', sourcePlugin)
  if (virtualPath) form.append('virtual_path', virtualPath)
  if (metadata) form.append('metadata', typeof metadata === 'string' ? metadata : JSON.stringify(metadata))
  const resp = await authFetch(`/api/orgs/${encodeURIComponent(orgId)}/files/upload`, { method: 'POST', body: form })
  const data = await asJson(resp)
  assertOk(resp, data, 'upload')
  return data
}

/** GET /api/orgs/:orgId/files?namespace_prefix=…&limit=… */
export async function list({ authFetch, orgId, namespacePrefix, limit = 50, offset = 0, includeDeleted = false }) {
  const params = new URLSearchParams()
  params.set('limit', String(limit))
  params.set('offset', String(offset))
  if (namespacePrefix) params.set('namespace_prefix', namespacePrefix)
  if (includeDeleted) params.set('include_deleted', 'true')
  const resp = await authFetch(`/api/orgs/${encodeURIComponent(orgId)}/files?${params.toString()}`)
  const data = await asJson(resp)
  assertOk(resp, data, 'list')
  return data
}

/** GET /api/orgs/:orgId/files/:id/meta */
export async function get({ authFetch, orgId, fileId }) {
  const resp = await authFetch(`/api/orgs/${encodeURIComponent(orgId)}/files/${encodeURIComponent(fileId)}/meta`)
  const data = await asJson(resp)
  assertOk(resp, data, 'get')
  return data
}

/** GET /api/orgs/:orgId/files/:id → Blob */
export async function download({ authFetch, orgId, fileId }) {
  const resp = await authFetch(`/api/orgs/${encodeURIComponent(orgId)}/files/${encodeURIComponent(fileId)}`)
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}))
    assertOk(resp, body, 'download')
  }
  return await resp.blob()
}

/** PATCH /api/orgs/:orgId/files/:id */
export async function rename({ authFetch, orgId, fileId, filename, virtualPath, metadata }) {
  const body = {}
  if (filename !== undefined) body.filename = filename
  if (virtualPath !== undefined) body.virtual_path = virtualPath
  if (metadata !== undefined) body.metadata = metadata
  const resp = await authFetch(`/api/orgs/${encodeURIComponent(orgId)}/files/${encodeURIComponent(fileId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await asJson(resp)
  assertOk(resp, data, 'rename')
  return data
}

/** DELETE /api/orgs/:orgId/files/:id (soft-delete) */
export async function remove({ authFetch, orgId, fileId }) {
  const resp = await authFetch(`/api/orgs/${encodeURIComponent(orgId)}/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' })
  if (resp.status === 204 || resp.ok) return true
  const body = await resp.json().catch(() => ({}))
  assertOk(resp, body, 'remove')
  return true
}

export default { upload, list, get, download, rename, remove }
