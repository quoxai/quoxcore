/**
 * CoreIntegrations - Core API key and service configuration
 *
 * AI Services: Anthropic, OpenAI, ElevenLabs, Perplexity, Gemini, Codex
 * Auth: Claude CLI subscription (terminal-based OAuth)
 * Services: Qdrant vector database URL
 *
 * Uses POST /api/admin/config/integration for post-setup key management.
 * Vault selections persist via _vault_credential_id entries in instance_config.
 */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import SettingsSection from './SettingsSection';
import SettingsCard, { SettingsGroup } from './SettingsCard';
import TerminalEmbed from '../terminal/TerminalEmbed';
import CredentialPicker from '../integrations/CredentialPicker';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useAuth } from '../../contexts/AuthContext';
import { useLlmRoutingPolicy } from '../../hooks/useLlmRoutingPolicy';
import { csrfFetch } from '../../utils/csrfFetch';
import { getCollectorUnavailableStatus, getSessionExpiredStatus, normalizeLlmStatusPayload } from '../../services/llmStatus';
import './settings.css';

const API_BASE = '/api';

// SVG icons (explicit strokes per CLAUDE.md — no currentColor)
const EyeIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'rgba(255,255,255,0.5)' }}>
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
    </svg>
);
const EyeOffIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'rgba(255,255,255,0.5)' }}>
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
        <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
        <line x1="1" y1="1" x2="23" y2="23"/>
    </svg>
);
const ShieldIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" strokeWidth="2" style={{ stroke: 'rgba(56,189,248,0.8)' }}>
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
    </svg>
);
const TestIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'rgba(255,255,255,0.7)' }}>
        <polyline points="20 6 9 17 4 12"/>
    </svg>
);

function timeAgo(dateStr) {
    if (!dateStr) return null;
    const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
}

