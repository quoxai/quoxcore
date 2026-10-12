/**
 * Verify Step - Comprehensive completion page with troubleshooting
 *
 * Shows:
 * - Verification results for all services
 * - Status of configured API keys
 * - HTTPS/SSL warnings if needed
 * - Common issues and solutions
 * - Quick start checklist
 * - Launch Dashboard button
 */

import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { normalizeLlmStatusPayload } from '../../../services/llmStatus'

// Check if HTTPS is needed for voice features
const needsHttpsForVoice = () => {
    const hostname = window.location.hostname
    const protocol = window.location.protocol
    if (hostname === 'localhost' || hostname === '127.0.0.1') return false
    if (protocol === 'https:') return false
    return true
}

export default function Verify({ data, onBack, onComplete }) {
    const [verifying, setVerifying] = useState(true)
    const [results, setResults] = useState([])
    const [ready, setReady] = useState(false)
    const [config, setConfig] = useState(null)
    const [chatStatus, setChatStatus] = useState(null)
    const [terminalHealth, setTerminalHealth] = useState(null)
    const [setupStatus, setSetupStatus] = useState(null)
    const [httpsWarning] = useState(needsHttpsForVoice())
    const navigate = useNavigate()
    const workflowCheck = results.find((check) => check.name === 'QuoxFlow Engine')
    const workflowsReady = workflowCheck?.status === 'pass'
    const tasksCheck = results.find((check) => check.name === 'Objectives Engine')
    const objectivesReady = tasksCheck?.status === 'pass'
    const webTerminalCheck = results.find((check) => check.name === 'Web Terminal')
    const webTerminalReady = webTerminalCheck?.status === 'pass'
    const quoxCliCheck = results.find((check) => check.name === 'Quox CLI')
    const quoxCliReady = quoxCliCheck?.status === 'pass'

    useEffect(() => {
        runVerification()
    }, [])

    const runVerification = async () => {
        const checks = []

        // Check auth service health
        try {
            const res = await fetch('/api/health')
            const json = await res.json()
            const isHealthy = res.ok || json.status === 'ok' || json.db === true
            checks.push({
                name: 'Auth Service',
                status: isHealthy ? 'pass' : 'warn',
                detail: isHealthy ? 'Healthy' : 'Service responding but check status',
            })
        } catch {
            checks.push({
                name: 'Auth Service',
                status: 'fail',
                detail: 'Not responding',
            })
        }

        // Check setup status
        try {
            const res = await fetch('/api/setup/status')
            const json = await res.json()
            setSetupStatus(json)
            checks.push({
                name: 'Admin Account',
                status: json.hasAdmin ? 'pass' : 'fail',
                detail: json.hasAdmin ? 'Created' : 'Not created',
            })
        } catch {
            checks.push({
                name: 'Admin Account',
                status: 'fail',
                detail: 'Could not verify',
            })
            setSetupStatus(null)
        }

        // Check config and get API key status
        try {
            const res = await fetch('/api/setup/config')
            const json = await res.json()
            setConfig(json.keys || {})
            const hasApiKey = json.keys?.hasAnthropicKey || json.keys?.hasOpenaiKey
            checks.push({
                name: 'Configuration',
                status: hasApiKey ? 'pass' : 'warn',
                detail: hasApiKey ? 'Direct chat provider configured' : 'No direct chat provider configured yet',
            })
        } catch {
            checks.push({
                name: 'Configuration',
                status: 'warn',
                detail: 'Could not verify',
            })
        }

        try {
            const res = await fetch('/collector/chat/status')
            if (res.ok) {
                const json = await res.json()
                setChatStatus(normalizeLlmStatusPayload(json))
            } else {
                setChatStatus(null)
            }
        } catch {
            setChatStatus(null)
        }

        try {
            const res = await fetch('/collector/terminal/health')
            if (res.ok) {
                const json = await res.json()
                setTerminalHealth(json)
                checks.push({
                    name: 'Web Terminal',
                    status: json?.web_terminal?.available ? 'pass' : 'warn',
                    detail: json?.web_terminal?.available
                        ? 'Ready'
                        : (json?.web_terminal?.recommendation || 'Terminal runtime unavailable'),
                })
                checks.push({
                    name: 'Quox CLI',
                    status: json?.quoxcli?.available ? 'pass' : 'warn',
                    detail: json?.quoxcli?.available
                        ? 'Ready'
                        : (json?.quoxcli?.recommendation || 'QuoxCLI runtime unavailable'),
                })
            } else {
                setTerminalHealth(null)
                checks.push({
                    name: 'Web Terminal',
                    status: 'warn',
                    detail: 'Could not verify terminal runtime',
                })
                checks.push({
                    name: 'Quox CLI',
                    status: 'warn',
                    detail: 'Could not verify QuoxCLI runtime',
                })
            }
        } catch {
            setTerminalHealth(null)
            checks.push({
                name: 'Web Terminal',
                status: 'warn',
                detail: 'Not available',
            })
            checks.push({
                name: 'Quox CLI',
                status: 'warn',
                detail: 'Not available',
            })
        }

        // Check Qdrant (use proxy to avoid CORS and handle API key)
        try {
            const controller = new AbortController()
            const timeoutId = setTimeout(() => controller.abort(), 3000)
            const res = await fetch('/qdrant/collections', { signal: controller.signal })
            clearTimeout(timeoutId)
            checks.push({
                name: 'Vector Database (Qdrant)',
                status: res.ok ? 'pass' : 'warn',
                detail: res.ok ? 'Running' : 'Not responding',
            })
        } catch {
            checks.push({
                name: 'Vector Database (Qdrant)',
                status: 'warn',
                detail: 'Not available',
            })
        }

        // Check QuoxFlow workflow engine
        try {
            const res = await fetch('/quoxflow/health', { signal: AbortSignal.timeout(3000) })
            if (res.ok) {
                const json = await res.json().catch(() => ({}))
                checks.push({
                    name: 'QuoxFlow Engine',
                    status: 'pass',
                    detail: json.version ? `Running (v${json.version})` : 'Running',
                })
            } else {
                checks.push({
                    name: 'QuoxFlow Engine',
                    status: 'warn',
                    detail: 'Not responding',
                })
            }
        } catch {
            checks.push({
                name: 'QuoxFlow Engine',
                status: 'warn',
                detail: 'Not available',
            })
        }

        // Check tasks/objectives service
        try {
            const res = await fetch('/tasks/health', { signal: AbortSignal.timeout(3000) })
            if (res.ok) {
                const json = await res.json().catch(() => ({}))
                checks.push({
                    name: 'Objectives Engine',
                    status: 'pass',
                    detail: json.status ? `Running (${json.status})` : 'Running',
                })
            } else {
                checks.push({
                    name: 'Objectives Engine',
                    status: 'warn',
                    detail: 'Not responding',
                })
            }
        } catch {
            checks.push({
                name: 'Objectives Engine',
                status: 'warn',
                detail: 'Not available',
            })
        }

        setResults(checks)
        setVerifying(false)

        // Ready if auth is healthy and admin exists
        const authOk = checks.find(c => c.name === 'Auth Service')?.status !== 'fail'
        const adminOk = checks.find(c => c.name === 'Admin Account')?.status === 'pass'
        setReady(authOk && adminOk)
    }

    const getIcon = (status) => {
        switch (status) {
            case 'pass': return '✓'
            case 'fail': return '✗'
            case 'warn': return '!'
            default: return '○'
        }
    }

    const handleLaunchDashboard = () => {
        onComplete()
        navigate('/')
    }

    const sectionStyle = {
        background: 'rgba(0,0,0,0.2)',
        borderRadius: '8px',
        padding: '1rem',
        marginBottom: '1rem'
    }

    const statusBoxStyle = (status) => ({
        padding: '0.75rem',
        borderRadius: '6px',
        marginBottom: '0.75rem',
        background: status === 'configured' ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)',
        borderLeft: `3px solid ${status === 'configured' ? '#22c55e' : '#ef4444'}`
    })

    const platformState = setupStatus?.readiness?.platformState || null
    const platformTone = platformState === 'full' ? '#22c55e' : platformState === 'core_only' ? '#fbbf24' : '#ef4444'
    const platformTitle =
        platformState === 'full'
            ? '✓ Full Platform Ready'
            : platformState === 'core_only'
                ? '⚠ Core Shell Ready, Full Platform Degraded'
                : '✗ Core Platform Needs Attention'
    const platformDescription =
        platformState === 'full'
            ? 'The core shell and the feature services behind workflows and objectives are all healthy.'
            : platformState === 'core_only'
                ? 'Basic setup and login can work, but one or more feature services are still missing. Expect workflow/objective features to be degraded.'
                : 'Core runtime services are still missing. The install is not healthy enough to treat as a working platform.'

    return (
        <div className="setup-step">
            <h2>🎉 QuoxCORE Installed Successfully!</h2>

            {verifying ? (
                <div style={{ textAlign: 'center', padding: '2rem' }}>
                    <div className="setup-spinner" style={{ width: '40px', height: '40px', margin: '0 auto 1rem' }} />
                    <p>Verifying your configuration...</p>
                </div>
            ) : (
                <>
                    {/* Platform readiness summary */}
                    {setupStatus?.readiness && (
                        <div style={{
                            ...sectionStyle,
                            borderLeft: `3px solid ${platformTone}`,
                            background: platformState === 'full'
                                ? 'rgba(34, 197, 94, 0.1)'
                                : platformState === 'core_only'
                                    ? 'rgba(251, 191, 36, 0.1)'
                                    : 'rgba(239, 68, 68, 0.1)'
                        }}>
                            <h3 style={{ margin: '0 0 0.5rem', fontSize: '1rem', color: platformTone }}>
                                {platformTitle}
                            </h3>
                            <p style={{ fontSize: '0.875rem', opacity: 0.9, marginBottom: '0.5rem' }}>
                                {platformDescription}
                            </p>
                            {Array.isArray(setupStatus.readiness.degradedFeatures) && setupStatus.readiness.degradedFeatures.length > 0 && (
                                <div style={{ fontSize: '0.84rem', opacity: 0.9 }}>
                                    Degraded features: {setupStatus.readiness.degradedFeatures.join(' • ')}
                                </div>
                            )}
                        </div>
                    )}

                    {/* Verification Results */}
                    <div style={sectionStyle}>
                        <h3 style={{ margin: '0 0 0.75rem', fontSize: '1rem' }}>System Status</h3>
                        {results.map((check, i) => (
                            <div key={i} className="check-item" style={{ padding: '0.5rem 0', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <span style={{
                                    color: check.status === 'pass' ? '#22c55e' : check.status === 'fail' ? '#ef4444' : '#fbbf24',
                                    fontWeight: 'bold'
                                }}>
                                    {getIcon(check.status)}
                                </span>
                                <span style={{ flex: 1 }}>{check.name}</span>
                                <span style={{
                                    fontSize: '0.875rem',
                                    color: check.status === 'fail' ? '#ef4444' : check.status === 'warn' ? '#fbbf24' : 'rgba(255,255,255,0.7)'
                                }}>
                                    {check.detail}
                                </span>
                            </div>
                        ))}
                    </div>

                    {/* Workflows Status */}
                    <div style={{
                        ...sectionStyle,
                        borderLeft: `3px solid ${workflowsReady ? '#22c55e' : '#fbbf24'}`,
                        background: workflowsReady ? 'rgba(34, 197, 94, 0.1)' : 'rgba(251, 191, 36, 0.1)'
                    }}>
                        <h3 style={{ margin: '0 0 0.5rem', fontSize: '1rem', color: workflowsReady ? '#22c55e' : '#fbbf24' }}>
                            {workflowsReady ? '✓ Workflows Ready' : '⚠ Workflow Engine Needs Attention'}
                        </h3>
                        <p style={{ fontSize: '0.875rem', opacity: 0.9 }}>
                            {workflowsReady
                                ? 'QuoxFlow workflow engine handles chat, voice, approvals, and automation workflows natively.'
                                : 'QuoxFlow is not available right now. Workflow Builder, approvals, policies, and automation will be degraded until the workflow engine is running.'}
                        </p>
                        {!workflowsReady && (
                            <div style={{ fontSize: '0.84rem', opacity: 0.88, marginTop: '0.5rem' }}>
                                Expected path: <code>/quoxflow/health</code> via the dashboard proxy, backed by QuoxFlow on port <code>3200</code>.
                            </div>
                        )}
                    </div>

                    {/* Objectives Status */}
                    <div style={{
                        ...sectionStyle,
                        borderLeft: `3px solid ${objectivesReady ? '#22c55e' : '#fbbf24'}`,
                        background: objectivesReady ? 'rgba(34, 197, 94, 0.1)' : 'rgba(251, 191, 36, 0.1)'
                    }}>
                        <h3 style={{ margin: '0 0 0.5rem', fontSize: '1rem', color: objectivesReady ? '#22c55e' : '#fbbf24' }}>
                            {objectivesReady ? '✓ Objectives Ready' : '⚠ Objectives Engine Needs Attention'}
                        </h3>
                        <p style={{ fontSize: '0.875rem', opacity: 0.9 }}>
                            {objectivesReady
                                ? 'The tasks service is running. Objectives, Mission Control, and Agentic Teams can execute and stream work.'
                                : 'The tasks service is not available right now. Objectives, Mission Control, and Agentic Teams will be degraded until the tasks engine is running.'}
                        </p>
                        {!objectivesReady && (
                            <div style={{ fontSize: '0.84rem', opacity: 0.88, marginTop: '0.5rem' }}>
                                Expected path: <code>/tasks/health</code> via the dashboard proxy, backed by the tasks service on port <code>3104</code>.
                            </div>
                        )}
                    </div>

                    {/* Terminal Runtime Status */}
                    <div style={{
                        ...sectionStyle,
                        borderLeft: `3px solid ${webTerminalReady && quoxCliReady ? '#22c55e' : '#fbbf24'}`,
                        background: webTerminalReady && quoxCliReady ? 'rgba(34, 197, 94, 0.1)' : 'rgba(251, 191, 36, 0.1)'
                    }}>
                        <h3 style={{ margin: '0 0 0.5rem', fontSize: '1rem', color: webTerminalReady && quoxCliReady ? '#22c55e' : '#fbbf24' }}>
                            {webTerminalReady && quoxCliReady ? '✓ Terminal Runtime Ready' : '⚠ Terminal Runtime Needs Attention'}
                        </h3>
                        <p style={{ fontSize: '0.875rem', opacity: 0.9 }}>
                            {webTerminalReady && quoxCliReady
                                ? 'Web Terminal and Quox CLI runtime are available. Terminal workflows and the browser CLI view should be usable on this deployment.'
                                : 'The collector terminal path is not fully ready yet. Terminal OAuth login or the Quox CLI page may be degraded until PTY support, Claude CLI, or the bundled cli/ dependencies are available.'}
                        </p>
                        {!webTerminalReady && (
                            <div style={{ fontSize: '0.84rem', opacity: 0.88, marginTop: '0.5rem' }}>
                                Web Terminal: {terminalHealth?.web_terminal?.recommendation || 'Verify /collector/terminal/health and the collector PTY runtime.'}
                            </div>
                        )}
                        {!quoxCliReady && (
                            <div style={{ fontSize: '0.84rem', opacity: 0.88, marginTop: '0.35rem' }}>
                                Quox CLI: {terminalHealth?.quoxcli?.recommendation || 'Install the bundled cli/ dependencies and verify /collector/terminal/health.'}
                            </div>
                        )}
                    </div>

                    {/* Before You Start Section */}
                    <div style={{ ...sectionStyle, borderLeft: '3px solid #fbbf24' }}>
                        <h3 style={{ margin: '0 0 0.75rem', fontSize: '1rem', color: '#fbbf24' }}>Before You Start Chatting</h3>

                        {/* Direct chat readiness */}
                        <div style={statusBoxStyle((chatStatus?.ready || config?.hasAnthropicKey || config?.hasOpenaiKey) ? 'configured' : 'missing')}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                                <span>🤖</span>
                                <strong>AI Chat Provider</strong>
                                <span style={{
                                    marginLeft: 'auto',
                                    fontSize: '0.75rem',
                                    color: (chatStatus?.ready || config?.hasAnthropicKey || config?.hasOpenaiKey) ? '#22c55e' : '#ef4444'
                                }}>
                                    {(chatStatus?.ready || config?.hasAnthropicKey || config?.hasOpenaiKey) ? '✓ Ready' : '✗ Not configured'}
                                </span>
                            </div>
                            {chatStatus?.authMethod && (
                                <div style={{ fontSize: '0.8rem', opacity: 0.85, marginTop: '0.35rem' }}>
                                    Active path: <strong>{String(chatStatus.authMethod).replaceAll('_', ' ')}</strong>
                                </div>
                            )}
                            {!(chatStatus?.ready || config?.hasAnthropicKey || config?.hasOpenaiKey) && (
                                <div style={{ fontSize: '0.875rem', opacity: 0.9, marginTop: '0.5rem' }}>
                                    <div style={{ color: '#fbbf24', marginBottom: '0.25rem' }}>Add an OpenAI or Anthropic API key to enable direct AI chat, or use Claude terminal OAuth if that path is available on this deployment.</div>
                                    <div>
                                        → OpenAI: <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" style={{ color: '#60a5fa' }}>platform.openai.com</a>
                                        <br />
                                        → Anthropic: <a href="https://console.anthropic.com/" target="_blank" rel="noopener noreferrer" style={{ color: '#60a5fa' }}>console.anthropic.com</a>
                                        <br />
                                        → Then: <strong>Settings → Core Integrations</strong>
                                    </div>
                                </div>
                            )}
                            {chatStatus?.recommendation && (
                                <div style={{ fontSize: '0.84rem', opacity: 0.85, marginTop: '0.5rem' }}>
                                    {chatStatus.recommendation}
                                </div>
                            )}
                        </div>

                        {/* Voice Output Status */}
                        <div style={statusBoxStyle(config?.hasElevenlabsKey ? 'configured' : 'missing')}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                                <span>🎤</span>
                                <strong>Voice Output (Recommended)</strong>
                                <span style={{
                                    marginLeft: 'auto',
                                    fontSize: '0.75rem',
                                    color: config?.hasElevenlabsKey ? '#22c55e' : '#fbbf24'
                                }}>
                                    {config?.hasElevenlabsKey ? '✓ Configured' : '○ Not configured'}
                                </span>
                            </div>
                            {!config?.hasElevenlabsKey && (
                                <div style={{ fontSize: '0.875rem', opacity: 0.9, marginTop: '0.5rem' }}>
                                    <div style={{ opacity: 0.8, marginBottom: '0.25rem' }}>Agents cannot speak without ElevenLabs.</div>
                                    <div>
                                        → Get your API key: <a href="https://elevenlabs.io/app/settings/api-keys" target="_blank" rel="noopener noreferrer" style={{ color: '#60a5fa' }}>elevenlabs.io</a>
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* HTTPS Status */}
                        {httpsWarning && (
                            <div style={{
                                ...statusBoxStyle('missing'),
                                background: 'rgba(251, 191, 36, 0.1)',
                                borderLeftColor: '#fbbf24'
                            }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                                    <span>🔐</span>
                                    <strong>HTTPS/SSL (Required for voice input)</strong>
                                    <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: '#fbbf24' }}>
                                        ⚠️ Running on HTTP
                                    </span>
                                </div>
                                <div style={{ fontSize: '0.875rem', opacity: 0.9, marginTop: '0.5rem' }}>
                                    <div style={{ marginBottom: '0.25rem' }}>
                                        Microphone access requires HTTPS when not on localhost.
                                        <br />
                                        You're accessing via: <code>{window.location.protocol}//{window.location.host}</code>
                                    </div>
                                    <div>
                                        → Generate a certificate: <code>npm run generate-certs</code>
                                        <br />
                                        → Then access via HTTPS and accept the browser warning
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Memory Search Status */}
                        <div style={statusBoxStyle(config?.hasOpenaiKey ? 'configured' : 'missing')}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                                <span>🧠</span>
                                <strong>Memory Search (Recommended)</strong>
                                <span style={{
                                    marginLeft: 'auto',
                                    fontSize: '0.75rem',
                                    color: config?.hasOpenaiKey ? '#22c55e' : '#fbbf24'
                                }}>
                                    {config?.hasOpenaiKey ? '✓ Configured' : '○ Not configured'}
                                </span>
                            </div>
                            {!config?.hasOpenaiKey && (
                                <div style={{ fontSize: '0.875rem', opacity: 0.9, marginTop: '0.5rem' }}>
                                    <div style={{ opacity: 0.8, marginBottom: '0.25rem' }}>OpenAI enables GPT-backed chat, planning, coding, and semantic memory search.</div>
                                    <div>
                                        → Get your API key: <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" style={{ color: '#60a5fa' }}>platform.openai.com</a>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Quick Start Checklist */}
                    <div style={sectionStyle}>
                        <h3 style={{ margin: '0 0 0.75rem', fontSize: '1rem' }}>Quick Start Checklist</h3>
                        <div style={{ fontSize: '0.875rem' }}>
                            <div style={{ padding: '0.25rem 0', display: 'flex', gap: '0.5rem' }}>
                                <span style={{ color: config?.hasAnthropicKey ? '#22c55e' : '#ef4444' }}>
                                    {(chatStatus?.ready || config?.hasAnthropicKey || config?.hasOpenaiKey) ? '☑' : '☐'}
                                </span>
                                Configure at least one direct AI chat provider
                            </div>
                            <div style={{ padding: '0.25rem 0', display: 'flex', gap: '0.5rem' }}>
                                <span style={{ color: config?.hasElevenlabsKey ? '#22c55e' : 'rgba(255,255,255,0.5)' }}>
                                    {config?.hasElevenlabsKey ? '☑' : '☐'}
                                </span>
                                Add ElevenLabs API key (for voice responses)
                            </div>
                            {httpsWarning && (
                                <div style={{ padding: '0.25rem 0', display: 'flex', gap: '0.5rem' }}>
                                    <span style={{ color: 'rgba(255,255,255,0.5)' }}>☐</span>
                                    Enable HTTPS for voice input on network
                                </div>
                            )}
                            <div style={{ padding: '0.25rem 0', display: 'flex', gap: '0.5rem' }}>
                                <span style={{ color: config?.hasOpenaiKey ? '#22c55e' : 'rgba(255,255,255,0.5)' }}>
                                    {config?.hasOpenaiKey ? '☑' : '☐'}
                                </span>
                                Add OpenAI API key (GPT chat and memory search)
                            </div>
                            <div style={{ padding: '0.25rem 0', display: 'flex', gap: '0.5rem' }}>
                                <span style={{ color: objectivesReady ? '#22c55e' : 'rgba(255,255,255,0.5)' }}>
                                    {objectivesReady ? '☑' : '☐'}
                                </span>
                                Confirm the tasks service is running for Objectives and Mission Control
                            </div>
                            <div style={{ padding: '0.25rem 0', display: 'flex', gap: '0.5rem' }}>
                                <span style={{ color: workflowsReady ? '#22c55e' : 'rgba(255,255,255,0.5)' }}>
                                    {workflowsReady ? '☑' : '☐'}
                                </span>
                                Confirm QuoxFlow is running for Workflows, approvals, and policies
                            </div>
                            <div style={{ padding: '0.25rem 0', display: 'flex', gap: '0.5rem' }}>
                                <span style={{ color: webTerminalReady && quoxCliReady ? '#22c55e' : 'rgba(255,255,255,0.5)' }}>
                                    {webTerminalReady && quoxCliReady ? '☑' : '☐'}
                                </span>
                                Confirm Web Terminal and Quox CLI runtime are available
                            </div>
                        </div>
                    </div>

                    {/* Common Issues */}
                    <div style={sectionStyle}>
                        <h3 style={{ margin: '0 0 0.75rem', fontSize: '1rem' }}>Common Issues</h3>
                        <div style={{ fontSize: '0.875rem' }}>
                            <div style={{ marginBottom: '0.75rem' }}>
                                <strong>"Agent doesn't respond"</strong>
                                <div style={{ opacity: 0.8, paddingLeft: '1rem' }}>
                                    → Check a direct AI provider is configured in Settings → Core Integrations
                                    <br />
                                    → If using Claude terminal auth, verify the collector terminal path is healthy
                                </div>
                            </div>
                            <div style={{ marginBottom: '0.75rem' }}>
                                <strong>"Voice button doesn't work"</strong>
                                <div style={{ opacity: 0.8, paddingLeft: '1rem' }}>
                                    → Microphone needs HTTPS (see above)
                                    <br />
                                    → Check browser permissions for microphone
                                </div>
                            </div>
                            <div style={{ marginBottom: '0.75rem' }}>
                                <strong>"Agent doesn't speak"</strong>
                                <div style={{ opacity: 0.8, paddingLeft: '1rem' }}>
                                    → Add ElevenLabs API key in Settings → Core Integrations
                                </div>
                            </div>
                            <div>
                                <strong>"Memory search returns nothing"</strong>
                                <div style={{ opacity: 0.8, paddingLeft: '1rem' }}>
                                    → Add OpenAI API key for semantic search
                                    <br />
                                    → Ensure Qdrant is running
                                </div>
                            </div>
                            <div style={{ marginTop: '0.75rem' }}>
                                <strong>"Objectives or Mission Control are blank/broken"</strong>
                                <div style={{ opacity: 0.8, paddingLeft: '1rem' }}>
                                    → Ensure the tasks service is running and reachable through <code>/tasks/health</code>
                                    <br />
                                    → A missing tasks service often shows up as HTML/JSON parse errors in objective views
                                </div>
                            </div>
                            <div style={{ marginTop: '0.75rem' }}>
                                <strong>"Workflow Builder or approvals do nothing"</strong>
                                <div style={{ opacity: 0.8, paddingLeft: '1rem' }}>
                                    → Ensure QuoxFlow is running and reachable through <code>/quoxflow/health</code>
                                    <br />
                                    → Policies, approvals, and automation depend on QuoxFlow
                                </div>
                            </div>
                            <div style={{ marginTop: '0.75rem' }}>
                                <strong>"Terminal or Quox CLI page is broken"</strong>
                                <div style={{ opacity: 0.8, paddingLeft: '1rem' }}>
                                    → Check <code>/collector/terminal/health</code> in Verify
                                    <br />
                                    → Ensure PTY support is available, Claude CLI is installed if you expect terminal OAuth, and <code>cli/node_modules</code> exists for the browser CLI view
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Infrastructure Management Section */}
                    <div style={sectionStyle}>
                        <h3 style={{ margin: '0 0 0.75rem', fontSize: '1rem' }}>Managing Remote Infrastructure</h3>
                        <p style={{ fontSize: '0.875rem', opacity: 0.8, marginBottom: '0.75rem' }}>
                            QuoxCORE can manage servers across your infrastructure using two additional components:
                        </p>

                        <div style={{ marginBottom: '0.75rem', paddingLeft: '1rem', borderLeft: '2px solid rgba(255,255,255,0.2)' }}>
                            <strong>QuoxBastion</strong> <span style={{ fontSize: '0.75rem', opacity: 0.7 }}>(SSH Jump Host)</span>
                            <div style={{ fontSize: '0.875rem', opacity: 0.8, marginTop: '0.25rem' }}>
                                A bastion host that holds SSH keys to your managed servers. Required for QuoxCORE to execute commands on remote hosts.
                            </div>
                        </div>

                        <div style={{ paddingLeft: '1rem', borderLeft: '2px solid rgba(255,255,255,0.2)' }}>
                            <strong>QuoxAgent</strong> <span style={{ fontSize: '0.75rem', opacity: 0.7 }}>(Host Agent)</span>
                            <div style={{ fontSize: '0.875rem', opacity: 0.8, marginTop: '0.25rem' }}>
                                A lightweight agent installed on each managed host. Enables QuoxCORE orchestration and monitoring.
                            </div>
                        </div>

                        <div style={{ marginTop: '1rem', fontSize: '0.875rem' }}>
                            <strong>Setup Order:</strong>
                            <ol style={{ margin: '0.5rem 0 0', paddingLeft: '1.25rem', opacity: 0.8 }}>
                                <li>Configure QuoxBastion with SSH access to your hosts</li>
                                <li>Install QuoxAgent on each managed host</li>
                                <li>Register hosts in QuoxCORE Dashboard → Fleet</li>
                            </ol>
                        </div>

                        <div style={{ marginTop: '0.75rem' }}>
                            <a href="https://github.com/quoxai/quox/blob/main/docs/QuoxAgent.md" target="_blank" rel="noopener noreferrer" style={{ color: '#60a5fa', fontSize: '0.875rem' }}>
                                Read the QuoxAgent deployment guide →
                            </a>
                        </div>
                    </div>

                    {/* Migration Guide Link */}
                    <div style={{ padding: '0.75rem', background: 'rgba(255,255,255,0.05)', borderRadius: '6px', fontSize: '0.875rem' }}>
                        <strong>Migrating from another instance?</strong>
                        <br />
                        See the <a href="https://github.com/quoxai/quox/blob/main/docs/MIGRATION.md" target="_blank" rel="noopener noreferrer" style={{ color: '#60a5fa' }}>Migration Guide</a> for backup/restore and data transfer instructions.
                    </div>
                </>
            )}

            <div className="setup-actions" style={{ marginTop: '1.5rem' }}>
                <button type="button" className="btn btn-secondary" onClick={onBack}>
                    ← Back
                </button>
                <div style={{ display: 'flex', gap: '0.75rem' }}>
                    <a
                        href="https://github.com/quoxai/quox/tree/main/docs"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn btn-secondary"
                        style={{ textDecoration: 'none' }}
                    >
                        📖 Documentation
                    </a>
                    <button
                        className="btn btn-primary"
                        onClick={handleLaunchDashboard}
                        disabled={verifying || !ready}
                        style={{ minWidth: '160px' }}
                    >
                        {verifying ? 'Verifying...' : '🚀 Launch Dashboard'}
                    </button>
                </div>
            </div>
        </div>
    )
}
