/**
 * GrafanaEmbed — Embeds Grafana dashboards and individual panels via iframe
 *
 * When Grafana is not connected, shows a setup wizard that guides the user
 * through entering the URL, testing connectivity, and configuring Grafana
 * for embedding.
 *
 * All API calls go through the collector proxy (no CORS issues).
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  searchDashboards,
  getDashboardUrl,
  getDirectDashboardUrl,
  getDashboardPanels,
  getPanelUrl,
  getHealth,
  getGrafanaBaseUrl,
  testGrafanaUrl,
  saveGrafanaConfig,
} from '../../../services/grafanaClient'
import './monitoring.css'

// fleet #282 — testGrafanaUrl runs server-side (via the collector proxy), so
// a loopback/localhost URL can pass the test (reachable from the server)
// while the actual <iframe> embed loads client-side in the admin's own
// browser, where "localhost" means their machine, not the server. That gap
// produced "test works in settings, dashboard says connection refused."
export function isLikelyBrowserUnreachable(rawUrl) {
  try {
    const { hostname } = new URL(rawUrl)
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname === '[::1]'
  } catch {
    return false
  }
}

const TIME_RANGES = [
  { label: '15m', value: 'now-15m' },
  { label: '1h', value: 'now-1h' },
  { label: '6h', value: 'now-6h' },
  { label: '24h', value: 'now-24h' },
  { label: '7d', value: 'now-7d' },
]

// ── Setup Wizard ──────────────────────────────────────────────────────────────

function GrafanaSetup({ onConnected, currentUrl }) {
  const [url, setUrl] = useState(currentUrl || '')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [saving, setSaving] = useState(false)
  const [step, setStep] = useState(1) // 1: enter URL, 2: configure grafana, 3: done

  const handleTest = async () => {
    if (!url.trim()) return
    setTesting(true)
    setTestResult(null)
    const result = await testGrafanaUrl(url.trim().replace(/\/+$/, ''))
    setTestResult(result)
    setTesting(false)
    if (result.success) {
      setStep(2)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    const result = await saveGrafanaConfig(url.trim().replace(/\/+$/, ''))
    setSaving(false)
    if (result.success) {
      setStep(3)
      setTimeout(() => onConnected(), 500)
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') handleTest()
  }

  return (
    <div className="grafana-setup">
      <div className="grafana-setup__header">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#f46800" strokeWidth="2">
          <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
          <rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>
        </svg>
        <div>
          <h3>Connect Grafana</h3>
          <p>Embed your Grafana dashboards directly in QuoxCORE</p>
        </div>
      </div>

      {/* Step indicators */}
      <div className="grafana-setup__steps">
        <div className={`grafana-setup__step ${step >= 1 ? 'active' : ''} ${step > 1 ? 'done' : ''}`}>
          <span className="grafana-setup__step-num">{step > 1 ? '\u2713' : '1'}</span>
          Connect
        </div>
        <div className="grafana-setup__step-line" />
        <div className={`grafana-setup__step ${step >= 2 ? 'active' : ''} ${step > 2 ? 'done' : ''}`}>
          <span className="grafana-setup__step-num">{step > 2 ? '\u2713' : '2'}</span>
          Configure
        </div>
        <div className="grafana-setup__step-line" />
        <div className={`grafana-setup__step ${step >= 3 ? 'active' : ''}`}>
          <span className="grafana-setup__step-num">{step >= 3 ? '\u2713' : '3'}</span>
          Ready
        </div>
      </div>

      {/* Step 1: Enter URL and test */}
      {step === 1 && (
        <div className="grafana-setup__content">
          <label className="grafana-setup__label">Grafana URL</label>
          <div className="grafana-setup__input-row">
            <input
              type="text"
              className="grafana-setup__input"
              value={url}
              onChange={e => { setUrl(e.target.value); setTestResult(null) }}
              onKeyDown={handleKeyDown}
              placeholder="http://198.51.100.176:3000"
              autoFocus
            />
            <button
              className="grafana-setup__test-btn"
              onClick={handleTest}
              disabled={testing || !url.trim()}
            >
              {testing ? (
                <><div className="grafana-spinner grafana-spinner--sm" /> Testing...</>
              ) : (
                <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> Test Connection</>
              )}
            </button>
          </div>
          <p className="grafana-setup__hint">
            Enter the URL where your Grafana instance is running. This must be reachable from the QuoxCORE server.
          </p>

          {testResult && !testResult.success && (
            <div className="grafana-setup__result grafana-setup__result--fail">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ff5050" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
              <div>
                <strong>Connection failed</strong>
                <p>{testResult.error}</p>
                <p className="grafana-setup__hint">Check that Grafana is running and the URL is correct. The URL must be reachable from the server, not just your browser.</p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Step 2: Configure Grafana for embedding */}
      {step === 2 && (
        <div className="grafana-setup__content">
          <div className="grafana-setup__result grafana-setup__result--pass">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#30ff90" strokeWidth="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
            <div>
              <strong>Connected to Grafana</strong>
              <p>{testResult?.version ? `Version ${testResult.version}` : url}</p>
            </div>
          </div>

          {isLikelyBrowserUnreachable(url) && (
            <div className="grafana-setup__result grafana-setup__result--warn">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ffb030" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
              <div>
                <strong>This URL may not load once embedded</strong>
                <p>The test above ran on the server, where "{new URL(url).hostname}" resolves fine. But the dashboard itself loads directly in your browser — where "{new URL(url).hostname}" means your own machine, not the server. If the embed shows "connection refused" after saving, replace it with the server's LAN IP or a real hostname (e.g. <code>http://192.168.x.x:3000</code>) instead.</p>
              </div>
            </div>
          )}

          <div className="grafana-setup__config-box">
            <h4>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ffb030" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
              Required: Enable embedding in Grafana
            </h4>
            <p>Add these lines to your <code>grafana.ini</code> (or <code>/etc/grafana/grafana.ini</code>):</p>
            <pre className="grafana-setup__code">{`[security]
allow_embedding = true

[auth.anonymous]
enabled = true
org_role = Viewer`}</pre>
            <p className="grafana-setup__hint">
              Then restart Grafana: <code>sudo systemctl restart grafana-server</code>
            </p>
            <p className="grafana-setup__hint">
              Anonymous auth lets the iframe load without login. If you prefer authenticated access, skip the <code>[auth.anonymous]</code> section — users will see a Grafana login prompt inside the embed.
            </p>
          </div>

          <div className="grafana-setup__actions">
            <button className="grafana-setup__back-btn" onClick={() => setStep(1)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
              Back
            </button>
            <button className="grafana-setup__save-btn" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save & Connect'}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Done */}
      {step === 3 && (
        <div className="grafana-setup__content grafana-setup__done">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#30ff90" strokeWidth="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
          <h4>Grafana connected</h4>
          <p>Loading dashboards...</p>
        </div>
      )}
    </div>
  )
}

// ── Main Component ────────────────────────────────────────────────────────────

export function GrafanaEmbed({ compact = false }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [grafanaOk, setGrafanaOk] = useState(false)
  const [dashboards, setDashboards] = useState([])
  const [selectedUid, setSelectedUid] = useState(null)
  const [timeRange, setTimeRange] = useState('now-1h')
  const [iframeError, setIframeError] = useState(false)
  const [embedUrl, setEmbedUrl] = useState(null)
  const [showSetup, setShowSetup] = useState(false)
  const [currentGrafanaUrl, setCurrentGrafanaUrl] = useState('')
  const iframeRef = useRef(null)

  // Panel-level embedding
  const [panels, setPanels] = useState([])
  const [selectedPanelId, setSelectedPanelId] = useState(null)
  const [embedMode, setEmbedMode] = useState('dashboard')
  const [loadingPanels, setLoadingPanels] = useState(false)

  // Iframe load timeout detection
  const loadTimeoutRef = useRef(null)
  const [iframeTimedOut, setIframeTimedOut] = useState(false)

  const fetchDashboards = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)

      // Get current configured URL for display/setup
      const baseUrl = await getGrafanaBaseUrl()
      setCurrentGrafanaUrl(baseUrl)

      const health = await getHealth()
      if (!health.success) {
        setGrafanaOk(false)
        setShowSetup(true)
        return
      }
      setGrafanaOk(true)
      setShowSetup(false)

      const result = await searchDashboards({ type: 'dash-db', limit: 50 })
      if (result.success && result.dashboards?.length > 0) {
        setDashboards(result.dashboards)
        if (!selectedUid) {
          setSelectedUid(result.dashboards[0].uid)
        }
      } else {
        setDashboards([])
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    fetchDashboards()
  }, [fetchDashboards])

  // Fetch panels when dashboard changes
  useEffect(() => {
    if (!selectedUid) return
    let cancelled = false
    const fetchPanels = async () => {
      setLoadingPanels(true)
      const result = await getDashboardPanels(selectedUid)
      if (!cancelled && result.success) {
        const embeddable = (result.panels || []).filter(p => p.type !== 'row')
        setPanels(embeddable)
        setSelectedPanelId(embeddable.length > 0 ? embeddable[0].id : null)
      }
      if (!cancelled) setLoadingPanels(false)
    }
    fetchPanels()
    return () => { cancelled = true }
  }, [selectedUid])

  // Build embed URL
  useEffect(() => {
    let cancelled = false
    const buildUrl = async () => {
      if (!selectedUid) { setEmbedUrl(null); return }
      const opts = { from: timeRange, to: 'now' }
      let url
      if (embedMode === 'panel' && selectedPanelId != null) {
        url = await getPanelUrl(selectedUid, selectedPanelId, opts)
      } else {
        url = await getDashboardUrl(selectedUid, opts)
      }
      if (!cancelled) {
        setEmbedUrl(url + '&kiosk=1&theme=dark')
        setIframeError(false)
        setIframeTimedOut(false)
      }
    }
    buildUrl()
    return () => { cancelled = true }
  }, [selectedUid, selectedPanelId, embedMode, timeRange])

  const handleIframeLoad = () => {
    setIframeError(false)
    setIframeTimedOut(false)
    if (loadTimeoutRef.current) clearTimeout(loadTimeoutRef.current)
  }

  useEffect(() => {
    if (!embedUrl) return
    if (loadTimeoutRef.current) clearTimeout(loadTimeoutRef.current)
    loadTimeoutRef.current = setTimeout(() => setIframeTimedOut(true), 15000)
    return () => { if (loadTimeoutRef.current) clearTimeout(loadTimeoutRef.current) }
  }, [embedUrl])

  const handleDashboardChange = (uid) => {
    setSelectedUid(uid)
    setIframeError(false)
    setSelectedPanelId(null)
  }

  const openInGrafana = async () => {
    if (selectedUid) {
      const url = await getDirectDashboardUrl(selectedUid, { from: timeRange, to: 'now' })
      window.open(url, '_blank')
    }
  }

  const toggleMode = () => {
    setEmbedMode(prev => prev === 'dashboard' ? 'panel' : 'dashboard')
  }

  // ── Compact ──

  if (compact) {
    return (
      <div className="grafana-compact">
        <div className="grafana-compact-header">
          <span className="grafana-compact-title">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f46800" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
            GRAFANA
          </span>
          <span className={`grafana-status-dot ${grafanaOk ? 'online' : 'offline'}`} />
        </div>
        {grafanaOk ? (
          <div className="grafana-compact-info">
            {dashboards.length} dashboard{dashboards.length !== 1 ? 's' : ''}
          </div>
        ) : (
          <div className="grafana-compact-info offline">Not connected</div>
        )}
      </div>
    )
  }

  // ── Full ──

  return (
    <div className="grafana-panel">
      <div className="grafana-header">
        <div className="grafana-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f46800" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
          Grafana Dashboards
          <span className={`grafana-status-badge ${grafanaOk ? 'online' : 'offline'}`}>
            {grafanaOk ? 'Connected' : 'Not Connected'}
          </span>
        </div>
        <div className="grafana-controls">
          {grafanaOk && dashboards.length > 0 && (
            <>
              {embedMode === 'panel' && panels.length > 0 && (
                <select
                  className="grafana-select grafana-panel-select"
                  value={selectedPanelId ?? ''}
                  onChange={e => setSelectedPanelId(Number(e.target.value))}
                >
                  {panels.map(p => (
                    <option key={p.id} value={p.id}>{p.title} ({p.type})</option>
                  ))}
                </select>
              )}

              <button
                className={`grafana-mode-btn ${embedMode === 'panel' ? 'active' : ''}`}
                onClick={toggleMode}
                title={embedMode === 'dashboard' ? 'Switch to panel mode' : 'Switch to dashboard mode'}
                disabled={loadingPanels || panels.length === 0}
              >
                <span style={{ fontSize: 14, lineHeight: 1 }}>{embedMode === 'dashboard' ? '⊞' : '⊟'}</span>
              </button>

              <div className="grafana-time-picker">
                {TIME_RANGES.map(t => (
                  <button
                    key={t.value}
                    className={`grafana-time-btn ${timeRange === t.value ? 'active' : ''}`}
                    onClick={() => setTimeRange(t.value)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              <button className="grafana-open-btn" onClick={openInGrafana} title="Open in Grafana">
                <span style={{ fontSize: 13, lineHeight: 1 }}>↗</span>
              </button>
            </>
          )}
          {grafanaOk && (
            <button className="grafana-refresh-btn" onClick={fetchDashboards} title="Refresh">
              <span style={{ fontSize: 14, lineHeight: 1 }}>↻</span>
            </button>
          )}
          {/* Settings gear — shows setup wizard */}
          <button
            className="grafana-settings-btn"
            onClick={() => setShowSetup(!showSetup)}
            title="Grafana settings"
          >
            <span style={{ fontSize: 14, lineHeight: 1 }}>⚙</span>
          </button>
        </div>
      </div>

      {/* Dashboard tabs */}
      {grafanaOk && dashboards.length > 1 && !showSetup && (
        <div className="grafana-tabs">
          {dashboards.map(d => (
            <button
              key={d.uid}
              className={`grafana-tab ${selectedUid === d.uid ? 'grafana-tab--active' : ''}`}
              onClick={() => handleDashboardChange(d.uid)}
            >
              {d.title}
            </button>
          ))}
        </div>
      )}

      <div className="grafana-body">
        {loading && !showSetup && (
          <div className="grafana-loading">
            <div className="grafana-spinner" />
            Connecting to Grafana...
          </div>
        )}

        {/* Setup wizard — shown when not connected or user clicks gear */}
        {showSetup && !loading && (
          <GrafanaSetup
            currentUrl={currentGrafanaUrl}
            onConnected={() => {
              setShowSetup(false)
              fetchDashboards()
            }}
          />
        )}

        {/* Dashboard view — shown when connected and not in setup */}
        {!showSetup && !loading && grafanaOk && (
          <>
            {dashboards.length === 0 && (
              <div className="grafana-empty">No dashboards found</div>
            )}

            {embedUrl && (
              <div className={`grafana-iframe-container ${embedMode === 'panel' ? 'grafana-iframe--panel' : ''}`}>
                {(iframeError || iframeTimedOut) && (
                  <div className="grafana-iframe-overlay">
                    <p>
                      {iframeTimedOut
                        ? 'Dashboard is taking a long time to load.'
                        : 'Dashboard failed to load.'}
                    </p>
                    <p className="grafana-iframe-overlay__hint">
                      Make sure <code>allow_embedding = true</code> is set in grafana.ini
                    </p>
                    <div className="grafana-iframe-overlay__actions">
                      <button onClick={() => setShowSetup(true)}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4"/></svg>
                        Setup Guide
                      </button>
                      <button onClick={openInGrafana}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                        Open in Grafana
                      </button>
                    </div>
                  </div>
                )}
                <iframe
                  ref={iframeRef}
                  src={embedUrl}
                  className="grafana-iframe"
                  title={embedMode === 'panel' ? 'Grafana Panel' : 'Grafana Dashboard'}
                  frameBorder="0"
                  onLoad={handleIframeLoad}
                  onError={() => setIframeError(true)}
                  /* No sandbox — Grafana needs full JS capabilities to render */
                />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export default GrafanaEmbed
