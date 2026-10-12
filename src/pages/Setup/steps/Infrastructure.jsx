/**
 * Infrastructure Step - Configure service endpoints and infrastructure
 *
 * Supports two deployment modes per service:
 * - Local (Docker Compose): Uses local Docker containers
 * - External: Connect to existing instances (cloud, self-hosted, etc.)
 */

import { useState, useEffect } from 'react'

// Check if accessing from non-localhost over HTTP (voice won't work)
const needsHttpsForVoice = () => {
    const hostname = window.location.hostname
    const protocol = window.location.protocol
    if (hostname === 'localhost' || hostname === '127.0.0.1') return false
    if (protocol === 'https:') return false
    return true
}

export default function Infrastructure({ data, onNext, onBack }) {
    // Auto-detect dashboard URL from current browser location
    const defaultDashboardUrl = `${window.location.protocol}//${window.location.host}`

    const [form, setForm] = useState({
        // Dashboard URL (for CORS auto-configuration)
        dashboardUrl: data.infrastructure?.dashboardUrl || defaultDashboardUrl,

        // Qdrant configuration
        qdrantMode: data.infrastructure?.qdrantMode || 'local',
        qdrantUrl: data.infrastructure?.qdrantUrl || 'http://localhost:6333',
        qdrantApiKey: data.infrastructure?.qdrantApiKey || '',

        // SMTP configuration
        smtpHost: data.infrastructure?.smtpHost || '',
        smtpPort: data.infrastructure?.smtpPort || '587',
        smtpUser: data.infrastructure?.smtpUser || '',
        smtpPass: data.infrastructure?.smtpPass || '',
        smtpFrom: data.infrastructure?.smtpFrom || '',

        // VAULT-INTEG P17: class-B instance basics — public URLs, CORS
        // allowlist, TLS/cookie posture, Matrix server name. All optional;
        // empty = leave the env-derived default in place (see placeholders).
        appBaseUrl: data.infrastructure?.appBaseUrl || '',
        publicUrl: data.infrastructure?.publicUrl || '',
        collectorPublicUrl: data.infrastructure?.collectorPublicUrl || '',
        corsOrigins: data.infrastructure?.corsOrigins || '',
        cookieSecure: data.infrastructure?.cookieSecure ?? '',
        matrixServerName: data.infrastructure?.matrixServerName || '',
    })
    const [showSmtp, setShowSmtp] = useState(false)
    const [showAdvanced, setShowAdvanced] = useState(false)
    const [showSsl, setShowSsl] = useState(needsHttpsForVoice())
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState(null)

    // SSL certificate states
    const [sslStatus, setSslStatus] = useState(null)
    const [generatingSsl, setGeneratingSsl] = useState(false)
    const [sslResult, setSslResult] = useState(null)

    // Check SSL status on mount
    useEffect(() => {
        checkSslStatus()
    }, [])

    const checkSslStatus = async () => {
        try {
            const res = await fetch('/api/setup/ssl-status')
            if (res.ok) {
                const data = await res.json()
                setSslStatus(data)
            }
        } catch (e) {
            console.log('[SSL] Could not check SSL status:', e.message)
        }
    }

    const generateSslCertificate = async () => {
        setGeneratingSsl(true)
        setSslResult(null)

        try {
            const res = await fetch('/api/setup/generate-ssl', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            })

            const data = await res.json()

            if (res.ok) {
                setSslResult({ status: 'success', ...data })
                // Refresh SSL status
                await checkSslStatus()
            } else {
                setSslResult({ status: 'error', message: data.message || 'Failed to generate certificate' })
            }
        } catch (err) {
            setSslResult({ status: 'error', message: err.message })
        } finally {
            setGeneratingSsl(false)
        }
    }

    // Connection test states
    const [testingQdrant, setTestingQdrant] = useState(false)
    const [qdrantTestResult, setQdrantTestResult] = useState(null)

    const handleChange = (field) => (e) => {
        setForm({ ...form, [field]: e.target.value })
        // Clear test results when URL changes
        if (field === 'qdrantUrl' || field === 'qdrantMode' || field === 'qdrantApiKey') {
            setQdrantTestResult(null)
        }
    }

    const testQdrantConnection = async () => {
        setTestingQdrant(true)
        setQdrantTestResult(null)

        try {
            // Use proxy for local mode to avoid CORS and handle API key injection
            const url = form.qdrantMode === 'local' ? '/qdrant' : form.qdrantUrl
            const headers = {}
            if (form.qdrantApiKey && form.qdrantMode === 'external') {
                headers['api-key'] = form.qdrantApiKey
            }

            const res = await fetch(`${url}/`, {
                method: 'GET',
                headers,
                signal: AbortSignal.timeout(5000)
            })

            if (res.ok) {
                const data = await res.json().catch(() => ({}))
                const version = data.version || 'unknown'
                setQdrantTestResult({ status: 'success', message: `Connected (v${version})` })
            } else if (res.status === 401 || res.status === 403) {
                setQdrantTestResult({ status: 'error', message: 'Authentication failed - check API key' })
            } else {
                setQdrantTestResult({ status: 'error', message: `HTTP ${res.status}: ${res.statusText}` })
            }
        } catch (err) {
            if (err.name === 'TimeoutError' || err.name === 'AbortError') {
                setQdrantTestResult({ status: 'error', message: 'Connection timed out (5s)' })
            } else if (err.message.includes('Failed to fetch')) {
                setQdrantTestResult({ status: 'error', message: 'Cannot connect - service may be down or CORS blocked' })
            } else {
                setQdrantTestResult({ status: 'error', message: err.message })
            }
        } finally {
            setTestingQdrant(false)
        }
    }

    const handleSubmit = async (e) => {
        e.preventDefault()
        setError(null)
        setLoading(true)

        try {
            // Determine final URLs based on mode
            const qdrantUrl = form.qdrantMode === 'local' ? 'http://localhost:6333' : form.qdrantUrl

            const res = await fetch('/api/setup/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    dashboardUrl: form.dashboardUrl || undefined,
                    qdrantUrl,
                    qdrantApiKey: form.qdrantMode === 'external' ? form.qdrantApiKey : undefined,
                    smtp: showSmtp ? {
                        host: form.smtpHost,
                        port: form.smtpPort,
                        user: form.smtpUser,
                        pass: form.smtpPass,
                        from: form.smtpFrom,
                    } : undefined,
                    // VAULT-INTEG P17: class-B instance basics — sent only
                    // when the admin actually filled them in, so an untouched
                    // field leaves the server's env-derived default alone.
                    appBaseUrl: form.appBaseUrl || undefined,
                    publicUrl: form.publicUrl || undefined,
                    collectorPublicUrl: form.collectorPublicUrl || undefined,
                    corsOrigins: form.corsOrigins || undefined,
                    cookieSecure: form.cookieSecure === '' ? undefined : form.cookieSecure === 'true',
                    matrixServerName: form.matrixServerName || undefined,
                }),
            })

            if (!res.ok) {
                const result = await res.json()
                throw new Error(result.message || 'Failed to save configuration')
            }

            onNext({
                infrastructure: {
                    ...form,
                    qdrantUrl
                }
            })
        } catch (err) {
            setError(err.message)
        } finally {
            setLoading(false)
        }
    }

    const getTestResultStyle = (result) => {
        if (!result) return {}
        if (result.status === 'success') return { color: '#22c55e' }
        return { color: '#ef4444' }
    }

    const radioStyle = {
        display: 'flex',
        gap: '1rem',
        marginBottom: '0.75rem'
    }

    const radioLabelStyle = {
        display: 'flex',
        alignItems: 'center',
        gap: '0.5rem',
        cursor: 'pointer',
        padding: '0.5rem 1rem',
        borderRadius: '6px',
        background: 'rgba(255,255,255,0.05)',
        border: '1px solid rgba(255,255,255,0.1)',
        transition: 'all 0.2s'
    }

    const radioLabelActiveStyle = {
        ...radioLabelStyle,
        background: 'rgba(34, 197, 94, 0.1)',
        borderColor: 'rgba(34, 197, 94, 0.4)'
    }

    const testButtonStyle = {
        padding: '0.5rem 1rem',
        background: 'rgba(255,255,255,0.1)',
        border: '1px solid rgba(255,255,255,0.2)',
        borderRadius: '6px',
        color: 'rgba(255,255,255,0.8)',
        cursor: 'pointer',
        minWidth: '120px',
        fontSize: '0.875rem'
    }

    return (
        <div className="setup-step">
            <h2>Infrastructure Settings</h2>
            <p>
                Configure the services that power QuoxCORE. Choose local Docker instances or connect to existing deployments.
            </p>

            <form className="setup-form" onSubmit={handleSubmit}>
                {/* Dashboard URL — for CORS auto-configuration */}
                <div className="form-group" style={{ marginBottom: '1.5rem' }}>
                    <label htmlFor="dashboardUrl" style={{ marginBottom: '0.5rem', display: 'block' }}>
                        Dashboard URL
                        <span style={{ fontSize: '0.75rem', opacity: 0.7, marginLeft: '0.5rem' }}>
                            (auto-detected from your browser)
                        </span>
                    </label>
                    <input
                        id="dashboardUrl"
                        type="url"
                        value={form.dashboardUrl}
                        onChange={handleChange('dashboardUrl')}
                        placeholder="https://192.168.1.100:3000"
                        style={{ width: '100%', marginBottom: '0.25rem' }}
                    />
                    <div style={{ fontSize: '0.75rem', opacity: 0.6, marginTop: '0.25rem' }}>
                        The URL where users access this dashboard. Used to configure CORS (cross-origin) security.
                    </div>
                </div>

                {/* Qdrant Configuration */}
                <div className="form-group" style={{ marginBottom: '1.5rem' }}>
                    <label style={{ marginBottom: '0.75rem', display: 'block' }}>
                        Qdrant Vector Database
                        <span style={{ fontSize: '0.75rem', opacity: 0.7, marginLeft: '0.5rem' }}>
                            (powers semantic memory search)
                        </span>
                    </label>

                    <div style={radioStyle}>
                        <label style={form.qdrantMode === 'local' ? radioLabelActiveStyle : radioLabelStyle}>
                            <input
                                type="radio"
                                name="qdrantMode"
                                value="local"
                                checked={form.qdrantMode === 'local'}
                                onChange={handleChange('qdrantMode')}
                            />
                            <span>Local (Docker)</span>
                        </label>
                        <label style={form.qdrantMode === 'external' ? radioLabelActiveStyle : radioLabelStyle}>
                            <input
                                type="radio"
                                name="qdrantMode"
                                value="external"
                                checked={form.qdrantMode === 'external'}
                                onChange={handleChange('qdrantMode')}
                            />
                            <span>External Instance</span>
                        </label>
                    </div>

                    {form.qdrantMode === 'local' ? (
                        <div className="info-box" style={{ marginTop: '0.5rem' }}>
                            Using local Qdrant at <code>http://localhost:6333</code>
                            <br />
                            <span style={{ fontSize: '0.8rem', opacity: 0.8 }}>
                                Start with: <code>docker compose up -d qdrant</code>
                            </span>
                        </div>
                    ) : (
                        <div style={{ marginTop: '0.5rem' }}>
                            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
                                <input
                                    id="qdrantUrl"
                                    type="url"
                                    value={form.qdrantUrl}
                                    onChange={handleChange('qdrantUrl')}
                                    placeholder="https://qdrant.example.com:6333"
                                    style={{ flex: 1 }}
                                />
                                <button
                                    type="button"
                                    onClick={testQdrantConnection}
                                    disabled={testingQdrant || !form.qdrantUrl}
                                    style={{
                                        ...testButtonStyle,
                                        opacity: form.qdrantUrl ? 1 : 0.5,
                                        cursor: form.qdrantUrl && !testingQdrant ? 'pointer' : 'not-allowed'
                                    }}
                                >
                                    {testingQdrant ? 'Testing...' : 'Test Connection'}
                                </button>
                            </div>

                            <div style={{ marginTop: '0.75rem' }}>
                                <label htmlFor="qdrantApiKey" style={{ fontSize: '0.875rem', opacity: 0.8, marginBottom: '0.25rem', display: 'block' }}>
                                    API Key (optional)
                                </label>
                                <input
                                    id="qdrantApiKey"
                                    type="password"
                                    value={form.qdrantApiKey}
                                    onChange={handleChange('qdrantApiKey')}
                                    placeholder="Qdrant API key (if authentication enabled)"
                                    style={{ width: '100%' }}
                                />
                            </div>

                            {qdrantTestResult && (
                                <div style={{ marginTop: '0.5rem', fontSize: '0.875rem', ...getTestResultStyle(qdrantTestResult) }}>
                                    {qdrantTestResult.status === 'success' ? '✓ ' : '✗ '}{qdrantTestResult.message}
                                </div>
                            )}
                            <span className="hint" style={{ marginTop: '0.5rem', display: 'block' }}>
                                URL of your existing Qdrant instance (Qdrant Cloud, self-hosted, etc.)
                            </span>
                        </div>
                    )}
                </div>

                {/* SSL Configuration */}
                {needsHttpsForVoice() && (
                    <div className="form-group" style={{
                        marginBottom: '1.5rem',
                        padding: '1rem',
                        background: 'rgba(251, 191, 36, 0.1)',
                        border: '1px solid rgba(251, 191, 36, 0.3)',
                        borderRadius: '8px'
                    }}>
                        <label style={{ marginBottom: '0.5rem', display: 'block', color: '#fbbf24' }}>
                            <strong>SSL Certificate Required for Voice</strong>
                        </label>
                        <p style={{ margin: '0 0 1rem', fontSize: '0.875rem', color: 'rgba(255,255,255,0.8)' }}>
                            You're accessing QuoxCORE via HTTP on a network IP. Voice input (microphone)
                            requires HTTPS to work in browsers.
                        </p>

                        {sslStatus?.hasCertificate ? (
                            <div style={{ padding: '0.75rem', background: 'rgba(34, 197, 94, 0.1)', borderRadius: '6px' }}>
                                <span style={{ color: '#22c55e' }}>✓ SSL certificate found</span>
                                {sslStatus.certInfo?.expiresAt && (
                                    <div style={{ fontSize: '0.8rem', opacity: 0.8, marginTop: '0.25rem' }}>
                                        Expires: {new Date(sslStatus.certInfo.expiresAt).toLocaleDateString()}
                                    </div>
                                )}
                                {sslStatus.httpsUrl && (
                                    <div style={{ fontSize: '0.875rem', marginTop: '0.5rem' }}>
                                        Access via: <a href={sslStatus.httpsUrl} style={{ color: '#60a5fa' }}>{sslStatus.httpsUrl}</a>
                                    </div>
                                )}
                            </div>
                        ) : (
                            <div>
                                <button
                                    type="button"
                                    onClick={generateSslCertificate}
                                    disabled={generatingSsl}
                                    style={{
                                        padding: '0.75rem 1.5rem',
                                        background: 'rgba(251, 191, 36, 0.2)',
                                        border: '1px solid rgba(251, 191, 36, 0.5)',
                                        borderRadius: '6px',
                                        color: '#fbbf24',
                                        cursor: generatingSsl ? 'wait' : 'pointer',
                                        fontWeight: 500,
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '0.5rem'
                                    }}
                                >
                                    {generatingSsl ? (
                                        <>
                                            <span className="setup-spinner" style={{ width: '16px', height: '16px' }} />
                                            Generating...
                                        </>
                                    ) : (
                                        <>
                                            <span>🔐</span>
                                            Generate Self-Signed Certificate
                                        </>
                                    )}
                                </button>

                                {sslResult && (
                                    <div style={{
                                        marginTop: '0.75rem',
                                        padding: '0.75rem',
                                        background: sslResult.status === 'success' ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                                        borderRadius: '6px',
                                        fontSize: '0.875rem'
                                    }}>
                                        {sslResult.status === 'success' ? (
                                            <div>
                                                <div style={{ color: '#22c55e', marginBottom: '0.5rem' }}>✓ {sslResult.message}</div>
                                                <div>Access via: <a href={sslResult.httpsUrl} style={{ color: '#60a5fa' }}>{sslResult.httpsUrl}</a></div>
                                                <div style={{ marginTop: '0.5rem', opacity: 0.8, fontSize: '0.8rem' }}>
                                                    Note: Your browser will show a security warning. Click "Advanced" → "Proceed" to continue.
                                                </div>
                                            </div>
                                        ) : (
                                            <div style={{ color: '#ef4444' }}>✗ {sslResult.message}</div>
                                        )}
                                    </div>
                                )}

                                <div style={{ marginTop: '0.75rem', fontSize: '0.8rem', opacity: 0.7 }}>
                                    Or run manually: <code>npm run generate-certs</code>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {/* SSL Configuration (collapsible when not required) */}
                {!needsHttpsForVoice() && (
                    <div style={{ marginTop: '1rem' }}>
                        <button
                            type="button"
                            className="btn btn-text"
                            onClick={() => setShowSsl(!showSsl)}
                        >
                            {showSsl ? '▼' : '▶'} SSL Configuration (Optional)
                        </button>

                        {showSsl && (
                            <div style={{
                                padding: '1rem',
                                background: 'rgba(0,0,0,0.2)',
                                borderRadius: '8px',
                                marginTop: '0.5rem'
                            }}>
                                {sslStatus?.hasCertificate ? (
                                    <div style={{ color: '#22c55e' }}>
                                        ✓ SSL certificate configured
                                        {sslStatus.httpsUrl && (
                                            <div style={{ fontSize: '0.875rem', marginTop: '0.25rem', color: 'rgba(255,255,255,0.7)' }}>
                                                HTTPS available at: {sslStatus.httpsUrl}
                                            </div>
                                        )}
                                    </div>
                                ) : (
                                    <div>
                                        <p style={{ margin: '0 0 0.75rem', fontSize: '0.875rem', opacity: 0.8 }}>
                                            Generate an SSL certificate if you need HTTPS access for voice features or remote access.
                                        </p>
                                        <button
                                            type="button"
                                            onClick={generateSslCertificate}
                                            disabled={generatingSsl}
                                            style={{
                                                padding: '0.5rem 1rem',
                                                background: 'rgba(255,255,255,0.1)',
                                                border: '1px solid rgba(255,255,255,0.2)',
                                                borderRadius: '6px',
                                                color: 'rgba(255,255,255,0.8)',
                                                cursor: generatingSsl ? 'wait' : 'pointer'
                                            }}
                                        >
                                            {generatingSsl ? 'Generating...' : 'Generate Certificate'}
                                        </button>

                                        {sslResult && (
                                            <div style={{
                                                marginTop: '0.5rem',
                                                fontSize: '0.875rem',
                                                color: sslResult.status === 'success' ? '#22c55e' : '#ef4444'
                                            }}>
                                                {sslResult.status === 'success' ? `✓ ${sslResult.message}` : `✗ ${sslResult.message}`}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                )}

                {/* SMTP Configuration (collapsible) */}
                <div style={{ marginTop: '1rem' }}>
                    <button
                        type="button"
                        className="btn btn-text"
                        onClick={() => setShowSmtp(!showSmtp)}
                    >
                        {showSmtp ? '▼' : '▶'} Email Configuration (Optional)
                    </button>
                </div>

                {showSmtp && (
                    <div style={{
                        padding: '1rem',
                        background: 'rgba(0,0,0,0.2)',
                        borderRadius: '8px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '1rem',
                        marginTop: '0.5rem'
                    }}>
                        <div className="form-group">
                            <label htmlFor="smtpHost">SMTP Host</label>
                            <input
                                id="smtpHost"
                                type="text"
                                value={form.smtpHost}
                                onChange={handleChange('smtpHost')}
                                placeholder="smtp.example.com"
                            />
                        </div>

                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                            <div className="form-group">
                                <label htmlFor="smtpPort">Port</label>
                                <input
                                    id="smtpPort"
                                    type="text"
                                    value={form.smtpPort}
                                    onChange={handleChange('smtpPort')}
                                    placeholder="587"
                                />
                            </div>
                            <div className="form-group">
                                <label htmlFor="smtpUser">Username</label>
                                <input
                                    id="smtpUser"
                                    type="text"
                                    value={form.smtpUser}
                                    onChange={handleChange('smtpUser')}
                                    placeholder="user@example.com"
                                />
                            </div>
                        </div>

                        <div className="form-group">
                            <label htmlFor="smtpPass">Password</label>
                            <input
                                id="smtpPass"
                                type="password"
                                value={form.smtpPass}
                                onChange={handleChange('smtpPass')}
                                placeholder="SMTP password"
                            />
                        </div>

                        <div className="form-group">
                            <label htmlFor="smtpFrom">From Address</label>
                            <input
                                id="smtpFrom"
                                type="email"
                                value={form.smtpFrom}
                                onChange={handleChange('smtpFrom')}
                                placeholder="noreply@example.com"
                            />
                        </div>

                        <div className="info-box">
                            Email is used for user invitations, password resets, and notifications.
                            You can configure this later in Settings.
                        </div>
                    </div>
                )}

                {/* Advanced instance basics (collapsible) — VAULT-INTEG P17 */}
                <div style={{ marginTop: '1rem' }}>
                    <button
                        type="button"
                        className="btn btn-text"
                        onClick={() => setShowAdvanced(!showAdvanced)}
                    >
                        {showAdvanced ? '▼' : '▶'} Advanced: Public URLs & CORS (Optional)
                    </button>
                </div>

                {showAdvanced && (
                    <div style={{
                        padding: '1rem',
                        background: 'rgba(0,0,0,0.2)',
                        borderRadius: '8px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '1rem',
                        marginTop: '0.5rem'
                    }}>
                        <div className="info-box">
                            Lets a cloud tenant configure its public address, CORS allowlist and Matrix
                            server name from the wizard instead of shell access. Leave any field blank
                            to keep its current default.
                        </div>

                        <div className="form-group">
                            <label htmlFor="appBaseUrl">App Base URL</label>
                            <input
                                id="appBaseUrl"
                                type="url"
                                value={form.appBaseUrl}
                                onChange={handleChange('appBaseUrl')}
                                placeholder="http://localhost:3000"
                            />
                            <span className="hint" style={{ marginTop: '0.25rem', display: 'block' }}>
                                Base URL used in email links (verification, invites, password reset).
                            </span>
                        </div>

                        <div className="form-group">
                            <label htmlFor="publicUrl">Public URL</label>
                            <input
                                id="publicUrl"
                                type="url"
                                value={form.publicUrl}
                                onChange={handleChange('publicUrl')}
                                placeholder="e.g. https://app.yourcompany.com"
                            />
                            <span className="hint" style={{ marginTop: '0.25rem', display: 'block' }}>
                                Public address of this instance, used in governance ticket links.
                            </span>
                        </div>

                        <div className="form-group">
                            <label htmlFor="collectorPublicUrl">Collector Public URL</label>
                            <input
                                id="collectorPublicUrl"
                                type="url"
                                value={form.collectorPublicUrl}
                                onChange={handleChange('collectorPublicUrl')}
                                placeholder="e.g. https://collector.yourcompany.com"
                            />
                            <span className="hint" style={{ marginTop: '0.25rem', display: 'block' }}>
                                Public address of the collector service, used by agents that cannot reach it via LAN.
                            </span>
                        </div>

                        <div className="form-group">
                            <label htmlFor="corsOrigins">CORS Allowlist</label>
                            <input
                                id="corsOrigins"
                                type="text"
                                value={form.corsOrigins}
                                onChange={handleChange('corsOrigins')}
                                placeholder="http://localhost:3000,http://localhost:5173,https://localhost:3443"
                            />
                            <span className="hint" style={{ marginTop: '0.25rem', display: 'block' }}>
                                Comma-separated list of additional origins allowed to call this instance's APIs.
                            </span>
                        </div>

                        <div className="form-group">
                            <label htmlFor="cookieSecure">Cookie / TLS Posture</label>
                            <select
                                id="cookieSecure"
                                value={form.cookieSecure}
                                onChange={handleChange('cookieSecure')}
                            >
                                <option value="">Auto (secure cookies in production)</option>
                                <option value="true">Force secure cookies (HTTPS required)</option>
                                <option value="false">Allow cookies over HTTP</option>
                            </select>
                            <span className="hint" style={{ marginTop: '0.25rem', display: 'block' }}>
                                Set this to "Allow cookies over HTTP" only if this instance sits behind a
                                reverse proxy terminating TLS without forwarding a secure connection.
                            </span>
                        </div>

                        <div className="form-group">
                            <label htmlFor="matrixServerName">Matrix Server Name</label>
                            <input
                                id="matrixServerName"
                                type="text"
                                value={form.matrixServerName}
                                onChange={handleChange('matrixServerName')}
                                placeholder="quox"
                            />
                            <span className="hint" style={{ marginTop: '0.25rem', display: 'block' }}>
                                Bare hostname used for this instance's Matrix identities (no scheme or path).
                            </span>
                        </div>
                    </div>
                )}

                {error && (
                    <div className="info-box warning">
                        {error}
                    </div>
                )}

                <div className="setup-actions">
                    <button type="button" className="btn btn-secondary" onClick={onBack}>
                        ← Back
                    </button>
                    <button type="submit" className="btn btn-primary" disabled={loading}>
                        {loading ? 'Saving...' : 'Continue →'}
                    </button>
                </div>
            </form>
        </div>
    )
}
