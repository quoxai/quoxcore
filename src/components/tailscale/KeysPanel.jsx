/**
 * KeysPanel — Tab 3: Auth key inventory, expiry timeline, create key form
 *
 * Shows all auth keys with expiry status, a visual timeline, and a form to create new keys.
 * Revoke action requires confirmation modal.
 */

import React, { useState, useCallback, useEffect } from 'react'

const EXPIRY_PRESETS = [
  { label: '1 hour', seconds: 3600 },
  { label: '24 hours', seconds: 86400 },
  { label: '7 days', seconds: 604800 },
  { label: '30 days', seconds: 2592000 },
  { label: '90 days', seconds: 7776000 },
]

function formatDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

export default function KeysPanel({ data, showNotification }) {
  const [showCreate, setShowCreate] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createdKey, setCreatedKey] = useState(null) // full key string shown once
  const [revokeTarget, setRevokeTarget] = useState(null)
  const [revoking, setRevoking] = useState(false)

  // Escape key closes modals
  useEffect(() => {
    const target = createdKey || revokeTarget
    if (!target) return
    const handler = (e) => { if (e.key === 'Escape') { setCreatedKey(null); setRevokeTarget(null) } }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [createdKey, revokeTarget])

  // Create form state
  const [formReusable, setFormReusable] = useState(false)
  const [formEphemeral, setFormEphemeral] = useState(false)
  const [formPreauthorized, setFormPreauthorized] = useState(true)
  const [formExpiry, setFormExpiry] = useState(86400)
  const [formTags, setFormTags] = useState('')

  const handleCreate = useCallback(async () => {
    setCreating(true)
    try {
      const tags = formTags.split(',').map(t => t.trim()).filter(Boolean)
      const result = await data.createAuthKey({
        reusable: formReusable,
        ephemeral: formEphemeral,
        preauthorized: formPreauthorized,
        tags,
        expiry_seconds: formExpiry,
      })
      setCreatedKey(result.key || result.id)
      setShowCreate(false)
      // Reset form for next use
      setFormReusable(false)
      setFormEphemeral(false)
      setFormPreauthorized(true)
      setFormExpiry(86400)
      setFormTags('')
      showNotification('Auth key created', 'success')
    } catch (err) {
      showNotification(`Create failed: ${err.message}`, 'error')
    }
    setCreating(false)
  }, [data, formReusable, formEphemeral, formPreauthorized, formExpiry, formTags, showNotification])

  const handleRevoke = useCallback(async () => {
    if (!revokeTarget || revoking) return
    setRevoking(true)
    try {
      await data.revokeKey(revokeTarget.id)
      showNotification(`Key ${revokeTarget.id.slice(0, 8)}... revoked`, 'success')
    } catch (err) {
      showNotification(`Revoke failed: ${err.message}`, 'error')
    }
    setRevoking(false)
    setRevokeTarget(null)
  }, [data, revokeTarget, revoking, showNotification])

  const copyKey = useCallback((key) => {
    navigator.clipboard?.writeText(key).then(() => {
      showNotification('Key copied to clipboard', 'success')
    })
  }, [showNotification])

  return (
    <>
      {/* ── Actions bar ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: 'var(--m-text-tertiary, #71717a)' }}>
          {data.keySummary.total} key{data.keySummary.total !== 1 ? 's' : ''}
          {data.keySummary.expiringSoon > 0 && (
            <span style={{ color: '#fbbf24', marginLeft: 8 }}>
              {data.keySummary.expiringSoon} expiring soon
            </span>
          )}
          {data.keySummary.expired > 0 && (
            <span style={{ color: '#f87171', marginLeft: 8 }}>
              {data.keySummary.expired} expired
            </span>
          )}
        </div>
        <button className="ts-btn ts-btn--primary" onClick={() => setShowCreate(!showCreate)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path d="M12 5v14M5 12h14" stroke="#818cf8" strokeWidth="2" strokeLinecap="round" />
          </svg>
          Create Auth Key
        </button>
      </div>

      {/* ── Create key form ── */}
      {showCreate && (
        <div className="ts-key-form">
          <div className="ts-key-form__title">Create Auth Key</div>

          <div className="ts-key-form__field">
            <label className="ts-key-form__label">Tags (comma-separated)</label>
            <input
              className="ts-key-form__input"
              type="text"
              placeholder="tag:server, tag:prod"
              value={formTags}
              onChange={e => setFormTags(e.target.value)}
            />
          </div>

          <div className="ts-key-form__field">
            <label className="ts-key-form__label">Expiry</label>
            <select
              className="ts-key-form__select"
              value={formExpiry}
              onChange={e => setFormExpiry(Number(e.target.value))}
            >
              {EXPIRY_PRESETS.map(p => (
                <option key={p.seconds} value={p.seconds}>{p.label}</option>
              ))}
            </select>
          </div>

          <label className="ts-key-form__checkbox">
            <input type="checkbox" checked={formPreauthorized} onChange={e => setFormPreauthorized(e.target.checked)} />
            Pre-authorized (devices skip manual approval)
          </label>

          <label className="ts-key-form__checkbox">
            <input type="checkbox" checked={formReusable} onChange={e => setFormReusable(e.target.checked)} />
            Reusable (can register multiple devices)
          </label>

          <label className="ts-key-form__checkbox">
            <input type="checkbox" checked={formEphemeral} onChange={e => setFormEphemeral(e.target.checked)} />
            Ephemeral (devices auto-removed when offline)
          </label>

          <div className="ts-key-form__actions">
            <button className="ts-btn" onClick={() => setShowCreate(false)}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                <path d="M18 6L6 18M6 6l12 12" stroke="rgba(255,255,255,0.7)" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              Cancel
            </button>
            <button className="ts-btn ts-btn--primary" onClick={handleCreate} disabled={creating}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                <rect x="3" y="11" width="18" height="10" rx="2" stroke="#818cf8" strokeWidth="1.5" />
                <path d="M7 11V7a5 5 0 0110 0v4" stroke="#818cf8" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              {creating ? 'Creating...' : 'Create Key'}
            </button>
          </div>
        </div>
      )}

      {/* ── Created key display (one-time) ── */}
      {createdKey && (
        <div className="ts-modal-overlay" onClick={() => setCreatedKey(null)}>
          <div className="ts-modal" onClick={e => e.stopPropagation()}>
            <div className="ts-modal__title">Auth Key Created</div>
            <div className="ts-modal__desc">
              Copy this key now. It will not be shown again.
            </div>
            <div style={{
              padding: 12, background: 'rgba(255,255,255,0.04)', borderRadius: 8,
              fontFamily: 'var(--m-font-mono, monospace)', fontSize: 13,
              color: 'var(--m-text-primary, #f4f4f5)', wordBreak: 'break-all', marginBottom: 16
            }}>
              {createdKey}
            </div>
            <div className="ts-modal__actions">
              <button className="ts-btn ts-btn--primary" onClick={() => { copyKey(createdKey); setCreatedKey(null) }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                  <rect x="9" y="9" width="13" height="13" rx="2" stroke="#818cf8" strokeWidth="1.5" />
                  <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="#818cf8" strokeWidth="1.5" />
                </svg>
                Copy and Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Keys table ── */}
      {data.keys.length === 0 ? (
        <div className="ts-empty" style={{ minHeight: '20vh' }}>
          <p className="ts-empty__title" style={{ fontSize: 15 }}>No Auth Keys</p>
          <p className="ts-empty__desc" style={{ fontSize: 13 }}>
            Create an auth key to register new devices on your tailnet.
          </p>
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
        <table className="ts-keys-table">
          <thead>
            <tr>
              <th>Key ID</th>
              <th>Type</th>
              <th>Tags</th>
              <th>Created</th>
              <th>Expires</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {data.keys.map(key => {
              const expiryClass = key.daysUntilExpiry !== null && key.daysUntilExpiry < 0 ? 'ts-key-expiry--expired'
                : key.daysUntilExpiry !== null && key.daysUntilExpiry <= 7 ? 'ts-key-expiry--warning'
                : 'ts-key-expiry--valid'

              const typeLabel = [
                key.preauthorized && 'Pre-auth',
                key.reusable && 'Reusable',
                key.ephemeral && 'Ephemeral',
              ].filter(Boolean).join(', ') || 'Standard'

              return (
                <tr key={key.id}>
                  <td><span className="ts-key-id">{key.id?.slice(0, 12)}...</span></td>
                  <td>{typeLabel}</td>
                  <td>{(key.tags || []).join(', ') || '—'}</td>
                  <td>{formatDate(key.created)}</td>
                  <td>{formatDate(key.expires)}</td>
                  <td>
                    <span className={expiryClass}>
                      {key.daysUntilExpiry !== null && key.daysUntilExpiry < 0
                        ? 'Expired'
                        : key.daysUntilExpiry !== null
                        ? `${key.daysUntilExpiry}d`
                        : 'Active'}
                    </span>
                  </td>
                  <td>
                    <button className="ts-btn ts-btn--danger" style={{ padding: '4px 8px', fontSize: 11 }} onClick={() => setRevokeTarget(key)}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none">
                        <path d="M18 6L6 18M6 6l12 12" stroke="#f87171" strokeWidth="2" strokeLinecap="round" />
                      </svg>
                      Revoke
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        </div>
      )}

      {/* ── Revoke confirmation ── */}
      {revokeTarget && (
        <div className="ts-modal-overlay" onClick={() => setRevokeTarget(null)}>
          <div className="ts-modal" onClick={e => e.stopPropagation()}>
            <div className="ts-modal__title">Revoke Auth Key</div>
            <div className="ts-modal__desc">
              Revoke key <strong>{revokeTarget.id?.slice(0, 12)}...</strong>?
              Devices already registered with this key will not be affected, but the key
              can no longer be used to register new devices.
            </div>
            <div className="ts-modal__actions">
              <button className="ts-btn" onClick={() => setRevokeTarget(null)}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                  <path d="M18 6L6 18M6 6l12 12" stroke="rgba(255,255,255,0.7)" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
                Cancel
              </button>
              <button className="ts-btn ts-btn--danger" onClick={handleRevoke} disabled={revoking}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                  <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6" stroke="#f87171" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2" stroke="#f87171" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {revoking ? 'Revoking...' : 'Revoke Key'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
