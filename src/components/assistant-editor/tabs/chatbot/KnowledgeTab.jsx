/**
 * KnowledgeTab — Widget Room knowledge source management
 *
 * CW-7: 3-column layout: sources list (left), source detail (centre), live test (right)
 * CW-8.11: Wired to real collector endpoints (/collector/quoxchat/knowledge/{upload,crawl,qa}).
 * CW-8.13: Sources now persist across refresh via widget_knowledge_sources table
 *          (collector persists row post-success; tab loads on mount via authFetch).
 */

import { useEffect, useState } from 'react'
import { SUPPORTED_FILE_TYPES, SOURCE_STATUSES, formatSourceStatus, validateKnowledgeSource } from '../../../../widget/knowledgeTabUtils'
import FileDropZone from '../../../files/shared/FileDropZone'

const TYPE_ICONS = { file: '📄', url: '🌐', qa: '❓', connector: '🔗' }

const ACCEPT_ATTR = SUPPORTED_FILE_TYPES.map(t => t.ext).join(',')

function formatBytes(n) {
  if (!n && n !== 0) return '-'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1000 * 1000 * 1000) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1000 / 1000 / 1000).toFixed(2)} GB`
}

function AddSourcePanel({ widgetId, authFetch, orgId, onSourceAdded, onCancel }) {
  const [type, setType] = useState('file')
  const [url, setUrl] = useState('')
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState('')
  const [depth, setDepth] = useState(3)
  const [errors, setErrors] = useState([])
  const [busy, setBusy] = useState(false)

  // Near-broken item from the audit: Escape did nothing here. Wire it to the
  // same Cancel action as the × button.
  useEffect(() => {
    const handleKeyDown = e => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onCancel])

  const handleFiles = async (filesList) => {
    const files = Array.from(filesList || [])
    if (files.length === 0) return

    // QCL-SECURITY P0-1: knowledge ingest now requires an org-scoped,
    // authenticated route (/api/orgs/:orgId/widgets/:widgetId/knowledge/upload)
    // — the previous public /collector/quoxchat/knowledge/upload endpoint
    // let any caller poison a widget's KB by guessing its id. That means a
    // real widget context is now required to upload.
    if (!authFetch || !orgId || !widgetId) {
      setErrors(['Open a specific widget room to upload knowledge sources.'])
      return
    }

    const validFiles = []
    const rejectedMsgs = []
    for (const f of files) {
      const errs = validateKnowledgeSource({ type: 'file', name: f.name, size: f.size })
      if (errs.length > 0) rejectedMsgs.push(`${f.name}: ${errs.join(', ')}`)
      else validFiles.push(f)
    }
    if (rejectedMsgs.length > 0) setErrors(rejectedMsgs)

    for (const file of validFiles) {
      const tempId = `u-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      onSourceAdded({
        id: tempId,
        type: 'file',
        name: file.name,
        status: 'indexing',
        chunks: 0,
        size: formatBytes(file.size),
        lastSync: 'uploading…',
      })

      try {
        const fd = new FormData()
        fd.append('file', file)

        const resp = await authFetch(`/api/orgs/${orgId}/widgets/${widgetId}/knowledge/upload`, {
          method: 'POST',
          body: fd,
        })
        const data = await resp.json().catch(() => ({}))
        if (!resp.ok || data.success === false) {
          throw new Error(data.error || `Upload failed (${resp.status})`)
        }
        onSourceAdded({
          id: data.source_id || tempId,
          _prevId: tempId,
          type: 'file',
          name: data.fileName || file.name,
          status: data.embedded > 0 ? 'indexed' : 'error',
          chunks: data.embedded || 0,
          size: formatBytes(data.fileSize ?? file.size),
          lastSync: data.embedded > 0
            ? `${data.embedded}/${data.chunks} chunks · just now`
            : 'no chunks indexed',
          errorMessage: data.embedded > 0 ? null : 'Embedding failed: check LLM key',
          suggestSuperseded: data.suggest_superseded === true && !!data.source_id,
          _persisted: !!data.source_id,
        }, { replace: true })
      } catch (err) {
        onSourceAdded({
          id: tempId,
          type: 'file',
          name: file.name,
          status: 'error',
          chunks: 0,
          size: formatBytes(file.size),
          lastSync: 'failed',
          errorMessage: err.message,
        }, { replace: true })
      }
    }
  }

  const handleUrlSubmit = async () => {
    const source = { type: 'url', name: url, url, depth }
    const errs = validateKnowledgeSource(source)
    if (errs.length > 0) { setErrors(errs); return }
    if (!authFetch || !orgId || !widgetId) {
      setErrors(['Open a specific widget room to crawl a URL into its knowledge base.'])
      return
    }
    setErrors([])
    setBusy(true)

    const tempId = `u-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    onSourceAdded({
      id: tempId,
      type: 'url',
      name: url,
      status: 'indexing',
      chunks: 0,
      size: '-',
      lastSync: `crawling depth ${depth}…`,
    })

    try {
      const resp = await authFetch(`/api/orgs/${orgId}/widgets/${widgetId}/knowledge/crawl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, depth }),
      })
      const data = await resp.json().catch(() => ({}))
      if (!resp.ok || data.success === false) {
        throw new Error(data.error || `Crawl failed (${resp.status})`)
      }
      onSourceAdded({
        id: data.source_id || tempId,
        _prevId: tempId,
        type: 'url',
        name: url,
        status: data.embedded > 0 ? 'indexed' : 'error',
        chunks: data.embedded || 0,
        size: `${data.pages || 0} pages`,
        lastSync: data.embedded > 0
          ? `${data.embedded}/${data.chunks} chunks · just now`
          : 'no chunks indexed',
        errorMessage: data.embedded > 0 ? null : data.message || 'Crawl returned no content',
        _persisted: !!data.source_id,
      }, { replace: true })
      setUrl('')
      onCancel()
    } catch (err) {
      onSourceAdded({
        id: tempId,
        type: 'url',
        name: url,
        status: 'error',
        chunks: 0,
        size: '-',
        lastSync: 'failed',
        errorMessage: err.message,
      }, { replace: true })
    } finally {
      setBusy(false)
    }
  }

  const handleQaSubmit = async () => {
    const source = { type: 'qa', name: question, question, answer }
    const errs = validateKnowledgeSource(source)
    if (errs.length > 0) { setErrors(errs); return }
    if (!authFetch || !orgId || !widgetId) {
      setErrors(['Open a specific widget room to add a Q&A source.'])
      return
    }
    setErrors([])
    setBusy(true)

    const tempId = `u-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

    try {
      const resp = await authFetch(`/api/orgs/${orgId}/widgets/${widgetId}/knowledge/qa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, answer }),
      })
      const data = await resp.json().catch(() => ({}))
      if (!resp.ok || data.success === false) {
        throw new Error(data.error || `Q&A save failed (${resp.status})`)
      }
      onSourceAdded({
        id: data.source_id || tempId,
        type: 'qa',
        name: question,
        status: 'indexed',
        chunks: 1,
        size: `${question.length + answer.length} chars`,
        lastSync: 'pinned · just now',
        _persisted: !!data.source_id,
      })
      setQuestion('')
      setAnswer('')
      onCancel()
    } catch (err) {
      onSourceAdded({
        id: tempId,
        type: 'qa',
        name: question,
        status: 'error',
        chunks: 0,
        size: '-',
        lastSync: 'failed',
        errorMessage: err.message,
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="qx-flat-panel" style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: '#fff' }}>Add knowledge source</span>
        <button onClick={onCancel} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.65)', cursor: 'pointer', fontSize: 16 }}>×</button>
      </div>

      {errors.length > 0 && (
        <div style={{ padding: 8, marginBottom: 10, background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.15)', borderRadius: 6 }}>
          {errors.map((e, i) => <div key={i} style={{ fontSize: 11, color: '#ef4444' }}>{e}</div>)}
        </div>
      )}

      {!widgetId && (
        <div style={{ padding: 8, marginBottom: 10, background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: 6, fontSize: 11, color: '#f59e0b' }}>
          No widget context. Knowledge sources require a specific widget: open its room to add sources.
        </div>
      )}

      <div style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
        {[{ id: 'file', label: '📄 File' }, { id: 'url', label: '🌐 URL' }, { id: 'qa', label: '❓ Q&A' }].map(t => (
          <button key={t.id} onClick={() => { setType(t.id); setErrors([]) }} style={{
            padding: '5px 12px', fontSize: 11, fontWeight: type === t.id ? 700 : 500,
            background: type === t.id ? 'rgba(168,85,247,0.12)' : 'transparent',
            border: type === t.id ? '1px solid rgba(168,85,247,0.3)' : '1px solid rgba(255,255,255,0.06)',
            borderRadius: 6, cursor: 'pointer', color: type === t.id ? '#fff' : 'rgba(255,255,255,0.65)', fontFamily: 'inherit',
          }}>{t.label}</button>
        ))}
      </div>

      {type === 'file' && (
        <FileDropZone
          accept={ACCEPT_ATTR}
          multiple
          maxSize={25 * 1024 * 1024}
          label="Drag and drop files here, or click to browse"
          sublabel={`Supported: ${SUPPORTED_FILE_TYPES.map(t => t.ext).join(', ')} (max 25MB)`}
          onFiles={handleFiles}
        />
      )}

      {type === 'url' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div>
            <label style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.65)', display: 'block', marginBottom: 3 }}>URL to crawl</label>
            <input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://docs.acme.com" style={{
              width: '100%', padding: '8px 12px', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 6, color: '#fff', fontSize: 12, fontFamily: 'inherit', boxSizing: 'border-box',
            }} />
          </div>
          <div>
            <label style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.65)', display: 'block', marginBottom: 3 }}>Crawl depth</label>
            <select value={depth} onChange={e => setDepth(Number(e.target.value))} style={{
              padding: '8px 12px', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 6, color: '#fff', fontSize: 12, fontFamily: 'inherit',
            }}>
              {[1, 2, 3, 4, 5].map(d => <option key={d} value={d}>Depth {d}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 4 }}>
            <button onClick={onCancel} disabled={busy} style={{ padding: '6px 14px', fontSize: 11, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6, color: 'rgba(255,255,255,0.7)', cursor: busy ? 'wait' : 'pointer', fontFamily: 'inherit' }}>Cancel</button>
            <button onClick={handleUrlSubmit} disabled={busy} style={{ padding: '6px 14px', fontSize: 11, fontWeight: 700, background: busy ? 'rgba(48,255,144,0.3)' : '#30ff90', border: 'none', borderRadius: 6, color: '#000', cursor: busy ? 'wait' : 'pointer' }}>
              {busy ? 'Crawling…' : 'Start crawl'}
            </button>
          </div>
        </div>
      )}

      {type === 'qa' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div>
            <label style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.65)', display: 'block', marginBottom: 3 }}>Question</label>
            <input value={question} onChange={e => setQuestion(e.target.value)} placeholder="What are your business hours?" style={{
              width: '100%', padding: '8px 12px', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 6, color: '#fff', fontSize: 12, fontFamily: 'inherit', boxSizing: 'border-box',
            }} />
          </div>
          <div>
            <label style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.65)', display: 'block', marginBottom: 3 }}>Answer</label>
            <textarea value={answer} onChange={e => setAnswer(e.target.value)} placeholder="We are open Monday-Friday, 9am-5pm." rows={3} style={{
              width: '100%', padding: '8px 12px', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 6, color: '#fff', fontSize: 12, fontFamily: 'inherit', resize: 'vertical', boxSizing: 'border-box',
            }} />
          </div>
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 4 }}>
            <button onClick={onCancel} disabled={busy} style={{ padding: '6px 14px', fontSize: 11, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6, color: 'rgba(255,255,255,0.7)', cursor: busy ? 'wait' : 'pointer', fontFamily: 'inherit' }}>Cancel</button>
            <button onClick={handleQaSubmit} disabled={busy} style={{ padding: '6px 14px', fontSize: 11, fontWeight: 700, background: busy ? 'rgba(48,255,144,0.3)' : '#30ff90', border: 'none', borderRadius: 6, color: '#000', cursor: busy ? 'wait' : 'pointer' }}>
              {busy ? 'Saving…' : 'Add Q&A'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function formatBytesFromConfig(cfg, fallback) {
  const n = cfg?.fileSize
  if (!n && n !== 0) return fallback || '-'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function hydrateSource(row) {
  const cfg = row.config || {}
  let size = '-'
  if (row.type === 'file') size = formatBytesFromConfig(cfg, '-')
  else if (row.type === 'url') size = `${cfg.pages || 0} pages`
  else if (row.type === 'qa') size = `${(cfg.question?.length || 0) + (cfg.answer?.length || 0)} chars`
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    status: row.status,
    chunks: row.chunks || 0,
    size,
    lastSync: row.lastSync ? new Date(row.lastSync).toLocaleString() : 'unknown',
    errorMessage: row.errorMessage || null,
    injectionFlags: Number(cfg.injection_flags) || 0,
    injectionHigh: Number(cfg.injection_high) || 0,
    superseded: cfg.superseded === true,
    quarantined: row.status === 'quarantined' || row.quarantined === true,
    _persisted: true,
  }
}

export default function KnowledgeTab({ widget, authFetch, orgId }) {
  const widgetId = widget?.id || null
  // P2 knowledge layout: default to the add panel until we know the widget
  // already has sources. Fresh widgets land on the call to action instead of
  // an empty middle column.
  const [showAdd, setShowAdd] = useState(true)
  const [selectedSource, setSelectedSource] = useState(null)
  const [showTestDrawer, setShowTestDrawer] = useState(false)
  const [testQuery, setTestQuery] = useState('')
  const [testResult, setTestResult] = useState(null)
  const [testBusy, setTestBusy] = useState(false)
  const [loadingSources, setLoadingSources] = useState(false)
  const [storage, setStorage] = useState(null)

  const [sources, setSources] = useState([])
  const [removeError, setRemoveError] = useState(null)

  // CW-8.13: load persisted sources on mount
  useEffect(() => {
    if (!authFetch || !orgId || !widgetId) return
    let cancelled = false
    setLoadingSources(true)
    authFetch(`/api/orgs/${orgId}/widgets/${widgetId}/knowledge/sources`)
      .then(r => r.ok ? r.json() : { sources: [] })
      .then(data => {
        if (cancelled) return
        const rows = (data?.sources || []).map(hydrateSource)
        setSources(rows)
        setStorage(data?.storage || null)
        // Only auto-open the add panel while there are zero real sources.
        // A widget that already has sources should land on the detail view.
        setShowAdd(rows.length === 0)
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoadingSources(false) })
    return () => { cancelled = true }
  }, [authFetch, orgId, widgetId])

  // P2 knowledge layout: Escape closes the test knowledge drawer too.
  useEffect(() => {
    if (!showTestDrawer) return
    const handleKeyDown = e => { if (e.key === 'Escape') setShowTestDrawer(false) }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [showTestDrawer])

  const handleToggleAdd = () => {
    setShowAdd(prev => {
      const next = !prev
      if (next) setSelectedSource(null)
      return next
    })
  }

  const handleSelectSource = (source) => {
    setSelectedSource(source)
    setShowAdd(false)
  }

  const upsertSource = (source, { replace } = {}) => {
    setSources(prev => {
      // Match by id, or by _prevId if the server promoted a temp id to a persistent one
      let idx = prev.findIndex(s => s.id === source.id)
      if (idx < 0 && source._prevId) idx = prev.findIndex(s => s.id === source._prevId)
      if (idx >= 0) {
        if (replace) {
          const next = prev.slice()
          next[idx] = { ...prev[idx], ...source, _prevId: undefined }
          return next
        }
        return prev
      }
      return [source, ...prev]
    })
  }

  const handleToggleSuperseded = async (source) => {
    if (!authFetch || !orgId || !widgetId || !source?.id) return
    setRemoveError(null)
    const next = !source.superseded
    try {
      const resp = await authFetch(`/api/orgs/${orgId}/widgets/${widgetId}/knowledge/sources/${source.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ superseded: next }),
      })
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}))
        setRemoveError(data.message || data.error || `Update failed (${resp.status}). Nothing changed.`)
        return
      }
      setSources(prev => prev.map(s => (s.id === source.id ? { ...s, superseded: next } : s)))
      setSelectedSource(prev => (prev && prev.id === source.id ? { ...prev, superseded: next } : prev))
    } catch (err) {
      setRemoveError(`Update failed: ${err.message}. Nothing changed.`)
    }
  }

  const handleRemove = async (sourceId) => {
    if (!authFetch || !orgId || !widgetId || !sourceId) return
    setRemoveError(null)
    try {
      const resp = await authFetch(`/api/orgs/${orgId}/widgets/${widgetId}/knowledge/sources/${sourceId}`, { method: 'DELETE' })
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}))
        setRemoveError(data.message || data.error || `Remove failed (${resp.status}). The source is still in place.`)
        return
      }
      setSources(prev => prev.filter(s => s.id !== sourceId))
      if (selectedSource?.id === sourceId) setSelectedSource(null)
    } catch (err) {
      setRemoveError(`Remove failed: ${err.message}. The source is still in place.`)
    }
  }

  const handleTest = async () => {
    if (!testQuery.trim()) return
    setTestBusy(true)
    setTestResult(null)
    try {
      const resp = await fetch('/collector/quoxchat/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: testQuery,
          widget_id: widgetId || 'demo',
          conversation_history: [],
          visitor_id: 'knowledge-tab-test',
        }),
      })
      const data = await resp.json().catch(() => ({}))
      // B7 audit fix: non-2xx responses used to fall through to "No response"
      // with no cause. Surface the HTTP status plus any error text from the
      // body so an operator sees why the test failed, not just that it did.
      if (!resp.ok) {
        const detail = data.error || data.message || resp.statusText || 'unknown error'
        setTestResult({ answer: `Test failed (HTTP ${resp.status}: ${detail})`, sources: [], confidence: null, error: true })
        return
      }
      setTestResult({
        answer: data.response || data.error || 'No response',
        sources: (data.sources || []).map(s => ({ name: s.title || s.source || '', type: s.pinned ? 'qa' : 'file' })),
        confidence: data.sources?.[0]?.score ?? null,
      })
    } catch (err) {
      setTestResult({ answer: `Test failed: ${err.message}`, sources: [], confidence: null, error: true })
    } finally {
      setTestBusy(false)
    }
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 16, minHeight: 400 }}>
      {/* Left: Sources list */}
      <div className="qx-flat-panel" style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0, overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>Sources</span>
          <button onClick={handleToggleAdd} style={{
            padding: '3px 10px', fontSize: 10, fontWeight: 600,
            background: 'rgba(56,189,248,0.08)', border: '1px solid rgba(56,189,248,0.2)',
            borderRadius: 5, cursor: 'pointer', color: '#38bdf8', fontFamily: 'inherit',
          }}>+ Add</button>
        </div>

        {storage && (
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)' }}>
            Storage: {storage.estimated_sources > 0 ? '~' : ''}{formatBytes(storage.used_bytes)}{storage.limit_bytes ? ` of ${formatBytes(storage.limit_bytes)} used` : ' used'}
          </div>
        )}

        {loadingSources && sources.length === 0 && (
          <div style={{ padding: 12, fontSize: 11, color: 'rgba(255,255,255,0.7)' }}>
            Loading sources…
          </div>
        )}
        {!loadingSources && sources.length === 0 && (
          <div style={{ padding: 12, fontSize: 11, color: 'rgba(255,255,255,0.7)', lineHeight: 1.5 }}>
            No sources yet. Add a file, URL, or Q&A on the right to get started.
          </div>
        )}

        {sources.map(s => {
          const st = formatSourceStatus(s.status)
          const isSelected = selectedSource?.id === s.id
          return (
            <div key={s.id}>
            <button onClick={() => handleSelectSource(s)} style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', textAlign: 'left',
              background: isSelected ? 'rgba(168,85,247,0.08)' : 'rgba(0,0,0,0.12)',
              border: isSelected ? '1px solid rgba(168,85,247,0.2)' : '1px solid rgba(255,255,255,0.04)',
              borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit', width: '100%',
            }}>
              <span style={{ fontSize: 14 }}>{TYPE_ICONS[s.type]}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</div>
                <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.65)' }}>{s.chunks || 0} chunks · {s.size}{s.superseded ? ' · Superseded: reference only' : ''}</div>
              </div>
              {s.status === 'quarantined' && (
                <span data-testid="quarantined-pill" style={{ fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 999, background: 'rgba(239,68,68,0.18)', border: '1px solid rgba(239,68,68,0.5)', color: '#ff8a8a' }}>quarantined</span>
              )}
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: st.color, flexShrink: 0, boxShadow: `0 0 4px ${st.color}44` }} />
            </button>
            {s.suggestSuperseded && !s.superseded && (
              <div data-testid="superseded-prompt" style={{ margin: '4px 2px 0', padding: '6px 8px', fontSize: 10, color: '#ffcf70', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ flex: 1 }}>This looks like an old or replaced document.</span>
                <button type="button" onClick={() => { handleToggleSuperseded(s); setSources(prev => prev.map(x => (x.id === s.id ? { ...x, suggestSuperseded: false } : x))) }} style={{ fontSize: 10, cursor: 'pointer' }}>Treat as reference only</button>
              </div>
            )}
            </div>
          )
        })}
      </div>

      {/* Right: main area, source detail, add panel, or empty state.
          Test knowledge is now a drawer toggle over this area instead of a
          permanent third column, and source detail lives here instead of a
          void middle column (P2 knowledge layout). */}
      <div style={{ position: 'relative', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={() => setShowTestDrawer(v => !v)} style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', fontSize: 11, fontWeight: 600,
            background: showTestDrawer ? 'rgba(168,85,247,0.12)' : 'rgba(255,255,255,0.04)',
            border: showTestDrawer ? '1px solid rgba(168,85,247,0.3)' : '1px solid rgba(255,255,255,0.08)',
            borderRadius: 6, cursor: 'pointer', color: '#fff', fontFamily: 'inherit',
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#a855f7" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 2v6.5L4 18a2 2 0 0 0 1.8 3h12.4a2 2 0 0 0 1.8-3l-5-9.5V2" />
              <path d="M9 2h6" />
            </svg>
            Test knowledge
          </button>
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          {loadingSources && sources.length === 0 && !selectedSource ? (
            <div className="qx-flat-panel" style={{ padding: 24, fontSize: 12, color: 'rgba(255,255,255,0.7)' }}>
              Loading knowledge sources…
            </div>
          ) : showAdd ? (
            <AddSourcePanel widgetId={widgetId} authFetch={authFetch} orgId={orgId} onSourceAdded={upsertSource} onCancel={() => setShowAdd(false)} />
          ) : selectedSource ? (
            <div className="qx-flat-panel">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 20 }}>{TYPE_ICONS[selectedSource.type]}</span>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#fff' }}>{selectedSource.name}</div>
                    <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)' }}>{selectedSource.type} · {selectedSource.size}</div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 10, fontWeight: 600, color: formatSourceStatus(selectedSource.status).color }}>
                    {formatSourceStatus(selectedSource.status).icon} {formatSourceStatus(selectedSource.status).label}
                  </span>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 11 }}>
                <div style={{ padding: 8, background: 'rgba(0,0,0,0.15)', borderRadius: 6 }}>
                  <div style={{ color: 'rgba(255,255,255,0.65)', marginBottom: 2 }}>Chunks</div>
                  <div style={{ color: '#fff', fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}>{selectedSource.chunks || 0}</div>
                </div>
                <div style={{ padding: 8, background: 'rgba(0,0,0,0.15)', borderRadius: 6 }}>
                  <div style={{ color: 'rgba(255,255,255,0.65)', marginBottom: 2 }}>Status</div>
                  <div style={{ color: '#fff', fontWeight: 700 }}>{selectedSource.lastSync}</div>
                </div>
              </div>
              {selectedSource.errorMessage && (
                <div style={{ marginTop: 10, padding: 8, background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.15)', borderRadius: 6, fontSize: 11, color: '#ef4444' }}>
                  {selectedSource.errorMessage}
                </div>
              )}
              {selectedSource.injectionFlags > 0 && (
                <div role="alert" data-testid="injection-warning" style={{ marginTop: 10, padding: 8, background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: 6, fontSize: 11, color: '#f59e0b' }}>
                  {selectedSource.injectionFlags} passages look like instructions to the bot; {selectedSource.injectionHigh} excluded
                </div>
              )}
              {removeError && (
                <div role="alert" style={{ marginTop: 10, padding: 8, background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.15)', borderRadius: 6, fontSize: 11, color: '#ef4444' }}>
                  {removeError}
                </div>
              )}
              {selectedSource.superseded && (
                <div data-testid="superseded-note" style={{ marginTop: 10, padding: 8, background: 'rgba(148,163,184,0.08)', border: '1px solid rgba(148,163,184,0.25)', borderRadius: 6, fontSize: 11, color: '#cbd5e1' }}>
                  Superseded: reference only. Visible in admin search, never used in visitor answers or citations.
                </div>
              )}
              {selectedSource._persisted && selectedSource.type !== 'connector' && (
                <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
                  <button
                    onClick={() => handleToggleSuperseded(selectedSource)}
                    style={{ padding: '5px 12px', fontSize: 10, fontWeight: 600, background: 'rgba(148,163,184,0.08)', border: '1px solid rgba(148,163,184,0.25)', borderRadius: 6, cursor: 'pointer', color: '#cbd5e1', fontFamily: 'inherit' }}
                  >
                    {selectedSource.superseded ? 'Use in answers again' : 'Mark as superseded'}
                  </button>
                </div>
              )}
              {selectedSource._persisted && (
                <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
                  <button
                    onClick={() => handleRemove(selectedSource.id)}
                    style={{ padding: '5px 12px', fontSize: 10, fontWeight: 600, background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.15)', borderRadius: 6, cursor: 'pointer', color: '#ef4444', fontFamily: 'inherit' }}
                  >
                    Remove
                  </button>
                  <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', alignSelf: 'center' }}>
                    Removes this source and its indexed content from the widget.
                  </span>
                </div>
              )}
            </div>
          ) : (
            <div className="qx-flat-panel" style={{ padding: 40, textAlign: 'center', color: 'rgba(255,255,255,0.7)', fontSize: 12 }}>
              Select a source to view details, or click + Add to add a new one.
            </div>
          )}
        </div>

        {/* Test knowledge drawer: slides over the main area, replacing the
            old permanent right column. Escape closes it (near-broken audit item). */}
        {showTestDrawer && (
          <div className="qx-flat-panel" style={{
            position: 'absolute', top: 0, right: 0, bottom: 0, width: 300, zIndex: 20,
            display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0, overflowY: 'auto',
            boxShadow: '-8px 0 24px rgba(0,0,0,0.4)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>Test knowledge</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {testResult && (
                  <button onClick={() => { setTestResult(null); setTestQuery('') }} style={{
                    padding: '3px 8px', fontSize: 10, background: 'transparent',
                    border: '1px solid rgba(255,255,255,0.08)', borderRadius: 5,
                    color: 'rgba(255,255,255,0.6)', cursor: 'pointer', fontFamily: 'inherit',
                  }}>Clear</button>
                )}
                <button onClick={() => setShowTestDrawer(false)} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.65)', cursor: 'pointer', fontSize: 16 }}>×</button>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 6 }}>
              <input
                value={testQuery} onChange={e => setTestQuery(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && !testBusy && handleTest()}
                placeholder="Ask as if you were a visitor…"
                style={{
                  flex: 1, padding: '8px 10px', background: 'rgba(0,0,0,0.25)',
                  border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6,
                  color: '#fff', fontSize: 11, fontFamily: 'inherit',
                }}
              />
              <button onClick={handleTest} disabled={testBusy || !testQuery.trim()} style={{
                padding: '6px 14px', fontSize: 11, fontWeight: 700,
                background: testBusy || !testQuery.trim() ? 'rgba(168,85,247,0.3)' : '#a855f7',
                border: 'none', borderRadius: 6, color: '#fff',
                cursor: testBusy || !testQuery.trim() ? 'not-allowed' : 'pointer',
                fontFamily: 'inherit',
              }}>
                {testBusy ? '…' : 'Ask'}
              </button>
            </div>

            {!testResult && !testBusy && (
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.7)', lineHeight: 1.6 }}>
                Simulates a visitor question against this widget's knowledge. Answers include source citations and a confidence score.
              </div>
            )}

            {testBusy && (
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>Thinking…</div>
            )}

            {testResult && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, overflow: 'auto', minHeight: 0 }}>
                <div style={{ fontSize: 11, color: testResult.error ? '#ef4444' : 'rgba(255,255,255,0.9)', lineHeight: 1.55 }}>
                  {testResult.answer}
                </div>

                {testResult.sources.length > 0 && (
                  <div>
                    <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4, fontWeight: 600 }}>Sources</div>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {testResult.sources.map((s, i) => (
                        <span key={i} style={{
                          padding: '3px 7px', fontSize: 10, fontWeight: 500,
                          background: 'rgba(168,85,247,0.08)', color: '#c084fc',
                          borderRadius: 4, border: '1px solid rgba(168,85,247,0.18)',
                        }}>
                          {TYPE_ICONS[s.type] || '📄'} {s.name}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {testResult.confidence != null && (
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4, fontWeight: 600 }}>
                      <span>Confidence</span>
                      <span style={{ color: '#fff' }}>{Math.round(testResult.confidence * 100)}%</span>
                    </div>
                    <div style={{ height: 4, background: 'rgba(255,255,255,0.05)', borderRadius: 2, overflow: 'hidden' }}>
                      <div style={{
                        width: `${Math.round(testResult.confidence * 100)}%`,
                        height: '100%',
                        background: testResult.confidence > 0.7 ? '#30ff90' : testResult.confidence > 0.4 ? '#f59e0b' : '#ef4444',
                        transition: 'width 300ms',
                      }} />
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
