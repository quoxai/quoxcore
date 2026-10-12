/**
 * ConnectorBuilderModal — CW-9.7b
 *
 * Creates a connector bound to a widget. Per-type forms mirror the
 * validators in services/auth/routes/widget-connectors.js so admins see
 * inline errors instead of round-tripping to the server for every typo.
 *
 * Supported types: rest_api, webhook, database (sqlite).
 */

import { useState } from 'react'
import { planGateMessage } from './planGateMessage'

const CONN_TYPES = [
  { id: 'rest_api', label: 'REST API', desc: 'Query an external HTTP endpoint' },
  { id: 'webhook', label: 'Webhook', desc: 'Send outbound events (fire-and-forget)' },
  { id: 'database', label: 'Database', desc: 'Read from a SQLite file (pg/mysql coming soon)' },
]

const MODAL_STYLE = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
}
const PANEL_STYLE = {
  width: 560, maxHeight: '90vh', overflowY: 'auto',
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

export default function ConnectorBuilderModal({ widget, authFetch, orgId, onClose, onCreated }) {
  const [type, setType] = useState('rest_api')
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  // Per-type form state
  const [restBaseUrl, setRestBaseUrl] = useState('')
  const [restAuth, setRestAuth] = useState('none')
  const [restHeader, setRestHeader] = useState('X-API-Key')
  const [restEnvVar, setRestEnvVar] = useState('')

  const [webhookUrl, setWebhookUrl] = useState('')
  const [webhookHmacVar, setWebhookHmacVar] = useState('')

  const [dbDriver, setDbDriver] = useState('sqlite')
  const [dbPath, setDbPath] = useState('/var/lib/quox/')

  function buildConfig() {
    if (type === 'rest_api') {
      const cfg = { base_url: restBaseUrl.trim(), auth_type: restAuth }
      if (restAuth === 'api_key') {
        cfg.api_key_header = restHeader.trim() || 'X-API-Key'
        cfg.secret_env_var = restEnvVar.trim()
      } else if (restAuth === 'bearer') {
        cfg.secret_env_var = restEnvVar.trim()
      }
      return cfg
    }
    if (type === 'webhook') {
      const cfg = { url: webhookUrl.trim() }
      if (webhookHmacVar.trim()) cfg.hmac_secret_env_var = webhookHmacVar.trim()
      return cfg
    }
    if (type === 'database') {
      return { driver: dbDriver, db_path: dbPath.trim() }
    }
    return {}
  }

  function validateLocal() {
    if (!name.trim()) return 'Name required'
    if (type === 'rest_api') {
      if (!restBaseUrl.trim()) return 'Base URL required'
      try { new URL(restBaseUrl); } catch { return 'Base URL must be http(s)://…' }
      if ((restAuth === 'api_key' || restAuth === 'bearer') && !/^[A-Z][A-Z0-9_]{0,63}$/.test(restEnvVar.trim())) {
        return 'Env var name must be uppercase + underscores (e.g. STRIPE_API_KEY)'
      }
    }
    if (type === 'webhook') {
      if (!webhookUrl.trim()) return 'Webhook URL required'
      try { new URL(webhookUrl); } catch { return 'Webhook URL must be http(s)://…' }
      if (webhookHmacVar.trim() && !/^[A-Z][A-Z0-9_]{0,63}$/.test(webhookHmacVar.trim())) {
        return 'HMAC env var name must be uppercase + underscores'
      }
    }
    if (type === 'database') {
      if (!dbPath.trim()) return 'DB path required'
      if (dbPath.includes('..')) return 'DB path must not contain ..'
      if (dbPath !== ':memory:' && !['/var/lib/quox/', '/tmp/'].some(p => dbPath.startsWith(p))) {
        return 'SQLite path must start with /var/lib/quox/ or /tmp/ (or use :memory:)'
      }
    }
    return null
  }

  async function handleCreate(e) {
    e.preventDefault()
    const localErr = validateLocal()
    if (localErr) { setError(localErr); return }
    setSaving(true)
    setError(null)
    try {
      const resp = await authFetch(`/api/orgs/${orgId}/widgets/${widget.id}/connectors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), connector_type: type, config: buildConfig() }),
      })
      if (resp.ok) {
        const data = await resp.json().catch(() => ({}))
        onCreated?.(data)
        onClose?.()
      } else {
        const body = await resp.json().catch(() => ({}))
        setError(planGateMessage(resp.status, body) || body.error || `Create failed (${resp.status})`)
      }
    } catch (err) {
      setError(err.message || 'Create failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={MODAL_STYLE} role="dialog" aria-label="New connector" onClick={e => { if (e.target === e.currentTarget) onClose?.() }}>
      <form style={PANEL_STYLE} onSubmit={handleCreate}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#fff' }}>New connector</div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.6)', fontSize: 18, cursor: 'pointer' }}>×</button>
        </div>

        <div style={FIELD_STYLE}>
          <label style={LABEL_STYLE}>Type</label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
            {CONN_TYPES.map(t => (
              <button
                key={t.id}
                type="button"
                onClick={() => setType(t.id)}
                style={{
                  padding: 10, borderRadius: 8, cursor: 'pointer', textAlign: 'left',
                  background: type === t.id ? 'rgba(168,85,247,0.14)' : 'rgba(255,255,255,0.02)',
                  border: `1px solid ${type === t.id ? 'rgba(168,85,247,0.4)' : 'rgba(255,255,255,0.08)'}`,
                  color: '#fff',
                }}
              >
                <div style={{ fontSize: 11, fontWeight: 700 }}>{t.label}</div>
                <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.55)', marginTop: 2 }}>{t.desc}</div>
              </button>
            ))}
          </div>
        </div>

        <div style={FIELD_STYLE}>
          <label style={LABEL_STYLE}>Name</label>
          <input style={INPUT_STYLE} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. stripe_api" maxLength={80} />
        </div>

        {type === 'rest_api' && (
          <>
            <div style={FIELD_STYLE}>
              <label style={LABEL_STYLE}>Base URL</label>
              <input style={INPUT_STYLE} value={restBaseUrl} onChange={e => setRestBaseUrl(e.target.value)} placeholder="https://api.example.com" />
            </div>
            <div style={FIELD_STYLE}>
              <label style={LABEL_STYLE}>Auth type</label>
              <select style={INPUT_STYLE} value={restAuth} onChange={e => setRestAuth(e.target.value)}>
                <option value="none">None</option>
                <option value="api_key">API key (header)</option>
                <option value="bearer">Bearer token</option>
              </select>
            </div>
            {restAuth === 'api_key' && (
              <div style={FIELD_STYLE}>
                <label style={LABEL_STYLE}>Header name</label>
                <input style={INPUT_STYLE} value={restHeader} onChange={e => setRestHeader(e.target.value)} placeholder="X-API-Key" />
              </div>
            )}
            {(restAuth === 'api_key' || restAuth === 'bearer') && (
              <div style={FIELD_STYLE}>
                <label style={LABEL_STYLE}>Secret env var</label>
                <input style={INPUT_STYLE} value={restEnvVar} onChange={e => setRestEnvVar(e.target.value)} placeholder="STRIPE_API_KEY" />
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', marginTop: 4 }}>Uppercase + underscores. The secret itself must be set on the collector host.</div>
              </div>
            )}
          </>
        )}

        {type === 'webhook' && (
          <>
            <div style={FIELD_STYLE}>
              <label style={LABEL_STYLE}>Webhook URL</label>
              <input style={INPUT_STYLE} value={webhookUrl} onChange={e => setWebhookUrl(e.target.value)} placeholder="https://hooks.zapier.com/..." />
            </div>
            <div style={FIELD_STYLE}>
              <label style={LABEL_STYLE}>HMAC secret env var <span style={{ fontWeight: 400, opacity: 0.6 }}>(optional)</span></label>
              <input style={INPUT_STYLE} value={webhookHmacVar} onChange={e => setWebhookHmacVar(e.target.value)} placeholder="ZAPIER_HMAC_SECRET" />
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', marginTop: 4 }}>Signs the payload as <code>X-Quox-Signature: sha256=...</code>.</div>
            </div>
          </>
        )}

        {type === 'database' && (
          <>
            <div style={FIELD_STYLE}>
              <label style={LABEL_STYLE}>Driver</label>
              <select style={INPUT_STYLE} value={dbDriver} onChange={e => setDbDriver(e.target.value)}>
                <option value="sqlite">SQLite</option>
              </select>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', marginTop: 4 }}>Postgres / MySQL land in CW-9.6b.</div>
            </div>
            <div style={FIELD_STYLE}>
              <label style={LABEL_STYLE}>DB path</label>
              <input style={INPUT_STYLE} value={dbPath} onChange={e => setDbPath(e.target.value)} placeholder="/var/lib/quox/support.db" />
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', marginTop: 4 }}>Must start with <code>/var/lib/quox/</code> or <code>/tmp/</code>. Use <code>:memory:</code> for testing.</div>
            </div>
          </>
        )}

        {error && (
          <div style={{ padding: 10, borderRadius: 6, background: 'rgba(239,68,68,0.12)', color: '#ef4444', fontSize: 11, fontWeight: 600, marginBottom: 12 }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
          <button type="button" onClick={onClose} style={{ padding: '8px 14px', fontSize: 12, fontWeight: 600, background: 'transparent', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, color: '#fff', cursor: 'pointer' }}>Cancel</button>
          <button type="submit" disabled={saving} style={{ padding: '8px 16px', fontSize: 12, fontWeight: 700, background: saving ? 'rgba(168,85,247,0.3)' : '#a855f7', border: 'none', borderRadius: 6, color: '#fff', cursor: saving ? 'wait' : 'pointer' }}>
            {saving ? 'Creating...' : 'Create connector'}
          </button>
        </div>
      </form>
    </div>
  )
}