// ---------------------------------------------------------------------------
// IntegrationItem — reusable per-provider card
// ---------------------------------------------------------------------------
function IntegrationItem({
    label, hint, type, configField,
    hasKey, updatedAt, vaultCredentialId,
    keyPrefix, getKeyUrl, getKeyLabel,
    onSave, onVaultSelect, onTest,
    saving, testing, testResult,
    required = false,
    isUrl = false,
    defaultValue,
}) {
    const [value, setValue] = useState('');
    const [showKey, setShowKey] = useState(false);
    const [showManual, setShowManual] = useState(false);

    // If vault credential is active, don't show manual input
    const hasVault = !!vaultCredentialId;

    const handleSubmit = () => {
        if (!value.trim()) return;
        onSave(configField, value.trim());
        setValue('');
        setShowManual(false);
    };

    const validFormat = keyPrefix && value ? (value.startsWith(keyPrefix) ? 'valid' : 'invalid') : null;

    return (
        <div className="core-integration-item">
            {/* Header: label + status */}
            <div className="core-integration-header">
                <div className="core-integration-info">
                    <label className="core-integration-label">
                        {label}
                        {required && <span className="core-integration-required">Required</span>}
                    </label>
                    <span className="core-integration-hint">{hint}</span>
                </div>
                <div className="core-integration-status">
                    {hasKey ? (
                        <span className={`status-badge ${hasVault ? 'status-badge--vault' : 'status-badge--configured'}`}>
                            {hasVault ? (
                                <><ShieldIcon /> Via Vault</>
                            ) : 'Configured'}
                            {updatedAt && <span className="status-badge-time">{timeAgo(updatedAt)}</span>}
                        </span>
                    ) : (
                        <span className="status-badge status-badge--missing">Not Set</span>
                    )}
                </div>
            </div>

            {/* Vault picker (primary method) */}
            {!isUrl && (
                <div className="core-integration-vault-row">
                    <span className="core-integration-vault-label">
                        <ShieldIcon /> From vault:
                    </span>
                    <CredentialPicker
                        type={type}
                        value={vaultCredentialId}
                        onSelect={(cred) => onVaultSelect(type, configField, cred)}
                        compact
                        placeholder="Select credential..."
                    />
                    {!showManual && !hasVault && (
                        <button
                            className="core-integration-manual-toggle"
                            onClick={() => setShowManual(true)}
                        >
                            or enter manually
                        </button>
                    )}
                </div>
            )}

            {/* Manual input (secondary — shown for URLs always, or when toggled) */}
            {(isUrl || showManual || (!vaultCredentialId && !type)) && (
                <div className="core-integration-input-row">
                    <div className={`core-integration-input-wrapper ${isUrl ? 'core-integration-input-wrapper--wide' : ''}`}>
                        <input
                            type={isUrl ? 'text' : (showKey ? 'text' : 'password')}
                            value={value}
                            onChange={(e) => setValue(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter' && value.trim()) handleSubmit(); }}
                            placeholder={hasKey ? 'Key is stored securely' : (isUrl ? (defaultValue || 'Enter URL') : `Enter ${label}`)}
                            className={`core-integration-input ${isUrl ? 'core-integration-input--wide' : ''}`}
                        />
                        {!isUrl && (
                            <button
                                type="button"
                                className="core-integration-toggle"
                                onClick={() => setShowKey(prev => !prev)}
                                title={showKey ? 'Hide' : 'Show'}
                            >
                                {showKey ? <EyeOffIcon /> : <EyeIcon />}
                            </button>
                        )}
                    </div>
                    {validFormat && (
                        <span className={`api-key-status ${validFormat}`}>
                            {validFormat === 'valid' ? 'Valid format' : 'Invalid format'}
                        </span>
                    )}
                    <button
                        className="core-integration-save"
                        onClick={handleSubmit}
                        disabled={saving || !value.trim()}
                    >
                        {saving ? 'Saving...' : 'Save'}
                    </button>
                </div>
            )}

            {/* Actions row: test button + external link */}
            <div className="core-integration-actions">
                {!isUrl && hasKey && (
                    <button
                        className={`core-integration-test ${testResult?.success === true ? 'core-integration-test--pass' : ''} ${testResult?.success === false ? 'core-integration-test--fail' : ''}`}
                        onClick={() => onTest(type)}
                        disabled={testing}
                        title="Test this key against the provider API"
                    >
                        <TestIcon />
                        {testing ? 'Testing...' : testResult ? (testResult.success ? `OK (${testResult.latencyMs}ms)` : 'Failed') : 'Test Key'}
                    </button>
                )}
                {getKeyUrl && (
                    <a href={getKeyUrl} target="_blank" rel="noopener noreferrer" className="core-integration-link">
                        Get key at {getKeyLabel}
                    </a>
                )}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// VaultBanner
// ---------------------------------------------------------------------------
function VaultBanner() {
    const navigate = useNavigate();
    const [dismissed, setDismissed] = useState(() => localStorage.getItem('quox-vault-banner-dismissed') === 'true');

    if (dismissed) return null;

    return (
        <div className="core-integration-vault-banner">
            <div className="core-integration-vault-banner__content">
                <ShieldIcon />
                <div>
                    <div className="core-integration-vault-banner__title">QuoxVault Available</div>
                    <div className="core-integration-vault-banner__hint">Manage API keys with AES-256-GCM encryption, RBAC, and audit logging</div>
                </div>
            </div>
            <div className="core-integration-vault-banner__actions">
                <button onClick={() => navigate('/vault')} className="core-integration-vault-banner__btn">
                    Open Vault
                </button>
                <button
                    onClick={() => { setDismissed(true); localStorage.setItem('quox-vault-banner-dismissed', 'true'); }}
                    className="core-integration-vault-banner__dismiss"
                    title="Dismiss"
                >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" strokeWidth="2" style={{ stroke: 'rgba(255,255,255,0.4)' }}>
                        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                </button>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Integration definitions
// ---------------------------------------------------------------------------
// Primary chat providers
const PRIMARY_CHAT_INTEGRATIONS = [
    { label: 'OpenAI API Key', hint: 'GPT-5 chat, planning, coding, embeddings, Whisper STT, semantic search', type: 'openai', configField: 'openaiKey', statusKey: 'hasOpenaiKey', keyPrefix: 'sk-', getKeyUrl: 'https://platform.openai.com/', getKeyLabel: 'platform.openai.com' },
    { label: 'Anthropic API Key', hint: 'Claude chat and reasoning when selected by policy, credentials, or manual override', type: 'anthropic', configField: 'anthropicKey', statusKey: 'hasAnthropicKey', keyPrefix: 'sk-ant-', getKeyUrl: 'https://console.anthropic.com/', getKeyLabel: 'console.anthropic.com' },
];

// Other AI providers
const OTHER_INTEGRATIONS = [
    { label: 'ElevenLabs API Key', hint: 'Voice synthesis and TTS', type: 'elevenlabs', configField: 'elevenlabsKey', statusKey: 'hasElevenlabsKey', getKeyUrl: 'https://elevenlabs.io/', getKeyLabel: 'elevenlabs.io' },
    { label: 'Perplexity API Key', hint: 'AI-powered search', type: 'perplexity', configField: 'perplexityKey', statusKey: 'hasPerplexityKey', keyPrefix: 'pplx-', getKeyUrl: 'https://perplexity.ai/', getKeyLabel: 'perplexity.ai' },
    { label: 'Google Gemini API Key', hint: 'Multimodal AI and image generation', type: 'gemini', configField: 'geminiKey', statusKey: 'hasGeminiKey', getKeyUrl: 'https://aistudio.google.com/', getKeyLabel: 'aistudio.google.com' },
    { label: 'OpenAI Codex API Key', hint: 'Code generation', type: 'openai', configField: 'codexKey', statusKey: 'hasCodexKey', keyPrefix: 'sk-', getKeyUrl: 'https://platform.openai.com/', getKeyLabel: 'platform.openai.com' },
];

const PROVIDER_STATUS_KEY_MAP = {
    anthropic: 'hasAnthropicKey',
    openai: 'hasOpenaiKey',
    elevenlabs: 'hasElevenlabsKey',
    perplexity: 'hasPerplexityKey',
    gemini: 'hasGeminiKey',
    codex: 'hasCodexKey',
};

function formatCapabilityLabel(label = '') {
    return label || 'Unassigned';
}

function formatProviderLabel(provider = '') {
    if (provider === 'anthropic') return 'Anthropic / Claude';
    if (provider === 'openai') return 'OpenAI';
    if (provider === 'gemini') return 'Google Gemini';
    if (provider === 'perplexity') return 'Perplexity';
    return provider || 'Unassigned';
}

function buildProviderUsageSummary(policy) {
    const summary = new Map();
    const capabilities = policy?.capabilities || {};
    const preferredOrder = ['openai', 'anthropic', 'perplexity', 'gemini'];

    for (const capability of Object.values(capabilities)) {
        const provider = capability?.primary?.provider;
        const label = capability?.capabilityLabel || capability?.policyLabel || 'Capability';
        if (!provider) continue;
        if (!summary.has(provider)) summary.set(provider, []);
        summary.get(provider).push(label);
    }

    preferredOrder.forEach((provider) => {
        if (!summary.has(provider)) summary.set(provider, []);
    });

    return Array.from(summary.entries()).map(([provider, labels]) => ({
        provider,
        labels,
    }));
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function CoreIntegrations() {
    const navigate = useNavigate();
    const [configStatus, setConfigStatus] = useState({});
    const [timestamps, setTimestamps] = useState({});
    const [vaultSelections, setVaultSelections] = useState({});
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [notification, setNotification] = useState(null);
    const [showTerminal, setShowTerminal] = useState(false);
    // DEVSUITE-DEVMODE 5c: Codex gets the same web-terminal auth treatment
    // as the Claude Subscription item (owner decision 2026-08-11).
    const [showCodexTerminal, setShowCodexTerminal] = useState(false);
    const [chatStatus, setChatStatus] = useState(null);
    const [testingProvider, setTestingProvider] = useState(null);
    const [testResults, setTestResults] = useState({});
    const { currentOrg } = useWorkspace() || {};
    const { authFetch } = useAuth();
    const llmRoutingPolicy = useLlmRoutingPolicy(authFetch, currentOrg?.id);

    useEffect(() => { loadConfigStatus(); }, []);

    const loadConfigStatus = async () => {
        try {
            const res = await fetch(`${API_BASE}/setup/config`, { credentials: 'include' });
            if (res.ok) {
                const data = await res.json();
                setConfigStatus(data.keys || {});
                setTimestamps(data.timestamps || {});
                setVaultSelections(data.vaultSelections || {});
            }
            const chatRes = await fetch('/collector/chat/status', { signal: AbortSignal.timeout(10000) });
            if (chatRes.ok) {
                setChatStatus(normalizeLlmStatusPayload(await chatRes.json()));
            } else if (chatRes.status === 401 || chatRes.status === 403) {
                // Stale session, not a dead collector — don't mislabel it.
                setChatStatus(getSessionExpiredStatus(`HTTP ${chatRes.status}`));
            } else {
                setChatStatus(getCollectorUnavailableStatus(`HTTP ${chatRes.status}`));
            }
        } catch (err) {
            console.error('Failed to load config status:', err);
            setChatStatus(getCollectorUnavailableStatus(err.message));
        } finally {
            setLoading(false);
        }
    };

    const showNotif = useCallback((message, type = 'info') => {
        setNotification({ message, type });
        setTimeout(() => setNotification(null), 4000);
    }, []);

    // Save a key via the admin endpoint (works post-setup)
    const handleSave = async (configField, value, vaultCredentialId = null) => {
        setSaving(true);
        try {
            const res = await csrfFetch(`${API_BASE}/admin/config/integration`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ field: configField, value, vaultCredentialId }),
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.message || `Save failed (${res.status})`);
            }

            showNotif('Configuration saved', 'success');
            await loadConfigStatus();
        } catch (err) {
            showNotif(err.message || 'Failed to save', 'error');
        } finally {
            setSaving(false);
        }
    };

    // Vault credential selected — backend resolves the key server-side
    const handleVaultSelect = async (type, configField, cred) => {
        if (!cred?.id) return;
        setSaving(true);
        try {
            // Pass vaultCredentialId without value — backend resolves the key
            const res = await csrfFetch(`${API_BASE}/admin/config/integration`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ field: configField, vaultCredentialId: cred.id }),
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.message || `Save failed (${res.status})`);
            }

            showNotif('Vault credential applied', 'success');
            await loadConfigStatus();
        } catch (err) {
            showNotif(err.message || 'Failed to apply vault credential', 'error');
        } finally {
            setSaving(false);
        }
    };

    // Test a key
    const handleTest = async (provider) => {
        setTestingProvider(provider);
        setTestResults(prev => ({ ...prev, [provider]: null }));
        try {
            const res = await csrfFetch(`${API_BASE}/admin/config/integration/test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider }),
            });
            const data = await res.json();
            setTestResults(prev => ({ ...prev, [provider]: data }));
            showNotif(data.success ? `${provider} key verified (${data.latencyMs}ms)` : `${provider} test failed: ${data.error}`, data.success ? 'success' : 'error');
        } catch (err) {
            setTestResults(prev => ({ ...prev, [provider]: { success: false, error: err.message } }));
            showNotif(`Test failed: ${err.message}`, 'error');
        } finally {
            setTestingProvider(null);
        }
    };

    // Map provider name to configStatus key
    const STATUS_KEY_MAP = {
        anthropic: 'hasAnthropicKey', openai: 'hasOpenaiKey', elevenlabs: 'hasElevenlabsKey',
        perplexity: 'hasPerplexityKey', gemini: 'hasGeminiKey', codex: 'hasCodexKey',
    };

    if (loading) {
        return (
            <SettingsSection title="Core Integrations" description="Loading configuration...">
                <SettingsCard glass>
                    <div style={{ padding: '2rem', textAlign: 'center', color: 'rgba(255,255,255,0.4)' }}>Loading...</div>
                </SettingsCard>
            </SettingsSection>
        );
    }

    // Claude subscription status. UI-10: read CLI-specific flags from
    // chatStatus.cliCredentials (server-side provider-independent truth)
    // rather than the global authMethod, which only reports the *priority*
    // provider — so when OpenAI/Anthropic API keys take priority, the
    // CLI's authenticated state was hidden behind authMethod !== 'cli_credentials'.
    const claudeAuth = chatStatus?.authMethod;
    const cliAuthenticated = !!chatStatus?.cliCredentials?.authenticated;
    const claudeExpiry = chatStatus?.cliCredentials?.expires_in_minutes
        ?? chatStatus?.debug?.cli_expires_in_minutes;
    const hasAnthropicKey = !!chatStatus?.providers?.anthropic_api_key;
    const terminalCapability = chatStatus?.capabilities?.terminalOAuth;
    const terminalUnavailable = terminalCapability?.available === false;
    const terminalHint = terminalUnavailable
        ? (terminalCapability.recommendation || 'Claude terminal login is unavailable on this deployment.')
        : (showTerminal ? 'Login flow starts automatically. Follow the prompts to authenticate.' : 'Opens Claude CLI and starts the login flow automatically');
    const providerUsageSummary = buildProviderUsageSummary(llmRoutingPolicy.policy);

    return (
        <>
            {/* Notification toast */}
            {notification && (
                <div style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 1000, maxWidth: 400, animation: 'fadeInUp 0.3s ease-out' }}>
                    <div className={`ui-alert ui-alert-${notification.type}`}>{notification.message}</div>
                </div>
            )}

            <VaultBanner />

            <SettingsSection
                title="Use For"
                description="What each provider is currently assigned to in your execution policy."
            >
                <SettingsCard
                    glass
                    title="Routing Summary"
                    subtitle={llmRoutingPolicy.source === 'org' ? 'Using your saved organization routing policy' : 'Using the built-in seed routing policy'}
                    status={llmRoutingPolicy.source === 'org' ? 'success' : 'warning'}
                    statusText={llmRoutingPolicy.source === 'org' ? 'Org policy active' : 'Seed fallback'}
                >
                    <SettingsGroup>
                        <div style={{ display: 'grid', gap: '12px' }}>
                            {providerUsageSummary.map(({ provider, labels }) => {
                                const configured = !!configStatus[PROVIDER_STATUS_KEY_MAP[provider]];
                                const anthropicReady =
                                    provider === 'anthropic' && (
                                        configured ||
                                        claudeAuth === 'cli_credentials' ||
                                        terminalCapability?.available
                                    );
                                const ready = provider === 'anthropic' ? anthropicReady : configured;
                                const statusText = provider === 'anthropic'
                                    ? (configured ? 'Ready' : (claudeAuth === 'cli_credentials' ? 'Claude authed' : (terminalCapability?.available ? 'Terminal ready' : 'Needs setup')))
                                    : (ready ? 'Ready' : 'Needs key');
                                return (
                                    <div
                                        key={provider}
                                        style={{
                                            display: 'flex',
                                            justifyContent: 'space-between',
                                            alignItems: 'flex-start',
                                            gap: '16px',
                                            padding: '12px 14px',
                                            borderRadius: '12px',
                                            border: '1px solid rgba(255,255,255,0.08)',
                                            background: 'rgba(255,255,255,0.03)',
                                        }}
                                    >
                                        <div style={{ display: 'grid', gap: '6px' }}>
                                            <strong style={{ color: 'var(--ui-text-primary)' }}>{formatProviderLabel(provider)}</strong>
                                            <div style={{ color: 'var(--ui-text-secondary)', fontSize: '0.92rem' }}>
                                                Use for: {labels.length ? labels.map(formatCapabilityLabel).join(', ') : 'Not currently assigned by org policy'}
                                            </div>
                                        </div>
                                        <span className={`status-badge ${ready ? 'status-badge--configured' : 'status-badge--missing'}`}>
                                            {statusText}
                                        </span>
                                    </div>
                                );
                            })}
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                            <div className="core-integration-hint">
                                Change capability defaults, fallback chains, and personal overrides in Execution Policy.
                            </div>
                            <button
                                className="core-integration-save"
                                onClick={() => navigate('/settings#execution-policy', { state: { section: 'execution-policy' } })}
                                type="button"
                            >
                                Open Execution Policy
                            </button>
                        </div>
                    </SettingsGroup>
                </SettingsCard>
            </SettingsSection>

            {/* Primary chat providers */}
            <SettingsSection
                title="Primary Chat Providers"
                description="Chat-capable providers used by execution policy, manual selection, and Vault-backed routing."
            >
                <SettingsCard glass>
                    <SettingsGroup>
                        {PRIMARY_CHAT_INTEGRATIONS.map(integ => (
                            <IntegrationItem
                                key={integ.configField}
                                label={integ.label}
                                hint={integ.hint}
                                type={integ.type}
                                configField={integ.configField}
                                hasKey={!!configStatus[integ.statusKey]}
                                updatedAt={timestamps[integ.type]}
                                vaultCredentialId={vaultSelections[integ.type]}
                                keyPrefix={integ.keyPrefix}
                                getKeyUrl={integ.getKeyUrl}
                                getKeyLabel={integ.getKeyLabel}
                                onSave={handleSave}
                                onVaultSelect={handleVaultSelect}
                                onTest={handleTest}
                                saving={saving}
                                testing={testingProvider === integ.type}
                                testResult={testResults[integ.type]}
                                required={integ.required}
                            />
                        ))}

                        {/* Claude Subscription — OAuth via CLI terminal */}
                        <div className="core-integration-item">
                            <div className="core-integration-header">
                                <div className="core-integration-info">
                                    <label className="core-integration-label">Claude Subscription</label>
                                    <span className="core-integration-hint">Optional Claude CLI OAuth path for Anthropic access</span>
                                </div>
                                <div className="core-integration-status">
                                    {terminalUnavailable ? (
                                        <span className="status-badge status-badge--missing">Unavailable</span>
                                    ) : cliAuthenticated ? (
                                        <span className="status-badge status-badge--configured">
                                            CLI Authenticated
                                            {claudeExpiry && <span className="status-badge-time">expires in {Math.round(claudeExpiry / 60)}h</span>}
                                        </span>
                                    ) : hasAnthropicKey ? (
                                        <span className="status-badge status-badge--configured">API Key Active</span>
                                    ) : (
                                        <span className="status-badge status-badge--missing">Not Connected</span>
                                    )}
                                </div>
                            </div>
                            <div style={{ marginTop: '0.75rem' }}>
                                <button
                                    className="core-integration-save"
                                    onClick={() => setShowTerminal(prev => !prev)}
                                    disabled={terminalUnavailable}
                                    style={{ background: showTerminal ? 'rgba(255,255,255,0.1)' : undefined, color: showTerminal ? 'rgba(255,255,255,0.8)' : undefined }}
                                >
                                    {showTerminal ? 'Close Terminal' : 'Open Terminal'}
                                </button>
                                <span className="core-integration-hint" style={{ marginLeft: '0.75rem' }}>
                                    {terminalHint}
                                </span>
                            </div>
                            {terminalUnavailable && (
                                <div className="core-integration-hint" style={{ marginTop: '0.75rem', display: 'block' }}>
                                    {terminalCapability?.detail ? `${terminalHint} (${terminalCapability.detail})` : terminalHint}
                                </div>
                            )}
                            {showTerminal && (
                                <>
                                    <div className="core-integration-hint" style={{ marginTop: '0.5rem', display: 'block', fontSize: '11px', opacity: 0.75 }}>
                                        Claude CLI captures the mouse. To copy the login URL, <strong>hold Shift while dragging</strong> to select, then Ctrl/Cmd+C. Right-click selects a word. Paste with Ctrl+Shift+V (or Cmd+V on Mac).
                                    </div>
                                    <div style={{ marginTop: '0.5rem', borderRadius: '6px', overflow: 'hidden', height: 350 }}>
                                        <TerminalEmbed
                                            wsUrl={`${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/collector/terminal/ws`}
                                            onConnect={() => showNotif('Terminal connected, login flow starting...', 'success')}
                                            onDisconnect={() => { setTimeout(() => loadConfigStatus(), 1000); }}
                                        />
                                    </div>
                                </>
                            )}
                        </div>

                        {/* Codex Subscription — device-auth via web terminal.
                            DEVSUITE-DEVMODE 5c: codex is the second loop backend and is
                            treated the same as Claude. Its device-auth flow prints a URL +
                            one-time code (no localhost callback), ideal for headless. */}
                        <div className="core-integration-item">
                            <div className="core-integration-header">
                                <div className="core-integration-info">
                                    <label className="core-integration-label">Codex Subscription</label>
                                    <span className="core-integration-hint">ChatGPT device-code login for the Codex CLI (loop backend)</span>
                                </div>
                                <div className="core-integration-status">
                                    {chatStatus?.codexCli?.installed === false ? (
                                        <span className="status-badge status-badge--missing">Not Installed</span>
                                    ) : chatStatus?.codexCli?.authenticated ? (
                                        <span className="status-badge status-badge--configured">CLI Authenticated</span>
                                    ) : configStatus?.hasOpenaiKey ? (
                                        <span className="status-badge status-badge--configured">API Key Active</span>
                                    ) : (
                                        <span className="status-badge status-badge--missing">Not Connected</span>
                                    )}
                                </div>
                            </div>
                            <div style={{ marginTop: '0.75rem' }}>
                                <button
                                    className="core-integration-save"
                                    onClick={() => setShowCodexTerminal(prev => !prev)}
                                    disabled={chatStatus?.codexCli?.installed === false}
                                    style={{ background: showCodexTerminal ? 'rgba(255,255,255,0.1)' : undefined, color: showCodexTerminal ? 'rgba(255,255,255,0.8)' : undefined }}
                                >
                                    {showCodexTerminal ? 'Close Terminal' : 'Open Terminal'}
                                </button>
                                <span className="core-integration-hint" style={{ marginLeft: '0.75rem' }}>
                                    {chatStatus?.codexCli?.installed === false
                                        ? 'The codex CLI is not installed in this deployment.'
                                        : 'Shows a URL and one-time code; open the URL on any device to sign in'}
                                </span>
                            </div>
                            {showCodexTerminal && (
                                <div style={{ marginTop: '0.5rem', borderRadius: '6px', overflow: 'hidden', height: 350 }}>
                                    <TerminalEmbed
                                        wsUrl={`${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/collector/terminal/ws?app=codex`}
                                        onConnect={() => showNotif('Terminal connected, device-auth code incoming...', 'success')}
                                        onDisconnect={() => { setTimeout(() => loadConfigStatus(), 1000); }}
                                    />
                                </div>
                            )}
                        </div>
                    </SettingsGroup>
                </SettingsCard>
            </SettingsSection>

            {/* Other AI Services */}
            <SettingsSection
                title="AI Services"
                description="Additional providers and voice services. Use QuoxVault for encrypted storage, or enter keys manually."
            >
                <SettingsCard glass>
                    <SettingsGroup>
                        {OTHER_INTEGRATIONS.map(integ => (
                            <IntegrationItem
                                key={integ.configField}
                                label={integ.label}
                                hint={integ.hint}
                                type={integ.type}
                                configField={integ.configField}
                                hasKey={!!configStatus[integ.statusKey]}
                                updatedAt={timestamps[integ.type]}
                                vaultCredentialId={vaultSelections[integ.type]}
                                keyPrefix={integ.keyPrefix}
                                getKeyUrl={integ.getKeyUrl}
                                getKeyLabel={integ.getKeyLabel}
                                onSave={handleSave}
                                onVaultSelect={handleVaultSelect}
                                onTest={handleTest}
                                saving={saving}
                                testing={testingProvider === integ.type}
                                testResult={testResults[integ.type]}
                                required={integ.required}
                            />
                        ))}
                    </SettingsGroup>
                </SettingsCard>
            </SettingsSection>

            {/* Service Endpoints */}
            <SettingsSection
                title="Service Endpoints"
                description="URLs for infrastructure services."
            >
                <SettingsCard glass>
                    <SettingsGroup>
                        <IntegrationItem
                            label="Qdrant Vector Database"
                            hint="Semantic search and vector storage"
                            configField="qdrantUrl"
                            hasKey={!!configStatus.qdrantUrl}
                            updatedAt={null}
                            onSave={handleSave}
                            onVaultSelect={() => {}}
                            onTest={() => {}}
                            saving={saving}
                            isUrl
                            defaultValue="http://localhost:6333"
                        />
                    </SettingsGroup>
                </SettingsCard>
            </SettingsSection>
        </>
    );
}
