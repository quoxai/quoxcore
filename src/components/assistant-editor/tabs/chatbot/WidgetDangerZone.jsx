/**
 * WidgetDangerZone: the Settings controls the docs promise (section 2.8):
 * pause/resume, export conversations with transcripts, delete the widget.
 * Every control calls a real route; PDF export and a scheduled retention
 * job do not exist and are not offered here.
 */

import { useState } from 'react'

const btn = { padding: '6px 12px', fontSize: 11, fontWeight: 600, borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit' }

async function downloadBlob(resp, filename) {
  const blob = await resp.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export default function WidgetDangerZone({ widget, authFetch, orgId, onWidgetChange, onDeleted }) {
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)
  const base = `/api/orgs/${orgId}/widgets/${widget?.id}`
  const live = widget?.status === 'published' || widget?.status === 'active'
  const paused = widget?.status === 'paused'

  const exportAs = async (kind) => {
    setBusy(true); setMsg(null)
    try {
      const path = kind === 'json' ? `${base}/conversations.json?transcripts=1` : `${base}/conversations.csv`
      const resp = await authFetch(path)
      if (!resp.ok) { setMsg(`Export failed (${resp.status})`); return }
      await downloadBlob(resp, `widget-${widget.id}-conversations.${kind}`)
      setMsg(kind === 'json' ? 'Exported conversations with full transcripts.' : 'Exported the conversation list (no transcripts; use JSON for those).')
    } catch (err) { setMsg(err.message) } finally { setBusy(false) }
  }

  const setStatus = async (status) => {
    setBusy(true); setMsg(null)
    try {
      const resp = await authFetch(base, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) })
      const body = await resp.json().catch(() => ({}))
      if (resp.ok) { onWidgetChange?.(body.widget || { status }); setMsg(status === 'paused' ? 'Paused.' : 'Live again.') }
      else setMsg(body.message || body.error || `Could not change status (${resp.status})`)
    } catch (err) { setMsg(err.message) } finally { setBusy(false) }
  }

  const remove = async () => {
    if (!window.confirm(`Delete "${widget.name}"? This removes the widget, its knowledge and its conversations. This cannot be undone.`)) return
    setBusy(true); setMsg(null)
    try {
      const resp = await authFetch(base, { method: 'DELETE' })
      if (resp.ok || resp.status === 204) { onDeleted?.(); return }
      const body = await resp.json().catch(() => ({}))
      setMsg(body.error || `Delete failed (${resp.status})`)
    } catch (err) { setMsg(err.message) } finally { setBusy(false) }
  }

  return (
    <div className="qx-flat-panel" data-testid="danger-zone" style={{ marginTop: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: '#fff', marginBottom: 8 }}>Pause, export and delete</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {live && <button type="button" disabled={busy} onClick={() => setStatus('paused')} style={{ ...btn, background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)', color: '#f59e0b' }}>Pause widget</button>}
        {paused && <button type="button" disabled={busy} onClick={() => setStatus('published')} style={{ ...btn, background: 'rgba(48,255,144,0.1)', border: '1px solid rgba(48,255,144,0.3)', color: '#30ff90' }}>Resume widget</button>}
        <button type="button" disabled={busy} onClick={() => exportAs('json')} style={{ ...btn, background: 'rgba(56,189,248,0.08)', border: '1px solid rgba(56,189,248,0.25)', color: '#38bdf8' }}>Export conversations with transcripts (JSON)</button>
        <button type="button" disabled={busy} onClick={() => exportAs('csv')} style={{ ...btn, background: 'rgba(56,189,248,0.08)', border: '1px solid rgba(56,189,248,0.25)', color: '#38bdf8' }}>Export conversation list (CSV)</button>
        <button type="button" disabled={busy} onClick={remove} style={{ ...btn, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', color: '#ef4444' }}>Delete widget</button>
      </div>
      {msg && <div style={{ marginTop: 8, fontSize: 11, color: 'rgba(255,255,255,0.75)' }} role="status">{msg}</div>}
    </div>
  )
}
