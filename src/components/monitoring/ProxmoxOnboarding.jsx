/**
 * ProxmoxOnboarding: "Connect your Proxmox" (DEVFLEET-ONBOARD).
 *
 * The generic Vault form cannot connect a stock Proxmox (self-signed certificate), so the
 * Proxmox plugin owns onboarding in five steps:
 *   1. copy the commands that create a READ-ONLY API token
 *   2. enter URL, token id, token secret
 *   3. fetch the certificate (no credential is sent) and confirm its fingerprint on the node
 *   4. test the token against the pinned certificate
 *   5. save to the vault (assigned to the Proxmox agent)
 *
 * Everything runs through the collector (POST /api/v1/proxmox/onboard/{cert,test,save}); the
 * browser keeps only form drafts. The token secret is a password field, is never rendered back,
 * and is cleared as soon as it is saved. Styling is global .qx-* classes only.
 */

import { useState, useCallback } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { useWorkspace } from '../../contexts/WorkspaceContext'

export const ONBOARD_URL = '/collector/api/v1/proxmox/onboard'

export const CMD_CREATE_TOKEN = 'pveum user token add root@pam quox-ro --privsep 1'
export const CMD_GRANT_AUDITOR = "pveum acl modify / --tokens 'root@pam!quox-ro' --roles PVEAuditor"
export const CMD_CERT_INFO = 'pvenode cert info --output-format json | grep -m1 fingerprint'

function errorText(body, status) {
  if (body && typeof body === 'object') {
    if (body.message) return String(body.message)
    if (body.error) return String(body.error)
  }
  return `Request failed (HTTP ${status})`
}

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" />
    </svg>
  )
}
function ShieldIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />
    </svg>
  )
}
function PlayIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M8 5l11 7-11 7z" />
    </svg>
  )
}
function SaveIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M5 4h11l3 3v13H5z" /><path d="M8 4v6h8V4" />
    </svg>
  )
}

function CommandBlock({ label, command }) {
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true); setFailed(false)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setFailed(true)
    }
  }
  return (
    <div className="qx-stack">
      <div className="qx-row">
        <code className="qx-code-block qx-input--grow" aria-label={label}>{command}</code>
        <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={copy} aria-label={`Copy: ${label}`}>
          <CopyIcon /> {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {failed && <div className="qx-field__error" role="alert">Could not copy. Select the command and copy it by hand.</div>}
    </div>
  )
}

