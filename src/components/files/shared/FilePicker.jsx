/**
 * FilePicker — FU-2
 *
 * Modal that lists files from POST /api/orgs/:orgId/files and fires
 * onPick(file) when the user selects one. Supports namespace prefix
 * filtering (so QuoxChat can list only `quoxchat/wgt_xx/knowledge`
 * files, ImagesQ only `imagesq`, etc.).
 */

import { useState, useEffect, useMemo } from 'react'

function formatBytes(n) {
  if (!n && n !== 0) return ''
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / (1024 * 1024)).toFixed(1)}MB`
}

const MODAL_STYLE = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
}

const PANEL_STYLE = {
  width: 640, maxHeight: '80vh', display: 'flex', flexDirection: 'column',
  background: '#0d0d12', border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 12, overflow: 'hidden',
}

export default function FilePicker({ authFetch, orgId, namespacePrefix, accept, onPick, onClose, title = 'Select a file' }) {
  const [files, setFiles] = useState([])
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!authFetch || !orgId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    const params = new URLSearchParams()
    params.set('limit', '100')
    if (namespacePrefix) params.set('namespace_prefix', namespacePrefix)
    authFetch(`/api/orgs/${orgId}/files?${params.toString()}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(data => {
        if (cancelled) return
        setFiles(Array.isArray(data?.items) ? data.items : [])
      })
      .catch(err => { if (!cancelled) setError(err.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [authFetch, orgId, namespacePrefix])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    let rows = files
    if (q) rows = rows.filter(f => (f.filename || '').toLowerCase().includes(q) || (f.virtual_path || '').toLowerCase().includes(q))
    if (Array.isArray(accept) && accept.length > 0) {
      rows = rows.filter(f => accept.some(pat => pat === '*' || pat === '*/*' || (pat.endsWith('/*') ? (f.mime || '').startsWith(pat.slice(0, -1)) : f.mime === pat)))
    }
    return rows
  }, [files, query, accept])

  return (
    <div style={MODAL_STYLE} role="dialog" aria-label={title} onClick={e => { if (e.target === e.currentTarget) onClose?.() }}>
      <div style={PANEL_STYLE}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: '#fff' }}>{title}</span>
          <button type="button" aria-label="Close" onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.6)', fontSize: 18, cursor: 'pointer' }}>×</button>
        </div>
        <div style={{ padding: '10px 16px', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
          <input
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search filename or path…"
            style={{ width: '100%', padding: '7px 10px', background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6, color: '#fff', fontSize: 12 }}
          />
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
          {loading && <div style={{ padding: 24, textAlign: 'center', fontSize: 11, color: 'rgba(255,255,255,0.55)' }}>Loading…</div>}
          {error && <div style={{ padding: 12, fontSize: 11, color: '#ef4444' }}>Failed to load: {error}</div>}
          {!loading && !error && filtered.length === 0 && (
            <div style={{ padding: 24, textAlign: 'center', fontSize: 11, color: 'rgba(255,255,255,0.55)' }}>
              {files.length === 0 ? 'No files uploaded yet.' : 'No files match your search.'}
            </div>
          )}
          {filtered.map(f => (
            <button
              key={f.id}
              type="button"
              onClick={() => { onPick?.(f); onClose?.() }}
              style={{
                display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 8, width: '100%',
                textAlign: 'left', padding: '8px 10px', marginBottom: 4,
                background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.04)',
                borderRadius: 6, color: '#fff', cursor: 'pointer', fontFamily: 'inherit',
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.filename}</div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', fontFamily: "'JetBrains Mono', monospace" }}>{f.namespace}</div>
              </div>
              <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.55)', alignSelf: 'center' }}>{formatBytes(f.size_bytes)}</span>
              <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', alignSelf: 'center' }}>{f.created_at ? new Date(f.created_at).toLocaleDateString() : ''}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
