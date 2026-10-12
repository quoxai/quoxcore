/**
 * MonitoringSetup — Shared setup wizard for monitoring plugins
 *
 * Shows when a monitoring service isn't connected. Handles:
 * 1. Auto-discovery via collector (try to find the service)
 * 2. Manual URL configuration with test
 * 3. Service-specific setup instructions
 */

import { useState, useEffect, useCallback } from 'react'
import '../core/monitoring/monitoring.css'

const SERVICE_META = {
  grafana: {
    name: 'Grafana',
    icon: <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#f46800" strokeWidth="1.5"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>,
    color: '#f46800',
    defaultPort: 3000,
    description: 'Visualisation dashboards and alerting',
    setupSteps: [
      'Install Grafana on a server accessible from your network',
      'Note the URL (e.g. http://192.168.1.100:3000)',
      'In grafana.ini, set [security] allow_embedding = true',
      'Optional: enable [auth.anonymous] for dashboard embedding',
      'Restart grafana-server and enter the URL below',
    ],
    docsUrl: 'https://grafana.com/docs/grafana/latest/setup-grafana/installation/',
  },
  prometheus: {
    name: 'Prometheus',
    icon: <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#e6522c" strokeWidth="1.5"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>,
    color: '#e6522c',
    defaultPort: 9090,
    description: 'Metrics collection and alerting',
    setupSteps: [
      'Install Prometheus on a monitoring server',
      'Configure scrape targets in prometheus.yml for your hosts',
      'Install Node Exporter on each host you want to monitor',
      'Ensure Prometheus is accessible from this network',
      'Enter the Prometheus URL below (e.g. http://192.168.1.100:9090)',
    ],
    docsUrl: 'https://prometheus.io/docs/prometheus/latest/installation/',
  },
  'uptime-kuma': {
    name: 'Uptime Kuma',
    icon: <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="1.5"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>,
    color: '#10b981',
    defaultPort: 3001,
    description: 'Service uptime and availability monitoring',
    setupSteps: [
      'Install Uptime Kuma (Docker recommended: docker run -d -p 3001:3001 louislam/uptime-kuma)',
      'Add monitors for each service you want to track',
      'Create a Status Page (Status Pages → + New Status Page)',
      'Add your monitors to the status page',
      'Paste the status page URL below (e.g. http://your-server:3001/status/your-page)',
    ],
    docsUrl: 'https://github.com/louislam/uptime-kuma',
  },
  proxmox: {
    name: 'Proxmox VE',
    icon: <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#e65100" strokeWidth="1.5"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><circle cx="6" cy="6" r="1"/><circle cx="6" cy="18" r="1"/></svg>,
    color: '#e65100',
    defaultPort: 8006,
    description: 'Virtualisation cluster management',
    needsToken: 'proxmox',
    setupSteps: [
      'Ensure your Proxmox cluster is accessible from this network',
      'Go to Datacenter → Permissions → API Tokens → Add',
      'Select User (e.g. root@pam), enter a Token ID (e.g. quox)',
      'Uncheck "Privilege Separation" for full access',
      'Copy the Secret UUID shown — you cannot view it again',
    ],
    docsUrl: 'https://pve.proxmox.com/wiki/Proxmox_VE_API',
  },
}

