/**
 * ToolBuilderModal — CW-9.7b
 *
 * Creates a tool backed by an existing connector. For builtins use the
 * quick-add tiles on the ActionsTab (CW-9.7). This modal is for connector-
 * backed tools: REST endpoints, webhook actions, DB queries.
 *
 * The parameters JSONSchema is exposed as a simple add/remove "fields"
 * builder so admins don't need to hand-write JSONSchema. Advanced users
 * can still PATCH the tool via API to set richer schemas.
 */

import { useState, useMemo } from 'react'
import { planGateMessage } from './planGateMessage'

const MODAL_STYLE = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
}
const PANEL_STYLE = {
  width: 620, maxHeight: '92vh', overflowY: 'auto',
  background: '#0d0d12', border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 12, padding: 20,
}
const INPUT_STYLE = {
  width: '100%', padding: '8px 10px', background: 'rgba(0,0,0,0.3)',
  border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6,
  color: '#fff', fontSize: 12, fontFamily: 'inherit', boxSizing: 'border-box',
}
const LABEL_STYLE = { display: 'block', fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,0.65)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }
const FIELD_STYLE = { marginBottom: 12 }

export default function ToolBuilderModal({ widget, connectors, authFetch, orgId, onClose, onCreated, onCreateConnector }) {
  const usableConnectors = useMemo(() => (connectors || []).filter(c => c.status === 'active'), [connectors])

  const [connectorId, setConnectorId] = useState(usableConnectors[0]?.id || '')
  const connector = usableConnectors.find(c => c.id === connectorId)
  const connectorType = connector?.connector_type

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [rateLimit, setRateLimit] = useState('')
  const [fields, setFields] = useState([{ name: '', type: 'string', description: '', required: true }])

  // Per-type config
  const [restMethod, setRestMethod] = useState('GET')
  const [restPath, setRestPath] = useState('/')
  const [restExtract, setRestExtract] = useState('')
  const [identityParamName, setIdentityParamName] = useState('')
  const [identityParamLocation, setIdentityParamLocation] = useState('query')

  const [dbQuery, setDbQuery] = useState('SELECT * FROM ... WHERE id = :id')
  const [dbAllowedTables, setDbAllowedTables] = useState('')
  const [dbRowLimit, setDbRowLimit] = useState('100')

  const [whIncludeMeta, setWhIncludeMeta] = useState(true)

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  function buildParameters() {
    const props = {}
    const required = []
    for (const f of fields) {
      if (!f.name.trim()) continue
      props[f.name.trim()] = { type: f.type, description: f.description || undefined }
      if (f.required) required.push(f.name.trim())
    }
    const schema = { type: 'object', properties: props }
    if (required.length > 0) schema.required = required
    return schema
  }

  function buildConfig() {
    if (connectorType === 'rest_api') {
      const cfg = { method: restMethod, path: restPath }
      if (restExtract.trim()) cfg.response_extract = restExtract.trim()
      const idName = identityParamName.trim()
      if (idName) {
        cfg.identity_param = identityParamLocation === 'query' ? idName : { name: idName, in: identityParamLocation }
      }
      return cfg
    }
    if (connectorType === 'database') {
      const cfg = { query_template: dbQuery }
      const tables = dbAllowedTables.split(',').map(s => s.trim()).filter(Boolean)
      if (tables.length > 0) cfg.allowed_tables = tables
      const rl = parseInt(dbRowLimit, 10)
      if (Number.isFinite(rl)) cfg.row_limit = rl
      return cfg
    }
    if (connectorType === 'webhook') {
      return { include_metadata: whIncludeMeta }
    }
    return {}
  }

  function validateLocal() {
    if (!connectorId) return 'Pick a connector (or create one first)'
    if (!name.trim() || !/^[a-zA-Z][a-zA-Z0-9_]{0,48}$/.test(name.trim())) {
      return 'Name: start with a letter, letters/digits/underscore only, ≤49 chars'
    }
    if (fields.some(f => f.name.trim() && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(f.name.trim()))) {
      return 'Field names must be identifiers (letters, digits, underscore, starting with letter/_)'
    }
    if (connectorType === 'rest_api' && !restPath.startsWith('/')) return 'Path must start with /'
    if (connectorType === 'database') {
      if (!dbQuery.trim()) return 'SQL template required'
      const upper = dbQuery.trim().toUpperCase()
      if (!/^(SELECT|WITH)\b/.test(upper)) return 'Query must start with SELECT or WITH'
    }
    return null
  }

  async function handleCreate(e) {
    e.preventDefault()
    const err = validateLocal()
    if (err) { setError(err); return }
    setSaving(true)
    setError(null)
    try {
      const body = {
        name: name.trim(),
        description: description.trim() || undefined,
        tool_type: 'connector',
        connector_id: connectorId,
        parameters: buildParameters(),
        config: buildConfig(),
        status: 'active',
      }
      const rl = parseInt(rateLimit, 10)
      if (Number.isFinite(rl) && rl > 0) body.rate_limit_per_session = rl

      const resp = await authFetch(`/api/orgs/${orgId}/widgets/${widget.id}/tools`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (resp.ok) {
        const data = await resp.json().catch(() => ({}))
        onCreated?.(data)
        onClose?.()
      } else {
        const json = await resp.json().catch(() => ({}))
        setError(planGateMessage(resp.status, json) || json.error || `Create failed (${resp.status})`)
      }
    } catch (err) {
      setError(err.message || 'Create failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={MODAL_STYLE} role="dialog" aria-label="New tool" onClick={e => { if (e.target === e.currentTarget) onClose?.() }}>
      <form style={PANEL_STYLE} onSubmit={handleCreate}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#fff' }}>New tool</div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.6)', fontSize: 18, cursor: 'pointer' }}>×</button>
        </div>

        {usableConnectors.length === 0 && (
          <div style={{ padding: 12, borderRadius: 8, background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.25)', color: '#f59e0b', fontSize: 11, marginBottom: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
            <span>No active connectors. Create a connector first, then come back to add tools for it.</span>
            {onCreateConnector && (
              <button
                type="button"
                onClick={onCreateConnector}
                style={{ padding: '6px 12px', fontSize: 11, fontWeight: 700, background: 'rgba(245,158,11,0.18)', border: '1px solid rgba(245,158,11,0.4)', borderRadius: 6, color: '#f59e0b', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}
              >
                + Create connector
              </button>
            )}
          </div>
        )}

        <div style={FIELD_STYLE}>
          <label style={LABEL_STYLE}>Connector</label>
          <select style={INPUT_STYLE} value={connectorId} onChange={e => setConnectorId(e.target.value)} disabled={usableConnectors.length === 0}>
            {usableConnectors.length === 0 && <option value="">No connectors available</option>}
            {usableConnectors.map(c => (
              <option key={c.id} value={c.id}>{c.name} ({c.connector_type})</option>
            ))}
          </select>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
          <div style={FIELD_STYLE}>
            <label style={LABEL_STYLE}>Name (LLM sees this)</label>
            <input style={INPUT_STYLE} value={name} onChange={e => setName(e.target.value)} placeholder="get_order_status" />
          </div>
          <div style={FIELD_STYLE}>
            <label style={LABEL_STYLE}>Rate limit / session</label>
            <input style={INPUT_STYLE} type="number" min="1" value={rateLimit} onChange={e => setRateLimit(e.target.value)} placeholder="optional" />
          </div>
        </div>

        <div style={FIELD_STYLE}>
          <label style={LABEL_STYLE}>Description (LLM uses this to decide when to call)</label>
          <input style={INPUT_STYLE} value={description} onChange={e => setDescription(e.target.value)} placeholder="Look up an order by ID and return its status and amount" />
        </div>

        {connectorType === 'rest_api' && (
          <div style={{ padding: 10, borderRadius: 8, background: 'rgba(168,85,247,0.06)', border: '1px solid rgba(168,85,247,0.15)', marginBottom: 12 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#a855f7', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>REST config</div>
            <div style={{ display: 'grid', gridTemplateColumns: '100px 1fr', gap: 8 }}>
              <select style={INPUT_STYLE} value={restMethod} onChange={e => setRestMethod(e.target.value)}>
                {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map(m => <option key={m} value={m}>{m}</option>)}
              </select>
              <input style={INPUT_STYLE} value={restPath} onChange={e => setRestPath(e.target.value)} placeholder="/orders/{order_id}" />
            </div>
            <div style={{ marginTop: 8 }}>
              <label style={LABEL_STYLE}>Response path (dotted, optional)</label>
              <input style={INPUT_STYLE} value={restExtract} onChange={e => setRestExtract(e.target.value)} placeholder="data.order.status" />
            </div>
            <div style={{ marginTop: 8 }}>
              <label style={LABEL_STYLE}>Acts on the signed-in customer (optional)</label>
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 8 }}>
                <input style={INPUT_STYLE} value={identityParamName} onChange={e => setIdentityParamName(e.target.value)} placeholder="customer_id" />
                <select style={INPUT_STYLE} value={identityParamLocation} onChange={e => setIdentityParamLocation(e.target.value)}>
                  <option value="query">query</option>
                  <option value="body">body</option>
                  <option value="header">header</option>
                </select>
              </div>
              <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.45)', marginTop: 4 }}>
                The verified visitor's ID is injected server-side; signed-out visitors are refused. body location requires a non-GET method.
              </div>
            </div>
          </div>
        )}

        {connectorType === 'database' && (
          <div style={{ padding: 10, borderRadius: 8, background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.15)', marginBottom: 12 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#f59e0b', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>Database config</div>
            <label style={LABEL_STYLE}>SQL template (SELECT/WITH, :param bindings)</label>
            <textarea style={{ ...INPUT_STYLE, fontFamily: "'JetBrains Mono', monospace", minHeight: 80 }} value={dbQuery} onChange={e => setDbQuery(e.target.value)} />
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 8, marginTop: 8 }}>
              <div>
                <label style={LABEL_STYLE}>Allowed tables (comma-separated, optional)</label>
                <input style={INPUT_STYLE} value={dbAllowedTables} onChange={e => setDbAllowedTables(e.target.value)} placeholder="orders, customers" />
              </div>
              <div>
                <label style={LABEL_STYLE}>Row limit (1-1000)</label>
                <input style={INPUT_STYLE} type="number" min="1" max="1000" value={dbRowLimit} onChange={e => setDbRowLimit(e.target.value)} />
              </div>
            </div>
          </div>
        )}

        {connectorType === 'webhook' && (
          <div style={{ padding: 10, borderRadius: 8, background: 'rgba(56,189,248,0.06)', border: '1px solid rgba(56,189,248,0.15)', marginBottom: 12 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#38bdf8', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>Webhook config</div>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11, color: '#fff', cursor: 'pointer' }}>
              <input type="checkbox" checked={whIncludeMeta} onChange={e => setWhIncludeMeta(e.target.checked)} />
              Wrap payload in Quox metadata envelope (widget_id, conversation_id, visitor_id, …)
            </label>
          </div>
        )}

        <div style={FIELD_STYLE}>
          <label style={LABEL_STYLE}>Parameters the LLM can pass</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {fields.map((f, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 100px 2fr 60px 28px', gap: 6, alignItems: 'center' }}>
                <input style={INPUT_STYLE} value={f.name} onChange={e => setFields(fs => fs.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} placeholder="field_name" />
                <select style={INPUT_STYLE} value={f.type} onChange={e => setFields(fs => fs.map((x, j) => j === i ? { ...x, type: e.target.value } : x))}>
                  <option value="string">string</option>
                  <option value="number">number</option>
                  <option value="boolean">boolean</option>
                </select>
                <input style={INPUT_STYLE} value={f.description} onChange={e => setFields(fs => fs.map((x, j) => j === i ? { ...x, description: e.target.value } : x))} placeholder="description" />
                <label style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 10, color: 'rgba(255,255,255,0.65)' }}>
                  <input type="checkbox" checked={f.required} onChange={e => setFields(fs => fs.map((x, j) => j === i ? { ...x, required: e.target.checked } : x))} />
                  req
                </label>
                <button type="button" onClick={() => setFields(fs => fs.filter((_, j) => j !== i))} style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 4, color: '#ef4444', cursor: 'pointer', fontSize: 14 }} aria-label="Remove field">×</button>
              </div>
            ))}
            <button type="button" onClick={() => setFields(fs => [...fs, { name: '', type: 'string', description: '', required: false }])} style={{ padding: '6px 10px', fontSize: 11, fontWeight: 600, background: 'rgba(255,255,255,0.05)', border: '1px dashed rgba(255,255,255,0.15)', borderRadius: 6, color: '#fff', cursor: 'pointer', marginTop: 4 }}>
              + Add parameter
            </button>
          </div>
        </div>

        {error && (
          <div style={{ padding: 10, borderRadius: 6, background: 'rgba(239,68,68,0.12)', color: '#ef4444', fontSize: 11, fontWeight: 600, marginBottom: 12 }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
          <button type="button" onClick={onClose} style={{ padding: '8px 14px', fontSize: 12, fontWeight: 600, background: 'transparent', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, color: '#fff', cursor: 'pointer' }}>Cancel</button>
          <button type="submit" disabled={saving || usableConnectors.length === 0} style={{ padding: '8px 16px', fontSize: 12, fontWeight: 700, background: saving ? 'rgba(168,85,247,0.3)' : '#a855f7', border: 'none', borderRadius: 6, color: '#fff', cursor: saving ? 'wait' : 'pointer', opacity: usableConnectors.length === 0 ? 0.4 : 1 }}>
            {saving ? 'Creating...' : 'Create tool'}
          </button>
        </div>
      </form>
    </div>
  )
}