export function ProxmoxOnboarding({ onConnected, onCancel }) {
  const { authFetch } = useAuth()
  const { isOrgAdmin } = useWorkspace()

  const [baseUrl, setBaseUrl] = useState('')
  const [tokenId, setTokenId] = useState('')
  const [tokenSecret, setTokenSecret] = useState('')

  const [cert, setCert] = useState(null)
  const [confirmed, setConfirmed] = useState(false)
  const [test, setTest] = useState(null)
  const [allowWrite, setAllowWrite] = useState(false)
  const [saved, setSaved] = useState(null)

  const [busy, setBusy] = useState(null) // 'cert' | 'test' | 'save'
  const [error, setError] = useState({}) // { cert, test, save }

  const post = useCallback(async (path, payload) => {
    const res = await authFetch(`${ONBOARD_URL}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    let body = null
    try { body = await res.json() } catch { body = null }
    return { ok: res.ok, status: res.status, body }
  }, [authFetch])

  function resetFrom(step) {
    if (step <= 3) { setCert(null); setConfirmed(false) }
    setTest(null); setAllowWrite(false); setSaved(null)
    setError({})
  }

  const fingerprint = cert ? cert.fingerprint256 : ''
  const urlOk = /^https:\/\/\S+$/i.test(baseUrl.trim())
  const credsOk = urlOk && tokenId.trim().length > 0 && tokenSecret.length > 0
  const writeCapable = !!test && test.read_only === false
  const canSave = !!test && !saved && (!writeCapable || allowWrite)

  async function fetchCert() {
    setBusy('cert'); setError((e) => ({ ...e, cert: null }))
    try {
      const r = await post('cert', { base_url: baseUrl.trim() })
      if (r.ok && r.body && r.body.fingerprint256) { setCert(r.body); setConfirmed(false); setTest(null) }
      else setError((e) => ({ ...e, cert: errorText(r.body, r.status) }))
    } catch (err) {
      setError((e) => ({ ...e, cert: err && err.message ? err.message : 'Could not reach the collector' }))
    } finally { setBusy(null) }
  }

  function credPayload() {
    return { base_url: baseUrl.trim(), token_id: tokenId.trim(), token_secret: tokenSecret, tls_fingerprint: fingerprint }
  }

  async function runTest() {
    setBusy('test'); setError((e) => ({ ...e, test: null })); setTest(null); setAllowWrite(false)
    try {
      const r = await post('test', credPayload())
      if (r.ok && r.body && r.body.ok) setTest(r.body)
      else setError((e) => ({ ...e, test: errorText(r.body, r.status) }))
    } catch (err) {
      setError((e) => ({ ...e, test: err && err.message ? err.message : 'Could not reach the collector' }))
    } finally { setBusy(null) }
  }

  async function save() {
    setBusy('save'); setError((e) => ({ ...e, save: null }))
    try {
      const r = await post('save', { ...credPayload(), allow_write: writeCapable && allowWrite })
      if (r.ok && r.body && r.body.ok) {
        setSaved({ credential_id: r.body.credential_id })
        setTokenSecret('')
        if (onConnected) onConnected(baseUrl.trim())
      } else {
        setError((e) => ({ ...e, save: errorText(r.body, r.status) }))
      }
    } catch (err) {
      setError((e) => ({ ...e, save: err && err.message ? err.message : 'Could not reach the collector' }))
    } finally { setBusy(null) }
  }

  return (
    <div className="qx-view">
      <div className="qx-stack">
        <header className="qx-card qx-card--compact qx-row">
          <h2 className="qx-section-title qx-input--grow">Connect your Proxmox</h2>
          {onCancel && (
            <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={onCancel}>
              Back to cluster
            </button>
          )}
        </header>

        {!isOrgAdmin && (
          <div className="qx-banner qx-banner--warn" role="status">
            Only an org admin can connect Proxmox. You can read the steps, but the buttons will be refused.
          </div>
        )}

        <section className="qx-card qx-stack" aria-label="Step 1: create a read-only token">
          <h3 className="qx-section-title">1. Create a read-only token</h3>
          <p>
            In the Proxmox web UI open the node, choose Shell, and run these two commands as root. Note the
            secret Proxmox prints after the first one: it is shown only once.
          </p>
          <CommandBlock label="Create the token" command={CMD_CREATE_TOKEN} />
          <CommandBlock label="Grant the read-only role" command={CMD_GRANT_AUDITOR} />
          <p className="qx-field__hint">
            Read-only on purpose: anything that changes Proxmox goes through Quox approvals, never through this token.
          </p>
        </section>

        <section className="qx-card qx-stack" aria-label="Step 2: connection details">
          <h3 className="qx-section-title">2. Enter the connection</h3>
          <div className="qx-form-grid">
            <div className="qx-form-grid__cells">
              <div className="qx-field" style={{ '--span': 12 }}>
                <label className="qx-field__label qx-field__label--required" htmlFor="pxo-url">Proxmox URL</label>
                <input
                  id="pxo-url" className="qx-input qx-input--mono" value={baseUrl} placeholder="https://hyp-01.example.com:8006"
                  onChange={(e) => { setBaseUrl(e.target.value); resetFrom(3) }} spellCheck={false} autoComplete="off"
                />
              </div>
              <div className="qx-field" style={{ '--span': 6, '--span-sm': 12 }}>
                <label className="qx-field__label qx-field__label--required" htmlFor="pxo-id">Token id</label>
                <input
                  id="pxo-id" className="qx-input qx-input--mono" value={tokenId} placeholder="root@pam!quox-ro"
                  onChange={(e) => { setTokenId(e.target.value); resetFrom(4) }} spellCheck={false} autoComplete="off"
                />
              </div>
              <div className="qx-field" style={{ '--span': 6, '--span-sm': 12 }}>
                <label className="qx-field__label qx-field__label--required" htmlFor="pxo-secret">Token secret</label>
                <input
                  id="pxo-secret" type="password" className="qx-input qx-input--mono" value={tokenSecret}
                  placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                  onChange={(e) => { setTokenSecret(e.target.value); resetFrom(4) }} autoComplete="new-password" spellCheck={false}
                />
                <div className="qx-field__hint">Stored encrypted in the vault. Never shown again.</div>
              </div>
            </div>
          </div>
        </section>

        <section className="qx-card qx-stack" aria-label="Step 3: confirm the certificate">
          <h3 className="qx-section-title">3. Fetch and confirm the certificate</h3>
          <p>
            Proxmox presents a self-signed certificate, so Quox pins it. Fetching it sends no credential.
          </p>
          <div>
            <button type="button" className="qx-btn qx-btn--sm" onClick={fetchCert} disabled={!urlOk || busy === 'cert'}>
              <ShieldIcon /> {busy === 'cert' ? 'Fetching...' : 'Fetch certificate'}
            </button>
          </div>
          {error.cert && <div className="qx-banner qx-banner--error" role="alert">{error.cert}</div>}
          {cert && (
            <div className="qx-stack" data-testid="cert-details">
              <dl className="qx-stack">
                <div><dt>SHA-256 fingerprint</dt><dd><code className="qx-code">{cert.fingerprint256}</code></dd></div>
                <div><dt>Subject</dt><dd>{cert.subject}</dd></div>
                <div><dt>Issuer</dt><dd>{cert.issuer}</dd></div>
                <div><dt>Valid until</dt><dd>{cert.valid_to}</dd></div>
                <div><dt>Self-signed</dt><dd>{cert.self_signed ? 'Yes (normal for a stock Proxmox)' : 'No'}</dd></div>
              </dl>
              <p>Confirm this fingerprint matches the one on the node. In the node Shell run:</p>
              <CommandBlock label="Show the node certificate fingerprint" command={CMD_CERT_INFO} />
              <label className="qx-checkbox">
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                <span className="qx-checkbox__box" aria-hidden="true" />
                I confirmed the fingerprint
              </label>
            </div>
          )}
        </section>

        <section className="qx-card qx-stack" aria-label="Step 4: test the token">
          <h3 className="qx-section-title">4. Test</h3>
          <div>
            <button type="button" className="qx-btn qx-btn--sm" onClick={runTest} disabled={!credsOk || !cert || !confirmed || busy === 'test'}>
              <PlayIcon /> {busy === 'test' ? 'Testing...' : 'Test connection'}
            </button>
          </div>
          {error.test && <div className="qx-banner qx-banner--error" role="alert">{error.test}</div>}
          {test && (
            <div className="qx-stack" data-testid="test-result">
              <div className="qx-banner qx-banner--success" role="status">
                Connected to Proxmox VE {test.version || ''}: {test.node_count} node{test.node_count === 1 ? '' : 's'}.
              </div>
              <div>
                {test.read_only
                  ? <span className="qx-pill qx-pill--online">Read-only token</span>
                  : <span className="qx-pill qx-pill--danger">Can change things</span>}
                {' '}
                <span>{test.privileges ? `${test.privileges.count} privileges across ${test.privileges.paths} path${test.privileges.paths === 1 ? '' : 's'}` : ''}</span>
              </div>
              {writeCapable && (
                <div className="qx-banner qx-banner--warn" role="alert">
                  <div className="qx-stack">
                    <strong>This token is not read-only.</strong>
                    <span>
                      It holds privileges that can change Proxmox: {(test.privileges && test.privileges.write || []).join(', ')}.
                      Create the read-only token from step 1, or tick below to use this one anyway.
                    </span>
                    <label className="qx-checkbox">
                      <input type="checkbox" checked={allowWrite} onChange={(e) => setAllowWrite(e.target.checked)} />
                      <span className="qx-checkbox__box" aria-hidden="true" />
                      Use this token anyway
                    </label>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        <section className="qx-card qx-stack" aria-label="Step 5: save">
          <h3 className="qx-section-title">5. Save</h3>
          <div>
            <button type="button" className="qx-btn qx-btn--primary" onClick={save} disabled={!canSave || busy === 'save'}>
              <SaveIcon /> {busy === 'save' ? 'Saving...' : 'Save connection'}
            </button>
          </div>
          {error.save && <div className="qx-banner qx-banner--error" role="alert">{error.save}</div>}
          {saved && (
            <div className="qx-banner qx-banner--success" role="status">
              Saved, and the stored credential was read back successfully. Loading your cluster...
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

export default ProxmoxOnboarding
