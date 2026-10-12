/**
 * KeysTab - SSH key management UI
 */

import { useState, useEffect, useCallback } from 'react'
import * as bastionClient from '../../services/bastionClient'

const KeyIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
  </svg>
)

const PlusIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="12" y1="5" x2="12" y2="19"/>
    <line x1="5" y1="12" x2="19" y2="12"/>
  </svg>
)

const UploadIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
    <polyline points="17 8 12 3 7 8"/>
    <line x1="12" y1="3" x2="12" y2="15"/>
  </svg>
)

const TrashIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="3 6 5 6 21 6"/>
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
  </svg>
)

const CheckIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="20 6 9 17 4 12"/>
  </svg>
)

const ShieldIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
  </svg>
)

export default function KeysTab({ hosts = [], groups = [], showNotification }) {
  const [keys, setKeys] = useState([])
  const [selectedKey, setSelectedKey] = useState(null)
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [deploying, setDeploying] = useState(false)
  const [showGenerate, setShowGenerate] = useState(false)
  const [showDeploy, setShowDeploy] = useState(false)
  const [deployResult, setDeployResult] = useState(null)
  const [genForm, setGenForm] = useState({ name: '', comment: '' })
  const [deployForm, setDeployForm] = useState({ key_id: '', target_type: 'all', target_value: '' })

  useEffect(() => {
    loadKeys()
  }, [])

  const loadKeys = useCallback(async () => {
    try {
      setLoading(true)
      const data = await bastionClient.listKeys()
      setKeys(data)
      if (data.length > 0 && !selectedKey) {
        setSelectedKey(data[0])
      }
    } catch (err) {
      console.error('[KeysTab] Failed to load keys:', err)
    } finally {
      setLoading(false)
    }
  }, [selectedKey])

  const handleGenerate = useCallback(async (e) => {
    e.preventDefault()
    if (!genForm.name.trim()) return
    setGenerating(true)
    try {
      const result = await bastionClient.generateKey({
        name: genForm.name,
        comment: genForm.comment || `bastion-${genForm.name}`
      })
      showNotification?.(`Key "${genForm.name}" generated`, 'success')
      setShowGenerate(false)
      setGenForm({ name: '', comment: '' })
      await loadKeys()
      if (result) setSelectedKey(result)
    } catch (err) {
      showNotification?.(`Key generation failed: ${err.message}`, 'error')
    } finally {
      setGenerating(false)
    }
  }, [genForm, showNotification, loadKeys])

  const handleDeploy = useCallback(async () => {
    if (!deployForm.key_id) return
    setDeploying(true)
    setDeployResult(null)
    try {
      const params = { key_id: deployForm.key_id }
      if (deployForm.target_type === 'all') {
        params.all = true
      } else if (deployForm.target_type === 'group') {
        params.group = deployForm.target_value
      } else if (deployForm.target_type === 'host') {
        params.hosts = [deployForm.target_value]
      }
      const result = await bastionClient.deployKey(params)
      setDeployResult(result)
      showNotification?.('Key deployed successfully', 'success')
    } catch (err) {
      setDeployResult({ error: err.message })
      showNotification?.(`Deploy failed: ${err.message}`, 'error')
    } finally {
      setDeploying(false)
    }
  }, [deployForm, showNotification])

  const handleRevoke = useCallback(async (keyId) => {
    if (!confirm(`Revoke key "${keyId}"? This cannot be undone.`)) return
    try {
      await bastionClient.revokeKey(keyId)
      showNotification?.(`Key "${keyId}" revoked`, 'success')
      if (selectedKey?.id === keyId) setSelectedKey(null)
      await loadKeys()
    } catch (err) {
      showNotification?.(`Revoke failed: ${err.message}`, 'error')
    }
  }, [selectedKey, showNotification, loadKeys])

  if (loading) {
    return <div className="bastion-keys-loading">Loading SSH keys...</div>
  }

  return (
    <div className="bastion-keys-tab">
      <div className="bastion-keys-layout">
        {/* Left: Key list */}
        <div className="bastion-keys-list">
          <div className="bastion-keys-list-header">
            <KeyIcon />
            <span>SSH Keys ({keys.length})</span>
          </div>
          <div className="bastion-keys-actions-bar">
            <button className="bastion-keys-action-btn" onClick={() => setShowGenerate(true)}>
              <PlusIcon /> Generate
            </button>
            <button
              className="bastion-keys-action-btn"
              onClick={() => {
                if (keys.length > 0) {
                  setDeployForm(f => ({ ...f, key_id: selectedKey?.id || keys[0].id }))
                  setShowDeploy(true)
                }
              }}
              disabled={keys.length === 0}
            >
              <UploadIcon /> Deploy
            </button>
          </div>
          {keys.map(key => (
            <button
              key={key.id}
              className={`bastion-keys-item ${selectedKey?.id === key.id ? 'bastion-keys-item-active' : ''}`}
              onClick={() => { setSelectedKey(key); setDeployResult(null) }}
            >
              <div className="bastion-keys-item-name">
                <KeyIcon /> {key.name || key.id}
              </div>
              <div className="bastion-keys-item-meta">
                {key.type || 'ed25519'} · {key.created_at ? new Date(key.created_at).toLocaleDateString() : 'unknown'}
              </div>
            </button>
          ))}
          {keys.length === 0 && (
            <div className="bastion-keys-empty">
              No SSH keys managed.
              <button className="bastion-keys-empty-btn" onClick={() => setShowGenerate(true)}>
                <PlusIcon /> Generate your first key
              </button>
            </div>
          )}
        </div>

        {/* Right: Key detail */}
        <div className="bastion-keys-detail">
          {selectedKey ? (
            <>
              <div className="bastion-keys-detail-header">
                <h3><KeyIcon /> {selectedKey.name || selectedKey.id}</h3>
                <button
                  className="bastion-keys-revoke-btn"
                  onClick={() => handleRevoke(selectedKey.id)}
                >
                  <TrashIcon /> Revoke
                </button>
              </div>

              <div className="bastion-keys-meta">
                <div className="bastion-keys-meta-row">
                  <span className="bastion-keys-meta-label">ID:</span>
                  <span className="bastion-keys-meta-value">{selectedKey.id}</span>
                </div>
                <div className="bastion-keys-meta-row">
                  <span className="bastion-keys-meta-label">Type:</span>
                  <span className="bastion-keys-meta-value">{selectedKey.type || 'ed25519'}</span>
                </div>
                <div className="bastion-keys-meta-row">
                  <span className="bastion-keys-meta-label">Created:</span>
                  <span className="bastion-keys-meta-value">
                    {selectedKey.created_at ? new Date(selectedKey.created_at).toLocaleString() : 'Unknown'}
                  </span>
                </div>
                {selectedKey.comment && (
                  <div className="bastion-keys-meta-row">
                    <span className="bastion-keys-meta-label">Comment:</span>
                    <span className="bastion-keys-meta-value">{selectedKey.comment}</span>
                  </div>
                )}
                {selectedKey.deployed_to && selectedKey.deployed_to.length > 0 && (
                  <div className="bastion-keys-meta-row">
                    <span className="bastion-keys-meta-label">Deployed to:</span>
                    <span className="bastion-keys-meta-value">
                      {selectedKey.deployed_to.length} host{selectedKey.deployed_to.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                )}
              </div>

              {selectedKey.public_key && (
                <div className="bastion-keys-pubkey">
                  <h4>Public Key</h4>
                  <pre>{selectedKey.public_key}</pre>
                </div>
              )}

              {selectedKey.fingerprint && (
                <div className="bastion-keys-fingerprint">
                  <h4><ShieldIcon /> Fingerprint</h4>
                  <code>{selectedKey.fingerprint}</code>
                </div>
              )}

              {/* Deploy result */}
              {deployResult && (
                <div className={`bastion-keys-result ${deployResult.error ? 'bastion-keys-result-error' : ''}`}>
                  <h4>{deployResult.error ? 'Deploy Error' : 'Deploy Results'}</h4>
                  <pre>{JSON.stringify(deployResult, null, 2)}</pre>
                </div>
              )}
            </>
          ) : (
            <div className="bastion-keys-placeholder">Select a key or generate a new one</div>
          )}
        </div>
      </div>

      {/* Generate Modal */}
      {showGenerate && (
        <div className="bastion-keys-modal-overlay">
          <form className="bastion-keys-modal" onSubmit={handleGenerate}>
            <h3><PlusIcon /> Generate SSH Key</h3>
            <div className="bastion-keys-field">
              <label>Key Name *</label>
              <input
                type="text"
                placeholder="e.g. fleet-deploy"
                value={genForm.name}
                onChange={e => setGenForm(f => ({ ...f, name: e.target.value }))}
                required
                autoFocus
              />
            </div>
            <div className="bastion-keys-field">
              <label>Comment</label>
              <input
                type="text"
                placeholder="Optional description"
                value={genForm.comment}
                onChange={e => setGenForm(f => ({ ...f, comment: e.target.value }))}
              />
            </div>
            <p className="bastion-keys-modal-note">
              Generates an Ed25519 keypair stored on the bastion host.
            </p>
            <div className="bastion-keys-modal-actions">
              <button type="button" onClick={() => setShowGenerate(false)} className="bastion-keys-btn-cancel">
                Cancel
              </button>
              <button type="submit" className="bastion-keys-btn-primary" disabled={generating}>
                <KeyIcon /> {generating ? 'Generating...' : 'Generate Key'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Deploy Modal */}
      {showDeploy && (
        <div className="bastion-keys-modal-overlay">
          <div className="bastion-keys-modal">
            <h3><UploadIcon /> Deploy Key</h3>
            <div className="bastion-keys-field">
              <label>Key</label>
              <select
                value={deployForm.key_id}
                onChange={e => setDeployForm(f => ({ ...f, key_id: e.target.value }))}
              >
                <option value="">Select key...</option>
                {keys.map(k => <option key={k.id} value={k.id}>{k.name || k.id}</option>)}
              </select>
            </div>
            <div className="bastion-keys-field">
              <label>Target</label>
              <div className="bastion-keys-target-row">
                <select
                  value={deployForm.target_type}
                  onChange={e => setDeployForm(f => ({ ...f, target_type: e.target.value }))}
                >
                  <option value="all">All Hosts</option>
                  <option value="group">Group</option>
                  <option value="host">Single Host</option>
                </select>
                {deployForm.target_type === 'group' && (
                  <select
                    value={deployForm.target_value}
                    onChange={e => setDeployForm(f => ({ ...f, target_value: e.target.value }))}
                  >
                    <option value="">Select group...</option>
                    {groups.map(g => <option key={g} value={g}>{g}</option>)}
                  </select>
                )}
                {deployForm.target_type === 'host' && (
                  <select
                    value={deployForm.target_value}
                    onChange={e => setDeployForm(f => ({ ...f, target_value: e.target.value }))}
                  >
                    <option value="">Select host...</option>
                    {hosts.map(h => <option key={h.id} value={h.id}>{h.id} ({h.ip})</option>)}
                  </select>
                )}
              </div>
            </div>
            <div className="bastion-keys-modal-actions">
              <button onClick={() => { setShowDeploy(false); setDeployResult(null) }} className="bastion-keys-btn-cancel">
                Cancel
              </button>
              <button onClick={handleDeploy} className="bastion-keys-btn-primary" disabled={deploying || !deployForm.key_id}>
                <UploadIcon /> {deploying ? 'Deploying...' : 'Deploy Key'}
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .bastion-keys-tab {
          padding: 0;
        }
        .bastion-keys-loading {
          color: rgba(255,255,255,0.8);
          padding: 40px;
          text-align: center;
        }
        .bastion-keys-layout {
          display: grid;
          grid-template-columns: 280px 1fr;
          gap: 0;
          min-height: 400px;
        }
        .bastion-keys-list {
          border-right: 1px solid var(--m-border-default, rgba(255,255,255,0.18));
          overflow-y: auto;
          max-height: calc(100vh - 260px);
        }
        .bastion-keys-list-header {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 12px 16px;
          font-weight: 600;
          font-size: 13px;
          color: var(--m-text-primary, #f4f4f5);
          border-bottom: 1px solid var(--m-border-default, rgba(255,255,255,0.18));
        }
        .bastion-keys-actions-bar {
          display: flex;
          gap: 4px;
          padding: 8px 12px;
          border-bottom: 1px solid var(--m-border-default, rgba(255,255,255,0.06));
        }
        .bastion-keys-action-btn {
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 5px 10px;
          background: rgba(255,255,255,0.04);
          border: 1px solid var(--m-border-default, rgba(255,255,255,0.1));
          border-radius: 4px;
          color: rgba(255,255,255,0.8);
          font-size: 12px;
          cursor: pointer;
        }
        .bastion-keys-action-btn:hover:not(:disabled) {
          background: rgba(255,255,255,0.08);
          color: var(--m-text-primary, #f4f4f5);
        }
        .bastion-keys-action-btn:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }
        .bastion-keys-item {
          display: flex;
          flex-direction: column;
          gap: 2px;
          width: 100%;
          padding: 10px 16px;
          background: none;
          border: none;
          color: rgba(255,255,255,0.8);
          cursor: pointer;
          text-align: left;
          border-left: 2px solid transparent;
        }
        .bastion-keys-item:hover {
          background: rgba(255,255,255,0.03);
          color: var(--m-text-primary, #f4f4f5);
        }
        .bastion-keys-item-active {
          background: rgba(59, 130, 246, 0.1);
          color: #3b82f6;
          border-left-color: #3b82f6;
        }
        .bastion-keys-item-name {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 13px;
          font-weight: 500;
        }
        .bastion-keys-item-meta {
          font-size: 11px;
          opacity: 0.5;
          padding-left: 22px;
        }
        .bastion-keys-detail {
          padding: 20px 24px;
          overflow-y: auto;
          max-height: calc(100vh - 260px);
        }
        .bastion-keys-detail-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 16px;
        }
        .bastion-keys-detail-header h3 {
          display: flex;
          align-items: center;
          gap: 8px;
          margin: 0;
          font-size: 18px;
          color: var(--m-text-primary, #f4f4f5);
        }
        .bastion-keys-revoke-btn {
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 6px 12px;
          background: rgba(239, 68, 68, 0.1);
          border: 1px solid rgba(239, 68, 68, 0.3);
          border-radius: 4px;
          color: #ef4444;
          font-size: 12px;
          cursor: pointer;
        }
        .bastion-keys-revoke-btn:hover {
          background: rgba(239, 68, 68, 0.2);
        }
        .bastion-keys-meta {
          margin-bottom: 16px;
          padding: 12px;
          background: rgba(255,255,255,0.02);
          border-radius: 6px;
          border: 1px solid var(--m-border-default, rgba(255,255,255,0.06));
        }
        .bastion-keys-meta-row {
          display: flex;
          gap: 8px;
          padding: 4px 0;
          font-size: 13px;
        }
        .bastion-keys-meta-label {
          color: rgba(255,255,255,0.7);
          min-width: 90px;
        }
        .bastion-keys-meta-value {
          color: var(--m-text-primary, #f4f4f5);
          word-break: break-all;
        }
        .bastion-keys-pubkey {
          margin-bottom: 12px;
        }
        .bastion-keys-pubkey h4,
        .bastion-keys-fingerprint h4 {
          font-size: 13px;
          color: var(--m-text-primary, #f4f4f5);
          margin: 0 0 6px;
          font-weight: 600;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .bastion-keys-pubkey pre {
          margin: 0;
          padding: 10px;
          background: rgba(255,255,255,0.05);
          border: 1px solid var(--m-border-default, rgba(255,255,255,0.18));
          border-radius: 4px;
          font-size: 11px;
          color: rgba(255,255,255,0.8);
          word-break: break-all;
          white-space: pre-wrap;
          max-height: 80px;
          overflow-y: auto;
        }
        .bastion-keys-fingerprint {
          margin-bottom: 16px;
        }
        .bastion-keys-fingerprint code {
          display: block;
          padding: 8px 10px;
          background: rgba(255,255,255,0.05);
          border: 1px solid var(--m-border-default, rgba(255,255,255,0.18));
          border-radius: 4px;
          font-size: 12px;
          color: #22c55e;
          font-family: monospace;
        }
        .bastion-keys-result {
          margin-top: 16px;
          padding: 12px;
          background: rgba(34, 197, 94, 0.05);
          border: 1px solid rgba(34, 197, 94, 0.2);
          border-radius: 6px;
        }
        .bastion-keys-result-error {
          background: rgba(239, 68, 68, 0.05);
          border-color: rgba(239, 68, 68, 0.2);
        }
        .bastion-keys-result h4 {
          margin: 0 0 8px;
          font-size: 13px;
          color: var(--m-text-primary, #f4f4f5);
        }
        .bastion-keys-result pre {
          margin: 0;
          font-size: 12px;
          color: rgba(255,255,255,0.8);
          overflow-x: auto;
          white-space: pre-wrap;
          word-break: break-word;
          max-height: 200px;
          overflow-y: auto;
        }
        .bastion-keys-placeholder {
          color: rgba(255,255,255,0.7);
          padding: 40px;
          text-align: center;
          font-size: 13px;
        }
        .bastion-keys-empty {
          color: rgba(255,255,255,0.7);
          padding: 20px 16px;
          text-align: center;
          font-size: 13px;
        }
        .bastion-keys-empty-btn {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          margin-top: 8px;
          padding: 6px 12px;
          background: rgba(59, 130, 246, 0.1);
          border: 1px solid rgba(59, 130, 246, 0.3);
          border-radius: 4px;
          color: #3b82f6;
          font-size: 12px;
          cursor: pointer;
        }
        .bastion-keys-empty-btn:hover {
          background: rgba(59, 130, 246, 0.2);
        }
        .bastion-keys-modal-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0,0,0,0.6);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
        }
        .bastion-keys-modal {
          background: rgba(255,255,255,0.06);
          border: 1px solid var(--m-border-default, rgba(255,255,255,0.1));
          border-radius: 8px;
          padding: 24px;
          min-width: 400px;
          max-width: 500px;
        }
        .bastion-keys-modal h3 {
          display: flex;
          align-items: center;
          gap: 8px;
          margin: 0 0 16px;
          font-size: 16px;
          color: var(--m-text-primary, #f4f4f5);
        }
        .bastion-keys-field {
          margin-bottom: 12px;
        }
        .bastion-keys-field label {
          display: block;
          font-size: 12px;
          color: rgba(255,255,255,0.8);
          margin-bottom: 4px;
        }
        .bastion-keys-field input,
        .bastion-keys-field select {
          width: 100%;
          padding: 8px 10px;
          background: rgba(255,255,255,0.05);
          border: 1px solid var(--m-border-default, rgba(255,255,255,0.1));
          border-radius: 4px;
          color: var(--m-text-primary, #f4f4f5);
          font-size: 13px;
        }
        .bastion-keys-target-row {
          display: flex;
          gap: 8px;
        }
        .bastion-keys-target-row select {
          flex: 1;
        }
        .bastion-keys-modal-note {
          font-size: 12px;
          color: rgba(255,255,255,0.7);
          margin: 8px 0 16px;
        }
        .bastion-keys-modal-actions {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
          margin-top: 16px;
        }
        .bastion-keys-btn-cancel {
          padding: 8px 16px;
          background: none;
          border: 1px solid var(--m-border-default, rgba(255,255,255,0.1));
          border-radius: 4px;
          color: rgba(255,255,255,0.8);
          font-size: 13px;
          cursor: pointer;
        }
        .bastion-keys-btn-cancel:hover {
          background: rgba(255,255,255,0.04);
        }
        .bastion-keys-btn-primary {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 8px 16px;
          background: #3b82f6;
          border: none;
          border-radius: 4px;
          color: white;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
        }
        .bastion-keys-btn-primary:hover:not(:disabled) {
          background: #2563eb;
        }
        .bastion-keys-btn-primary:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        /* ═══ Glass polish (Janus V2 — tab parity) ═══ */
        .bastion-keys-list {
          border-right: 1px solid rgba(255,255,255,0.12) !important;
          background: rgba(255,255,255,0.015);
        }
        .bastion-keys-list-header {
          position: sticky;
          top: 0;
          z-index: 2;
          backdrop-filter: blur(20px) saturate(1.4);
          -webkit-backdrop-filter: blur(20px) saturate(1.4);
          background:
            linear-gradient(rgba(0,0,0,0.35), rgba(0,0,0,0.35)),
            rgba(255,255,255,0.06) !important;
          border-bottom: 1px solid rgba(255,255,255,0.18) !important;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.18);
          padding: 12px 16px !important;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          font-size: 11px !important;
          color: #fff !important;
        }
        .bastion-keys-list-actions {
          padding: 10px 14px !important;
          gap: 8px;
          border-bottom: 1px solid rgba(255,255,255,0.08);
        }
        .bastion-keys-action-btn {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 7px 12px !important;
          background: rgba(255,255,255,0.05) !important;
          border: 1px solid rgba(255,255,255,0.14) !important;
          border-radius: 8px !important;
          color: #fff !important;
          font-size: 11px !important;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          cursor: pointer;
          transition: all 0.15s ease;
        }
        .bastion-keys-action-btn:hover {
          background: rgba(168,85,247,0.14) !important;
          border-color: rgba(168,85,247,0.4) !important;
          transform: translateY(-1px);
        }
        .bastion-keys-item {
          border: none !important;
          border-left: 2px solid transparent !important;
          border-bottom: 1px solid rgba(255,255,255,0.05) !important;
          background: none !important;
          color: rgba(255,255,255,0.85) !important;
          padding: 12px 16px !important;
          transition: background 0.15s ease, border-color 0.15s ease;
        }
        .bastion-keys-item:hover {
          background: rgba(255,255,255,0.04) !important;
        }
        .bastion-keys-item-active {
          background: linear-gradient(90deg, rgba(168,85,247,0.14), rgba(56,189,248,0.04)) !important;
          border-left: 2px solid #a855f7 !important;
          box-shadow: inset 2px 0 0 #a855f7;
          color: #fff !important;
        }
        .bastion-keys-detail {
          padding: 20px 24px !important;
          background: rgba(255,255,255,0.01);
          overflow-y: auto;
          max-height: calc(100vh - 260px);
        }
        .bastion-keys-detail-header h3 {
          display: flex;
          align-items: center;
          gap: 8px;
          margin: 0;
          font-size: 18px;
          color: #fff;
          font-weight: 600;
        }
        .bastion-keys-revoke-btn {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 7px 12px !important;
          background: rgba(239,68,68,0.1) !important;
          border: 1px solid rgba(239,68,68,0.35) !important;
          border-radius: 8px !important;
          color: #fca5a5 !important;
          font-size: 11px !important;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          cursor: pointer;
          transition: all 0.15s ease;
        }
        .bastion-keys-revoke-btn:hover {
          background: rgba(239,68,68,0.2) !important;
          border-color: rgba(239,68,68,0.55) !important;
          color: #fff !important;
          transform: translateY(-1px);
        }
        .bastion-keys-meta {
          padding: 14px 16px !important;
          margin-bottom: 16px !important;
          backdrop-filter: blur(16px) saturate(1.3);
          -webkit-backdrop-filter: blur(16px) saturate(1.3);
          background: rgba(255,255,255,0.04) !important;
          border: 1px solid rgba(255,255,255,0.14) !important;
          border-radius: 10px !important;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.1);
        }
        .bastion-keys-meta-label {
          color: rgba(255,255,255,0.6) !important;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          font-size: 10px;
          min-width: 100px;
        }
        .bastion-keys-meta-value {
          color: #fff !important;
        }
        .bastion-keys-pubkey,
        .bastion-keys-fingerprint,
        .bastion-keys-result {
          padding: 14px 16px !important;
          margin-bottom: 16px !important;
          backdrop-filter: blur(16px) saturate(1.3);
          -webkit-backdrop-filter: blur(16px) saturate(1.3);
          background: rgba(255,255,255,0.03) !important;
          border: 1px solid rgba(255,255,255,0.12) !important;
          border-radius: 10px !important;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.08);
        }
        .bastion-keys-pubkey h4,
        .bastion-keys-fingerprint h4,
        .bastion-keys-result h4 {
          display: flex;
          align-items: center;
          gap: 6px;
          margin: 0 0 8px !important;
          font-size: 10px !important;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: rgba(255,255,255,0.7) !important;
          font-weight: 700;
        }
        .bastion-keys-pubkey pre,
        .bastion-keys-result pre {
          margin: 0;
          padding: 10px 12px;
          background: rgba(0,0,0,0.35);
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 6px;
          font-size: 11px;
          color: #38bdf8;
          overflow-x: auto;
          white-space: pre-wrap;
          word-break: break-all;
          max-height: 300px;
          overflow-y: auto;
        }
        .bastion-keys-fingerprint code {
          display: block;
          padding: 10px 12px;
          background: rgba(0,0,0,0.35);
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 6px;
          font-size: 12px;
          color: #a855f7;
          word-break: break-all;
        }
        .bastion-keys-result {
          background: rgba(34,197,94,0.06) !important;
          border-color: rgba(34,197,94,0.28) !important;
        }
        .bastion-keys-result-error {
          background: rgba(239,68,68,0.06) !important;
          border-color: rgba(239,68,68,0.28) !important;
        }

        /* Modal glass */
        .bastion-keys-modal-overlay {
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          background: rgba(0,0,0,0.55) !important;
        }
        .bastion-keys-modal {
          backdrop-filter: blur(32px) saturate(1.6);
          -webkit-backdrop-filter: blur(32px) saturate(1.6);
          background:
            linear-gradient(rgba(0,0,0,0.35), rgba(0,0,0,0.35)),
            rgba(255,255,255,0.08) !important;
          border: 1px solid rgba(255,255,255,0.22) !important;
          border-radius: 16px !important;
          box-shadow:
            0 24px 72px rgba(0,0,0,0.6),
            0 0 60px rgba(168,85,247,0.12),
            inset 0 1px 0 rgba(255,255,255,0.2) !important;
          padding: 24px !important;
        }
        .bastion-keys-modal h3 {
          display: flex;
          align-items: center;
          gap: 8px;
          margin: 0 0 18px !important;
          font-size: 16px;
          color: #fff;
          font-weight: 600;
        }
        .bastion-keys-field label {
          display: block;
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: rgba(255,255,255,0.7);
          margin-bottom: 6px;
        }
        .bastion-keys-field input,
        .bastion-keys-field select,
        .bastion-keys-target-row select {
          width: 100%;
          padding: 9px 12px !important;
          background: rgba(255,255,255,0.06) !important;
          border: 1px solid rgba(255,255,255,0.14) !important;
          border-radius: 8px !important;
          color: #fff !important;
          font-size: 13px !important;
          font-family: inherit !important;
          transition: border-color 0.15s ease, background 0.15s ease;
        }
        .bastion-keys-field input:focus,
        .bastion-keys-field select:focus,
        .bastion-keys-target-row select:focus {
          outline: none;
          border-color: rgba(168,85,247,0.5) !important;
          background: rgba(255,255,255,0.08) !important;
          box-shadow: 0 0 0 3px rgba(168,85,247,0.08);
        }
        .bastion-keys-modal-note {
          font-size: 11px;
          color: rgba(255,255,255,0.6);
          margin: 10px 0 16px;
          font-style: italic;
        }
        .bastion-keys-btn-cancel {
          padding: 9px 16px !important;
          background: rgba(255,255,255,0.04) !important;
          border: 1px solid rgba(255,255,255,0.14) !important;
          border-radius: 8px !important;
          color: rgba(255,255,255,0.85) !important;
          font-size: 12px !important;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          cursor: pointer;
          transition: all 0.15s ease;
        }
        .bastion-keys-btn-cancel:hover {
          background: rgba(255,255,255,0.08) !important;
          border-color: rgba(255,255,255,0.25) !important;
        }
        .bastion-keys-btn-primary {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 9px 18px !important;
          backdrop-filter: blur(20px) saturate(1.4);
          -webkit-backdrop-filter: blur(20px) saturate(1.4);
          background: linear-gradient(145deg, rgba(168,85,247,0.3) 0%, rgba(56,189,248,0.2) 100%) !important;
          border: 1px solid rgba(168,85,247,0.5) !important;
          border-top-color: rgba(168,85,247,0.65) !important;
          border-left-color: rgba(56,189,248,0.4) !important;
          border-radius: 8px !important;
          color: #fff !important;
          font-size: 12px !important;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          box-shadow: 0 4px 18px rgba(168,85,247,0.22), inset 0 1px 0 rgba(255,255,255,0.2);
          transition: all 0.15s ease;
        }
        .bastion-keys-btn-primary:hover:not(:disabled) {
          background: linear-gradient(145deg, rgba(168,85,247,0.4) 0%, rgba(56,189,248,0.28) 100%) !important;
          transform: translateY(-1px);
          box-shadow: 0 6px 24px rgba(168,85,247,0.32), inset 0 1px 0 rgba(255,255,255,0.25);
        }
        .bastion-keys-placeholder,
        .bastion-keys-empty {
          color: rgba(255,255,255,0.7) !important;
        }
      `}</style>
    </div>
  )
}
