/**
 * useFileUpload — FU-2
 *
 * React hook that wraps POST /api/orgs/:orgId/files/upload. Tracks each
 * upload's status (queued / uploading / done / error) so consumers can
 * render progress rows (<FileUploadToast/>).
 *
 * Validation is client-side-only to give fast feedback; the server still
 * enforces its own limits on top of anything passed here.
 */

import { useState, useCallback, useRef } from 'react'

function randomId() {
  return 'up_' + Math.random().toString(36).slice(2, 10)
}

function mimeMatches(fileType, accept) {
  if (!Array.isArray(accept) || accept.length === 0) return true
  return accept.some(pattern => {
    if (pattern === '*' || pattern === '*/*') return true
    if (pattern.endsWith('/*')) return fileType.startsWith(pattern.slice(0, -1))
    return fileType === pattern
  })
}

export default function useFileUpload({ authFetch, orgId, namespace, sourceRef, sourcePlugin, accept, maxSize, onComplete } = {}) {
  const [uploads, setUploads] = useState([])
  // Pin each upload's original File so retry() can re-submit without the
  // caller having to keep a reference.
  const blobsRef = useRef(new Map())

  const patch = useCallback((id, partial) => {
    setUploads(prev => prev.map(u => u.id === id ? { ...u, ...partial } : u))
  }, [])

  const run = useCallback(async (id, file) => {
    if (maxSize && file.size > maxSize) {
      patch(id, { status: 'error', error: `File too large (max ${Math.floor(maxSize / 1024)}KB)` })
      return
    }
    if (accept && !mimeMatches(file.type || 'application/octet-stream', accept)) {
      patch(id, { status: 'error', error: `File type not allowed (${file.type || 'unknown'})` })
      return
    }

    patch(id, { status: 'uploading', progress: 0, error: null })
    const form = new FormData()
    form.append('file', file, file.name)
    if (namespace) form.append('namespace', namespace)
    if (sourceRef) form.append('source_ref', sourceRef)
    if (sourcePlugin) form.append('source_plugin', sourcePlugin)

    try {
      const resp = await authFetch(`/api/orgs/${orgId}/files/upload`, { method: 'POST', body: form })
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}))
        patch(id, { status: 'error', error: body.error || `HTTP ${resp.status}` })
        return
      }
      const data = await resp.json().catch(() => ({}))
      patch(id, { status: 'done', progress: 1, result: data })
      if (typeof onComplete === 'function') onComplete(data)
    } catch (err) {
      patch(id, { status: 'error', error: err?.message || 'network_error' })
    }
  }, [authFetch, orgId, namespace, sourceRef, sourcePlugin, accept, maxSize, onComplete, patch])

  const upload = useCallback(async (files) => {
    if (!files || files.length === 0) return
    const arr = Array.from(files)
    const entries = arr.map(f => ({
      id: randomId(),
      filename: f.name,
      size: f.size,
      mime: f.type,
      progress: 0,
      status: 'queued',
      error: null,
      result: null,
    }))
    setUploads(prev => [...prev, ...entries])
    for (let i = 0; i < entries.length; i++) {
      blobsRef.current.set(entries[i].id, arr[i])
      await run(entries[i].id, arr[i]) // sequential so progress ordering + server rate limits stay sane
    }
  }, [run])

  const retry = useCallback(async (id) => {
    const file = blobsRef.current.get(id)
    if (!file) return
    await run(id, file)
  }, [run])

  const cancel = useCallback((id) => {
    blobsRef.current.delete(id)
    setUploads(prev => prev.filter(u => u.id !== id))
  }, [])

  const clear = useCallback(() => {
    blobsRef.current.clear()
    setUploads([])
  }, [])

  return { uploads, upload, retry, cancel, clear }
}
