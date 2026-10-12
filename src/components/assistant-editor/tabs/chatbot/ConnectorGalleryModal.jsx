/**
 * ConnectorGalleryModal — QCX-1.5
 *
 * One-click add of pre-built integration templates. Fetches the 15-entry
 * catalog from /api/widget-connector-templates, groups by category, and
 * posts /api/orgs/:o/widgets/:w/connectors/from-template to create both
 * the connector and a starter tool in a single round-trip.
 *
 * If the template's base_url has placeholders like {shop} or {subdomain},
 * the backend returns 400 unresolved_placeholders; we prompt the user for
 * each placeholder inline, then retry. Vault secret ref stays null at
 * creation; admin binds it from the connector row afterwards (Vault tab).
 */

import { useEffect, useMemo, useState } from 'react'
import { planGateMessage } from './planGateMessage'

const MODAL_STYLE = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
}
const PANEL_STYLE = {
  width: 720, maxHeight: '92vh', overflowY: 'auto',
  background: '#0d0d12', border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 12, padding: 20,
}
const TILE_STYLE = {
  padding: 12, border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8,
  background: 'rgba(255,255,255,0.02)', display: 'flex', flexDirection: 'column', gap: 6, cursor: 'pointer',
}
const TILE_STYLE_ACTIVE = {
  ...TILE_STYLE, borderColor: 'rgba(168,85,247,0.5)', background: 'rgba(168,85,247,0.08)',
}
const INPUT_STYLE = {
  width: '100%', padding: '7px 10px', background: 'rgba(0,0,0,0.3)',
  border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6,
  color: '#fff', fontSize: 12, fontFamily: 'inherit', boxSizing: 'border-box',
}
const LABEL_STYLE = { display: 'block', fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,0.65)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }

const CATEGORY_LABELS = {
  payments: 'Payments',
  crm: 'CRM',
  ecommerce: 'Ecommerce',
  support: 'Support',
  dev: 'Dev tools',
  productivity: 'Productivity',
  calendar: 'Calendar',
  messaging: 'Messaging',
  analytics: 'Analytics',
}

