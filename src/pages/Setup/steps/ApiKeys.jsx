/**
 * API Keys Step - Connect AI services for QuoxCORE functionality
 *
 * Presents API keys in order of immediate usefulness:
 * 1. OpenAI or Anthropic (recommended for direct AI chat)
 * 2. ElevenLabs (recommended for voice output)
 * 3. Additional providers can be configured later in Settings
 */

import { useState } from 'react'

export default function ApiKeys({ data, onNext, onBack }) {
    const [form, setForm] = useState({
        anthropicKey: data.apiKeys?.anthropicKey || '',
        openaiKey: data.apiKeys?.openaiKey || '',
        elevenlabsKey: data.apiKeys?.elevenlabsKey || '',
    })
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState(null)
    const [testResults, setTestResults] = useState({})
    const [testing, setTesting] = useState({})

    const validateKey = (key, prefix) => {
        if (!key) return null
        if (key.startsWith(prefix)) return 'valid'
        return 'invalid'
    }

    const handleChange = (field) => (e) => {
        setForm({ ...form, [field]: e.target.value })
        setTestResults({ ...testResults, [field]: null })
    }

    const testApiKey = async (keyType) => {
        const keyMap = {
            anthropic: { key: form.anthropicKey, prefix: 'sk-ant-' },
            openai: { key: form.openaiKey, prefix: 'sk-' },
            elevenlabs: { key: form.elevenlabsKey, prefix: '' }
        }

        const { key, prefix } = keyMap[keyType]

        if (!key) {
            setTestResults({ ...testResults, [keyType]: { status: 'error', message: 'No key entered' } })
            return
        }

        if (prefix && !key.startsWith(prefix)) {
            setTestResults({ ...testResults, [keyType]: { status: 'error', message: 'Invalid key format' } })
            return
        }

        setTesting({ ...testing, [keyType]: true })

        try {
            if (keyType === 'anthropic') {
                const res = await fetch('https://api.anthropic.com/v1/messages', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': key,
                        'anthropic-version': '2023-06-01'
                    },
                    body: JSON.stringify({
                        model: 'claude-3-haiku-20240307',
                        max_tokens: 1,
                        messages: [{ role: 'user', content: 'Hi' }]
                    })
                })

                if (res.ok || res.status === 400) {
                    setTestResults({ ...testResults, [keyType]: { status: 'success', message: 'Key is valid' } })
                } else if (res.status === 401) {
                    setTestResults({ ...testResults, [keyType]: { status: 'error', message: 'Invalid or expired key' } })
                } else {
                    setTestResults({ ...testResults, [keyType]: { status: 'warning', message: 'Could not verify (API error)' } })
                }
            } else if (keyType === 'openai') {
                const res = await fetch('https://api.openai.com/v1/models', {
                    headers: { 'Authorization': `Bearer ${key}` }
                })

                if (res.ok) {
                    setTestResults({ ...testResults, [keyType]: { status: 'success', message: 'Key is valid' } })
                } else if (res.status === 401) {
                    setTestResults({ ...testResults, [keyType]: { status: 'error', message: 'Invalid or expired key' } })
                } else {
                    setTestResults({ ...testResults, [keyType]: { status: 'warning', message: 'Could not verify (API error)' } })
                }
            } else if (keyType === 'elevenlabs') {
                const res = await fetch('https://api.elevenlabs.io/v1/user', {
                    headers: { 'xi-api-key': key }
                })

                if (res.ok) {
                    setTestResults({ ...testResults, [keyType]: { status: 'success', message: 'Key is valid' } })
                } else if (res.status === 401) {
                    setTestResults({ ...testResults, [keyType]: { status: 'error', message: 'Invalid or expired key' } })
                } else {
                    setTestResults({ ...testResults, [keyType]: { status: 'warning', message: 'Could not verify (API error)' } })
                }
            }
        } catch (err) {
            setTestResults({ ...testResults, [keyType]: { status: 'warning', message: 'Format valid (cannot verify remotely)' } })
        } finally {
            setTesting({ ...testing, [keyType]: false })
        }
    }

    const handleSubmit = async (e) => {
        e.preventDefault()
        await saveAndContinue()
    }

    const handleSkip = async () => {
        // More detailed confirmation when skipping without a direct chat-capable key
        const hasDirectChatProvider = !!form.anthropicKey || !!form.openaiKey

        const message = hasDirectChatProvider
            ? 'Continue without additional API keys?\n\n' +
              '• Voice output will be text-only (no ElevenLabs)\n' +
              '• Some providers and routing options will remain unavailable until you add more keys\n\n' +
              'You can add these keys later in Settings → Core Integrations.'
            : '⚠️ You haven\'t added a direct chat-capable API key.\n\n' +
              'This means:\n' +
              '• Direct API chat will not work yet\n' +
              '• You will need either an OpenAI or Anthropic API key, or Claude terminal authentication later\n' +
              '• Most AI features will remain unavailable until a provider is configured\n\n' +
              'You can add the key later in Settings → Core Integrations.\n\n' +
              'Continue without AI capabilities?'

        if (!window.confirm(message)) {
            return
        }

        await saveAndContinue(true)
    }

    const saveAndContinue = async (isSkip = false) => {
        setError(null)
        setLoading(true)

        try {
            const res = await fetch('/api/setup/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    anthropicKey: form.anthropicKey || undefined,
                    openaiKey: form.openaiKey || undefined,
                    elevenlabsKey: form.elevenlabsKey || undefined,
                }),
            })

            if (!res.ok) {
                const result = await res.json()
                throw new Error(result.message || 'Failed to save configuration')
            }

            onNext({ apiKeys: form })
        } catch (err) {
            setError(err.message)
        } finally {
            setLoading(false)
        }
    }

    const getTestResultStyle = (result) => {
        if (!result) return {}
        if (result.status === 'success') return { color: '#22c55e' }
        if (result.status === 'error') return { color: '#ef4444' }
        return { color: '#fbbf24' }
    }

    const hasAnthropic = !!form.anthropicKey
    const hasOpenAI = !!form.openaiKey
    const hasDirectChatProvider = hasAnthropic || hasOpenAI
    const anthropicStatus = validateKey(form.anthropicKey, 'sk-ant-')
    const openaiStatus = validateKey(form.openaiKey, 'sk-')

    const inputGroupStyle = {
        marginBottom: '1.5rem',
        padding: '1rem',
        background: 'rgba(0,0,0,0.2)',
        borderRadius: '8px'
    }

    const inputRowStyle = {
        display: 'flex',
        gap: '0.5rem',
        marginTop: '0.5rem'
    }

    const testButtonStyle = {
        padding: '0.5rem 1rem',
        background: 'rgba(255,255,255,0.1)',
        border: '1px solid rgba(255,255,255,0.2)',
        borderRadius: '6px',
        color: 'rgba(255,255,255,0.8)',
        cursor: 'pointer',
        minWidth: '70px',
        fontSize: '0.875rem'
    }

    const linkStyle = {
        color: '#60a5fa',
        textDecoration: 'none',
        fontSize: '0.875rem'
    }

    return (
        <div className="setup-step">
            <h2>Connect Your AI Services</h2>
            <p>
                Configure API keys to enable AI capabilities. QuoxCORE can use direct provider APIs or Claude CLI OAuth when that path is available on the deployment.
                OpenAI and Anthropic are the main direct chat providers. Additional providers can be configured later in Core Integrations.
            </p>

            <form className="setup-form" onSubmit={handleSubmit}>
                {/* REQUIRED SECTION */}
                <div style={{
                    borderLeft: '3px solid #ef4444',
                    paddingLeft: '1rem',
                    marginBottom: '1.5rem'
                }}>
                    <div style={{ fontSize: '0.75rem', fontWeight: 600, color: '#ef4444', marginBottom: '0.5rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        Recommended for Direct AI Chat
                    </div>

                    <div style={inputGroupStyle}>
                        <label style={{ display: 'block', marginBottom: '0.25rem', fontWeight: 500 }}>
                            <span style={{ marginRight: '0.5rem' }}>🤖</span>
                            Anthropic API Key
                        </label>
                        <p style={{ margin: '0 0 0.75rem', fontSize: '0.875rem', opacity: 0.8 }}>
                            Enables direct Anthropic/Claude API access.
                            <br />
                            <span style={{ color: '#fbbf24' }}>Use this if you want Anthropic-backed chat without relying on Claude terminal OAuth.</span>
                        </p>

                        <div style={inputRowStyle}>
                            <input
                                type="password"
                                value={form.anthropicKey}
                                onChange={handleChange('anthropicKey')}
                                placeholder="sk-ant-api03-..."
                                autoComplete="off"
                                style={{ flex: 1 }}
                            />
                            <button
                                type="button"
                                onClick={() => testApiKey('anthropic')}
                                disabled={!form.anthropicKey || testing.anthropic}
                                style={{
                                    ...testButtonStyle,
                                    opacity: form.anthropicKey ? 1 : 0.5,
                                    cursor: form.anthropicKey && !testing.anthropic ? 'pointer' : 'not-allowed'
                                }}
                            >
                                {testing.anthropic ? '...' : 'Test'}
                            </button>
                        </div>

                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.5rem' }}>
                            <span style={{ fontSize: '0.875rem' }}>
                                Don't have one?{' '}
                                <a href="https://console.anthropic.com/" target="_blank" rel="noopener noreferrer" style={linkStyle}>
                                    Get API Key →
                                </a>
                            </span>
                            {testResults.anthropic && (
                                <span style={{ fontSize: '0.75rem', ...getTestResultStyle(testResults.anthropic) }}>
                                    {testResults.anthropic.status === 'success' ? '✓ ' : testResults.anthropic.status === 'error' ? '✗ ' : '! '}
                                    {testResults.anthropic.message}
                                </span>
                            )}
                            {!testResults.anthropic && anthropicStatus && (
                                <span style={{ fontSize: '0.75rem', color: anthropicStatus === 'valid' ? '#22c55e' : '#ef4444' }}>
                                    {anthropicStatus === 'valid' ? '✓ Valid format' : '✗ Invalid format'}
                                </span>
                            )}
                        </div>

                        {/* Claude Pro/Team subscription tip */}
                        <div style={{
                            marginTop: '0.75rem',
                            padding: '0.75rem',
                            background: 'rgba(96, 165, 250, 0.1)',
                            border: '1px solid rgba(96, 165, 250, 0.25)',
                            borderRadius: '6px',
                            fontSize: '0.8rem'
                        }}>
                            <strong style={{ color: '#60a5fa' }}>💡 Have Claude Pro or Team?</strong>
                            <p style={{ margin: '0.5rem 0 0', opacity: 0.9, lineHeight: 1.5 }}>
                                You can use your subscription instead of paying for API credits.
                                Run <code style={{ background: 'rgba(0,0,0,0.3)', padding: '0.15rem 0.4rem', borderRadius: '3px' }}>claude login</code> on
                                the server to authenticate with your subscription. This is optional, deployment-dependent, and can be set up later in Core Integrations.
                            </p>
                        </div>
                    </div>
                </div>

                {/* RECOMMENDED SECTION */}
                <div style={{
                    borderLeft: '3px solid #fbbf24',
                    paddingLeft: '1rem',
                    marginBottom: '1.5rem'
                }}>
                    <div style={{ fontSize: '0.75rem', fontWeight: 600, color: '#fbbf24', marginBottom: '0.5rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        Recommended
                    </div>

                    {/* ElevenLabs */}
                    <div style={inputGroupStyle}>
                        <label style={{ display: 'block', marginBottom: '0.25rem', fontWeight: 500 }}>
                            <span style={{ marginRight: '0.5rem' }}>🎤</span>
                            ElevenLabs API Key
                        </label>
                        <p style={{ margin: '0 0 0.75rem', fontSize: '0.875rem', opacity: 0.8 }}>
                            Enables voice responses from agents.
                            <br />
                            <span style={{ opacity: 0.7 }}>Without this: Agents will respond with text only.</span>
                        </p>

                        <div style={inputRowStyle}>
                            <input
                                type="password"
                                value={form.elevenlabsKey}
                                onChange={handleChange('elevenlabsKey')}
                                placeholder="ElevenLabs API key"
                                autoComplete="off"
                                style={{ flex: 1 }}
                            />
                            <button
                                type="button"
                                onClick={() => testApiKey('elevenlabs')}
                                disabled={!form.elevenlabsKey || testing.elevenlabs}
                                style={{
                                    ...testButtonStyle,
                                    opacity: form.elevenlabsKey ? 1 : 0.5,
                                    cursor: form.elevenlabsKey && !testing.elevenlabs ? 'pointer' : 'not-allowed'
                                }}
                            >
                                {testing.elevenlabs ? '...' : 'Test'}
                            </button>
                        </div>

                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.5rem' }}>
                            <a href="https://elevenlabs.io/app/settings/api-keys" target="_blank" rel="noopener noreferrer" style={linkStyle}>
                                Get API Key →
                            </a>
                            {testResults.elevenlabs && (
                                <span style={{ fontSize: '0.75rem', ...getTestResultStyle(testResults.elevenlabs) }}>
                                    {testResults.elevenlabs.status === 'success' ? '✓ ' : testResults.elevenlabs.status === 'error' ? '✗ ' : '! '}
                                    {testResults.elevenlabs.message}
                                </span>
                            )}
                        </div>
                    </div>

                    {/* OpenAI */}
                    <div style={inputGroupStyle}>
                        <label style={{ display: 'block', marginBottom: '0.25rem', fontWeight: 500 }}>
                            <span style={{ marginRight: '0.5rem' }}>🧠</span>
                            OpenAI API Key
                        </label>
                        <p style={{ margin: '0 0 0.75rem', fontSize: '0.875rem', opacity: 0.8 }}>
                            Enables GPT chat, planning, coding, semantic search, memory embeddings, and OpenAI-backed routing options. Semantic search also powers Qortex's embedding index, which starts automatically once a key is added.
                            <br />
                            <span style={{ opacity: 0.7 }}>Without this: GPT-backed chat, routing, and semantic search remain unavailable via OpenAI directly; semantic search still falls back to keyword-only mode, or a connected Gemini key.</span>
                        </p>

                        <div style={inputRowStyle}>
                            <input
                                type="password"
                                value={form.openaiKey}
                                onChange={handleChange('openaiKey')}
                                placeholder="sk-..."
                                autoComplete="off"
                                style={{ flex: 1 }}
                            />
                            <button
                                type="button"
                                onClick={() => testApiKey('openai')}
                                disabled={!form.openaiKey || testing.openai}
                                style={{
                                    ...testButtonStyle,
                                    opacity: form.openaiKey ? 1 : 0.5,
                                    cursor: form.openaiKey && !testing.openai ? 'pointer' : 'not-allowed'
                                }}
                            >
                                {testing.openai ? '...' : 'Test'}
                            </button>
                        </div>

                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.5rem' }}>
                            <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" style={linkStyle}>
                                Get API Key →
                            </a>
                            {testResults.openai && (
                                <span style={{ fontSize: '0.75rem', ...getTestResultStyle(testResults.openai) }}>
                                    {testResults.openai.status === 'success' ? '✓ ' : testResults.openai.status === 'error' ? '✗ ' : '! '}
                                    {testResults.openai.message}
                                </span>
                            )}
                            {!testResults.openai && openaiStatus && (
                                <span style={{ fontSize: '0.75rem', color: openaiStatus === 'valid' ? '#22c55e' : '#ef4444' }}>
                                    {openaiStatus === 'valid' ? '✓ Valid format' : '✗ Invalid format'}
                                </span>
                            )}
                        </div>
                    </div>
                </div>

                {error && (
                    <div className="info-box warning">
                        {error}
                    </div>
                )}

                <div className="setup-actions">
                    <button type="button" className="btn btn-secondary" onClick={onBack}>
                        ← Back
                    </button>
                    <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                        <button
                            type="button"
                            className="btn btn-ghost"
                            onClick={handleSkip}
                            disabled={loading}
                            style={{ color: hasDirectChatProvider ? '#fbbf24' : '#ef4444', fontSize: '0.875rem' }}
                        >
                            {hasDirectChatProvider ? 'Skip additional keys' : 'Skip (Not Recommended)'}
                        </button>
                        <button type="submit" className="btn btn-primary" disabled={loading}>
                            {loading ? 'Saving...' : 'Continue →'}
                        </button>
                    </div>
                </div>

                {!hasDirectChatProvider && (
                    <div style={{
                        marginTop: '1rem',
                        padding: '0.75rem',
                        background: 'rgba(239, 68, 68, 0.1)',
                        border: '1px solid rgba(239, 68, 68, 0.3)',
                        borderRadius: '6px',
                        fontSize: '0.875rem',
                        textAlign: 'center',
                        color: 'rgba(255,255,255,0.8)'
                    }}>
                        <span style={{ color: '#ef4444' }}>⚠️</span> Skipping will leave QuoxCORE in limited mode.
                        Add an OpenAI or Anthropic API key later in Settings → Core Integrations to enable direct chat.
                    </div>
                )}
            </form>
        </div>
    )
}