export function MonitoringSetup({ serviceId, onConnected, currentUrl }) {
  const meta = SERVICE_META[serviceId] || SERVICE_META.prometheus
  const [url, setUrl] = useState(currentUrl || '')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [saving, setSaving] = useState(false)
  const [token, setToken] = useState('')
  const [pveUser, setPveUser] = useState('root@pam')
  const [pveTokenId, setPveTokenId] = useState('')
  const [pveSecret, setPveSecret] = useState('')
  const [discovering, setDiscovering] = useState(false)
  const [discoveryResult, setDiscoveryResult] = useState(null)
  const [showSteps, setShowSteps] = useState(false)

  // Auto-discover on mount
  useEffect(() => {
    handleDiscover()
  }, [])

  const handleDiscover = useCallback(async () => {
    setDiscovering(true)
    setDiscoveryResult(null)
    try {
      const resp = await fetch('/collector/api/v1/monitoring/discover', { method: 'POST', credentials: 'include' })
      const data = await resp.json()
      if (data.success && data.services?.[serviceId]) {
        const svc = data.services[serviceId]
        setDiscoveryResult(svc)
        if (svc.reachable && svc.url) {
          // For Kuma, only pre-fill URL if user hasn't started typing
          // (they need to append /status/<slug> to the base URL)
          if (!url.trim()) {
            setUrl(serviceId === 'uptime-kuma' ? svc.url + '/status/' : svc.url)
          }
          if (serviceId !== 'uptime-kuma') {
            // Pass needsAuth through so the UI shows the correct state
            setTestResult({ success: true, needsAuth: svc.needsAuth || false, data: svc.data })
          }
        }
      }
    } catch {
      // Discovery failed silently
    } finally {
      setDiscovering(false)
    }
  }, [serviceId])

  // Normalize to origin only (strip paths like /dashboard)
  // Also extract status page slug from URLs like /status/realtime
  const normalizeUrl = (raw) => {
    try {
      const parsed = new URL(raw.trim())
      return parsed.origin // protocol + host + port
    } catch {
      return raw.trim().replace(/\/+$/, '')
    }
  }

  const extractStatusPageSlug = (raw) => {
    try {
      const parsed = new URL(raw.trim())
      const match = parsed.pathname.match(/\/status\/([a-zA-Z0-9_-]+)/)
      return match ? match[1] : null
    } catch {
      return null
    }
  }

  const handleTest = async () => {
    if (!url.trim()) return
    setTesting(true)
    setTestResult(null)
    try {
      const testUrl = normalizeUrl(url)
      const slug = extractStatusPageSlug(url)
      // Build test payload — include token for Proxmox so we can verify auth
      const testBody = { url: testUrl, service: serviceId }
      if (meta.needsToken === 'proxmox' && pveUser && pveTokenId && pveSecret) {
        testBody.token = `${pveUser.trim()}!${pveTokenId.trim()}=${pveSecret.trim()}`
      } else if (meta.needsToken && token.trim()) {
        testBody.token = token.trim()
      }
      const resp = await fetch('/collector/api/v1/monitoring/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(testBody),
      })
      const data = await resp.json()
      // If we extracted a slug, verify the status page is reachable
      if (data.success && serviceId === 'uptime-kuma' && slug) {
        try {
          const slugResp = await fetch('/collector/api/v1/monitoring/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ url: testUrl, service: 'uptime-kuma', statusPageSlug: slug }),
          })
          const slugData = await slugResp.json()
          data.statusPageSlug = slug
          data.statusPageOk = slugData.success
        } catch { /* slug test optional */ }
      }
      setTestResult(data)
      // Don't overwrite URL input — user may have entered /status/slug path
      // which we need to preserve for slug extraction on save
    } catch (err) {
      setTestResult({ success: false, error: err.message })
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const saveUrl = normalizeUrl(url)
      const body = { url: saveUrl }
      // Include status page slug + label if extracted from URL
      const slug = extractStatusPageSlug(url) || testResult?.statusPageSlug
      if (serviceId === 'uptime-kuma' && slug) {
        body.statusPageSlug = slug
        body.statusPageLabel = slug.replace(/[-_]/g, ' ')
      }
      if (meta.needsToken === 'proxmox' && pveUser && pveTokenId && pveSecret) {
        body.token = `${pveUser.trim()}!${pveTokenId.trim()}=${pveSecret.trim()}`
      } else if (meta.needsToken && token.trim()) {
        body.token = token.trim()
      }
      const resp = await fetch(`/collector/api/v1/monitoring/config/${serviceId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      })
      const data = await resp.json()
      if (data.success) {
        // Clear stale cache before transitioning to dashboard
        try {
          await fetch(`/collector/api/v1/monitoring/cache/${serviceId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ data: null }),
          })
        } catch { /* cache clear is best-effort */ }
        onConnected?.(saveUrl)
      }
    } catch {
      // save failed
    } finally {
      setSaving(false)
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') handleTest()
  }

  return (
    <div className="monitoring-setup" style={{ '--setup-color': meta.color }}>
      <div className="monitoring-setup__header">
        <div className="monitoring-setup__icon">{meta.icon}</div>
        <div className="monitoring-setup__title">
          <h3>Connect {meta.name}</h3>
          <p>{meta.description}</p>
        </div>
      </div>

      {/* Discovery status */}
      {discovering && (
        <div className="monitoring-setup__status monitoring-setup__status--discovering">
          <div className="monitoring-setup__spinner" />
          Searching for {meta.name} on your network...
        </div>
      )}

      {discoveryResult && !discoveryResult.reachable && !discovering && (
        <div className="monitoring-setup__status monitoring-setup__status--not-found">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
          {meta.name} not found at {discoveryResult.url}
          {discoveryResult.error && <span className="monitoring-setup__error-detail">{discoveryResult.error}</span>}
        </div>
      )}

      {discoveryResult?.reachable && !discovering && (
        <div className="monitoring-setup__status monitoring-setup__status--found">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
          {meta.name} found at {discoveryResult.url}
        </div>
      )}

      {/* URL input */}
      <div className="monitoring-setup__form">
        <label>{meta.name} URL</label>
        <div className="monitoring-setup__input-row">
          <input
            type="url"
            value={url}
            onChange={e => { setUrl(e.target.value); setTestResult(null); }}
            onKeyDown={handleKeyDown}
            placeholder={serviceId === 'uptime-kuma' ? 'http://your-server:3001/status/your-page' : `http://your-server:${meta.defaultPort}`}
          />
          <button
            className="monitoring-setup__test-btn"
            onClick={handleTest}
            disabled={testing || !url.trim()}
          >
            {testing ? (
              <><div className="monitoring-setup__spinner monitoring-setup__spinner--small" /> Testing</>
            ) : (
              <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg> Test</>
            )}
          </button>
        </div>

        {/* Proxmox API token — 3 fields */}
        {meta.needsToken === 'proxmox' && (
          <div style={{ marginTop: 12 }}>
            <label>API Token</label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 6 }}>
              <div>
                <div style={{ fontSize: 11, color: 'var(--shell-text-muted)', marginBottom: 4 }}>User</div>
                <input
                  type="text"
                  value={pveUser}
                  onChange={e => setPveUser(e.target.value)}
                  placeholder="root@pam"
                  className="monitoring-setup__token-input"
                  style={{ marginTop: 0 }}
                />
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--shell-text-muted)', marginBottom: 4 }}>Token ID</div>
                <input
                  type="text"
                  value={pveTokenId}
                  onChange={e => setPveTokenId(e.target.value)}
                  placeholder="quox"
                  className="monitoring-setup__token-input"
                  style={{ marginTop: 0 }}
                />
              </div>
            </div>
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 11, color: 'var(--shell-text-muted)', marginBottom: 4 }}>Secret</div>
              <input
                type="password"
                value={pveSecret}
                onChange={e => setPveSecret(e.target.value)}
                placeholder="075c7f01-5a8e-407b-..."
                className="monitoring-setup__token-input"
                style={{ marginTop: 0 }}
              />
            </div>
          </div>
        )}

        {/* Generic token field (future services) */}
        {meta.needsToken && meta.needsToken !== 'proxmox' && (
          <div style={{ marginTop: 12 }}>
            <label>API Token</label>
            <input
              type="password"
              value={token}
              onChange={e => setToken(e.target.value)}
              placeholder="Enter API token"
              className="monitoring-setup__token-input"
            />
          </div>
        )}

        {/* Test result */}
        {testResult && (
          <div className={`monitoring-setup__result ${testResult.success ? 'monitoring-setup__result--ok' : 'monitoring-setup__result--fail'}`}>
            {testResult.success && testResult.needsAuth ? (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                Reachable — API token required for full access
              </>
            ) : testResult.success ? (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                Connected
                {testResult.data?.version && <span> — v{testResult.data.version}</span>}
                {testResult.statusPageSlug && testResult.statusPageOk && <span> — status page: {testResult.statusPageSlug}</span>}
                {testResult.statusPageSlug && !testResult.statusPageOk && <span style={{ color: '#ffc107' }}> — status page "{testResult.statusPageSlug}" not reachable</span>}
                {serviceId === 'uptime-kuma' && !testResult.statusPageSlug && (
                  <span style={{ color: '#ffc107', display: 'block', marginTop: 4, fontSize: 12 }}>
                    Include the status page path (e.g. /status/your-page) to connect
                  </span>
                )}
              </>
            ) : (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                {testResult.error || 'Connection failed'}
              </>
            )}
          </div>
        )}

        {/* Save button — require actual auth success for token services, slug for Kuma */}
        {testResult?.success && !testResult.needsAuth && (serviceId !== 'uptime-kuma' || testResult.statusPageSlug) && (
          <button
            className="monitoring-setup__save-btn"
            onClick={handleSave}
            disabled={saving}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
            {saving ? 'Saving...' : 'Save & Connect'}
          </button>
        )}
      </div>

      {/* Setup instructions */}
      <div className="monitoring-setup__instructions">
        <button
          className="monitoring-setup__toggle-steps"
          onClick={() => setShowSteps(!showSteps)}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            style={{ transform: showSteps ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>
            <polyline points="9 18 15 12 9 6"/>
          </svg>
          {meta.name} not installed? Setup guide
        </button>

        {showSteps && (
          <div className="monitoring-setup__steps">
            <ol>
              {meta.setupSteps.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
            {meta.docsUrl && (
              <a href={meta.docsUrl} target="_blank" rel="noopener noreferrer" className="monitoring-setup__docs-link">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                Official documentation
              </a>
            )}
          </div>
        )}
      </div>

      {/* Retry discovery */}
      {!discovering && (
        <button className="monitoring-setup__retry" onClick={handleDiscover}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
          Re-scan network
        </button>
      )}
    </div>
  )
}

export default MonitoringSetup