export default function ConnectorGalleryModal({ widget, authFetch, orgId, onClose, onAdded }) {
  const [templates, setTemplates] = useState([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)
  const [placeholderValues, setPlaceholderValues] = useState({})
  const [neededPlaceholders, setNeededPlaceholders] = useState([])
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    authFetch('/api/widget-connector-templates')
      .then(r => r.json())
      .then(d => { if (!cancelled) { setTemplates(d.templates || []); setLoading(false) } })
      .catch(() => { if (!cancelled) { setError('Failed to load gallery'); setLoading(false) } })
    return () => { cancelled = true }
  }, [authFetch])

  const grouped = useMemo(() => {
    const out = {}
    for (const t of templates) {
      out[t.category] = out[t.category] || []
      out[t.category].push(t)
    }
    return out
  }, [templates])

  async function addTemplate(slug, overrides) {
    setAdding(true)
    setError(null)
    try {
      const resp = await authFetch(`/api/orgs/${orgId}/widgets/${widget.id}/connectors/from-template`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, overrides: overrides || {} }),
      })
      const data = await resp.json().catch(() => ({}))
      if (resp.status === 400 && data.error === 'unresolved_placeholders') {
        setNeededPlaceholders(data.placeholders || [])
        setError(null)
        return
      }
      if (!resp.ok) { setError(planGateMessage(resp.status, data) || data.error || `Add failed (${resp.status})`); return }
      onAdded?.(data)
      onClose?.()
    } catch (e) {
      setError(e.message || 'Add failed')
    } finally {
      setAdding(false)
    }
  }

  function handleTileClick(slug) {
    setSelected(slug)
    setNeededPlaceholders([])
    setPlaceholderValues({})
    setError(null)
  }

  async function handleAdd() {
    if (!selected) return
    if (neededPlaceholders.length > 0) {
      // second pass: apply placeholders
      const urlKey = 'base_url' // naive — backend reads base_url first
      let baseUrl = templates.find(t => t.slug === selected)?.base_url_pattern
      // Server doesn't return base_url_pattern in list — fetch detail instead.
      try {
        const detailResp = await authFetch(`/api/widget-connector-templates/${selected}`)
        const detail = await detailResp.json()
        const cfg = detail.connector?.config || {}
        let resolved = cfg.base_url || cfg.url || ''
        for (const [k, v] of Object.entries(placeholderValues)) {
          resolved = resolved.replace(new RegExp(`\\{${k}\\}`, 'g'), v)
        }
        const overrides = {}
        overrides.connector = cfg.base_url ? { base_url: resolved } : { url: resolved }
        return addTemplate(selected, overrides)
      } catch (e) {
        setError('Could not fetch template detail to substitute placeholders')
        return
      }
    }
    return addTemplate(selected, {})
  }

  return (
    <div style={MODAL_STYLE} role="dialog" aria-label="Connector gallery" onClick={e => { if (e.target === e.currentTarget) onClose?.() }}>
      <div style={PANEL_STYLE}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#fff' }}>Connector gallery</div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', marginTop: 2 }}>
              15 pre-built integrations. One click adds a connector + a starter tool.
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.6)', fontSize: 18, cursor: 'pointer' }}>×</button>
        </div>

        {loading && <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>Loading gallery…</div>}

        {!loading && Object.entries(grouped).map(([cat, items]) => (
          <div key={cat} style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,0.55)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              {CATEGORY_LABELS[cat] || cat}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
              {items.map(t => (
                <div
                  key={t.slug}
                  style={selected === t.slug ? TILE_STYLE_ACTIVE : TILE_STYLE}
                  onClick={() => handleTileClick(t.slug)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleTileClick(t.slug) } }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: '#fff' }}>{t.vendor}</span>
                    <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.45)', fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase' }}>
                      {t.connector_type === 'rest_api' ? 'REST' : t.connector_type}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.85)' }}>{t.name.replace(`${t.vendor} · `, '')}</div>
                  <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.55)', lineHeight: 1.4 }}>{t.description}</div>
                </div>
              ))}
            </div>
          </div>
        ))}

        {neededPlaceholders.length > 0 && (
          <div style={{ padding: 12, background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: 8, marginBottom: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#f59e0b', marginBottom: 8 }}>
              This template needs a few details from you:
            </div>
            {neededPlaceholders.map(p => (
              <div key={p} style={{ marginBottom: 8 }}>
                <label style={LABEL_STYLE}>{p}</label>
                <input
                  style={INPUT_STYLE}
                  placeholder={`value for {${p}}`}
                  value={placeholderValues[p] || ''}
                  onChange={e => setPlaceholderValues(v => ({ ...v, [p]: e.target.value }))}
                />
              </div>
            ))}
          </div>
        )}

        {error && (
          <div style={{ padding: 10, borderRadius: 8, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)', color: '#ef4444', fontSize: 11, marginBottom: 12 }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button type="button" onClick={onClose} style={{ padding: '7px 14px', fontSize: 11, background: 'transparent', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, color: 'rgba(255,255,255,0.7)', cursor: 'pointer' }}>
            Cancel
          </button>
          <button
            type="button"
            onClick={handleAdd}
            disabled={!selected || adding || (neededPlaceholders.length > 0 && neededPlaceholders.some(p => !placeholderValues[p]))}
            style={{
              padding: '7px 16px', fontSize: 12, fontWeight: 700,
              background: (selected && !adding) ? '#a855f7' : 'rgba(168,85,247,0.3)',
              border: 'none', borderRadius: 6, color: '#fff',
              cursor: (selected && !adding) ? 'pointer' : 'not-allowed', fontFamily: 'inherit',
            }}
          >
            {adding ? 'Adding…' : 'Add to widget'}
          </button>
        </div>
      </div>
    </div>
  )
}
