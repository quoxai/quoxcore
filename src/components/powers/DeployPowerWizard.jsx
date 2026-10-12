import { useState, useEffect } from 'react';
import Modal from '../ui/Modal';
import { detectPower, deployPower, finalizeRepoDeploy, updateRepoDeploy } from '../../services/powersClient';
import {
    RepoNoticeStep,
    RepoEnvStep,
    RepoBuildStep,
    RepoInitiateStep,
} from './DeployPowerRepoSteps';
import './DeployPowerWizard.css';

const AUTH_KINDS = [
    { value: 'none', label: 'None' },
    { value: 'bearer', label: 'Bearer Token' },
    { value: 'header', label: 'Custom Header' },
];

const SLUG_RE = /^[a-z][a-z0-9_]*$/;
const GITHUB_REPO_RE = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(\.git)?\/?$/;

function toDefaultSlug(name = '') {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/^([^a-z])/, 'a$1') || 'mcp_agent';
}

function truncate(str, n) {
    if (!str) return '';
    return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

/**
 * Detects whether a URL is a GitHub repo URL.
 * Returns true if it matches the github.com/owner/repo pattern.
 */
function isGitHubRepoUrl(url) {
    return GITHUB_REPO_RE.test(url.trim());
}

export default function DeployPowerWizard({ orgId, onClose, onDeployed, inline = false }) {
    const [step, setStep] = useState('connect');

    // ── Shared URL input ──────────────────────────────────────────────────────
    const [url, setUrl] = useState('');

    // ── Endpoint branch (P1) state ────────────────────────────────────────────
    const [authKind, setAuthKind] = useState('none');
    const [authValue, setAuthValue] = useState('');
    const [detecting, setDetecting] = useState(false);
    const [connectError, setConnectError] = useState(null);
    const [detected, setDetected] = useState(null);

    // ── Repo branch state ─────────────────────────────────────────────────────
    const [repoStep, setRepoStep] = useState(null); // null | 'notice' | 'env' | 'initiating' | 'build' | 'build_failed'
    const [envVars, setEnvVars] = useState([]);
    const [repoRef, setRepoRef] = useState(''); // D2: optional SHA pin
    const [forceSuffix, setForceSuffix] = useState(null); // D1: force_suffix for duplicates
    const [duplicateInfo, setDuplicateInfo] = useState(null); // D1: { existing, actions, message }
    const [toolDefId, setToolDefId] = useState(null);
    const [buildFailed, setBuildFailed] = useState(null);

    // ── Persona step (shared by both branches) ────────────────────────────────
    const [agentId, setAgentId] = useState('');
    const [displayName, setDisplayName] = useState('');
    const [description, setDescription] = useState('');
    const [icon, setIcon] = useState('');
    const [systemPromptAdditions, setSystemPromptAdditions] = useState('');
    const [slugError, setSlugError] = useState(null);
    const [deploying, setDeploying] = useState(false);
    const [personaError, setPersonaError] = useState(null);

    // ── Success / terminal error ──────────────────────────────────────────────
    const [deployed, setDeployed] = useState(null);
    const [terminalError, setTerminalError] = useState(null);

    // ── D3: transport_hint banner ─────────────────────────────────────────────
    // Populated from the detect response when transport_hint === 'http' + confidence high.
    const [transportHint, setTransportHint] = useState(null); // null | { recommendation }
    const [transportHintDismissed, setTransportHintDismissed] = useState(false);

    // ── Which branch ──────────────────────────────────────────────────────────
    const [branch, setBranch] = useState(null); // null | 'endpoint' | 'repo'

    // ── Prefill from ?prefill=<url> query param ───────────────────────────────
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const prefillUrl = params.get('prefill');
        if (!prefillUrl) return;

        const decoded = decodeURIComponent(prefillUrl);
        setUrl(decoded);

        // Auto-trigger the connect step for GitHub repo URLs
        if (GITHUB_REPO_RE.test(decoded.trim())) {
            setBranch('repo');
            setRepoStep('notice');
            setStep('repo_notice');
        } else if (decoded.trim().length > 0) {
            // For endpoint URLs, auto-trigger detect
            setBranch('endpoint');
            setDetecting(true);
            setConnectError(null);
            detectPower(orgId, {
                url: decoded.trim(),
                authKind: 'none',
                authValue: '',
            }).then((result) => {
                if (result.type === 'mcp_endpoint') {
                    const serverName = result.probe_result?.serverInfo?.name || 'MCP Server';
                    const serverDesc = result.probe_result?.serverInfo?.description || '';
                    const defaultSlug = toDefaultSlug(serverName);
                    setDetected(result);
                    setAgentId(defaultSlug);
                    setDisplayName(serverName + ' Agent');
                    if (serverDesc) setDescription(serverDesc);
                    setStep('persona');
                } else {
                    setConnectError(result.error || 'Probe failed: server did not respond as an MCP endpoint.');
                    setBranch(null);
                    setStep('connect');
                }
            }).catch((err) => {
                setConnectError(err.message || 'Network error reaching the server.');
                setBranch(null);
                setStep('connect');
            }).finally(() => {
                setDetecting(false);
            });
        }

        // Clean the prefill param from the URL after consuming it
        const cleanParams = new URLSearchParams(window.location.search);
        cleanParams.delete('prefill');
        const newSearch = cleanParams.toString();
        const newUrl = window.location.pathname + (newSearch ? `?${newSearch}` : '') + window.location.hash;
        window.history.replaceState(null, '', newUrl);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // ── D3: background transport hint check ──────────────────────────────────
    // When the URL changes to a GitHub repo, call /detect in the background
    // to check for transport_hint. Non-blocking — banner only shows if 'http'.
    useEffect(() => {
        if (!isGitHubRepoUrl(url.trim()) || !orgId) {
            setTransportHint(null);
            setTransportHintDismissed(false);
            return;
        }
        let cancelled = false;
        detectPower(orgId, { url: url.trim(), authKind: 'none', authValue: '' })
            .then((result) => {
                if (cancelled) return;
                if (result?.transport_hint === 'http') {
                    setTransportHint({ recommendation: result.recommendation || 'This repo uses HTTP transport. Use the MCP Server (Endpoint) tab instead.' });
                } else {
                    setTransportHint(null);
                }
            })
            .catch(() => { /* non-fatal */ });
        return () => { cancelled = true; };
    }, [url, orgId]); // eslint-disable-line react-hooks/exhaustive-deps

    // ── Computed from auth state ──────────────────────────────────────────────
    const authValueLabel =
        authKind === 'bearer' ? 'Bearer token' :
        authKind === 'header' ? 'Header (Name: value)' : '';

    const authValueHint =
        authKind === 'header' ? 'Format: HeaderName: value' : null;

    const detectEnabled =
        url.trim().length > 0 &&
        (authKind === 'none' || authValue.trim().length > 0) &&
        !detecting;

    const deployEnabled =
        agentId.trim().length > 0 &&
        SLUG_RE.test(agentId) &&
        displayName.trim().length > 0 &&
        !deploying;

    // ── Handlers ──────────────────────────────────────────────────────────────

    async function handleConnectSubmit() {
        const trimmed = url.trim();
        if (!trimmed) return;

        if (isGitHubRepoUrl(trimmed)) {
            // Repo branch
            setBranch('repo');
            setRepoStep('notice');
            setStep('repo_notice');
        } else {
            // Endpoint branch (P1 path)
            setBranch('endpoint');
            setDetecting(true);
            setConnectError(null);
            try {
                const result = await detectPower(orgId, {
                    url: trimmed,
                    authKind,
                    authValue: authValue.trim(),
                });
                if (result.type === 'mcp_endpoint') {
                    const serverName = result.probe_result?.serverInfo?.name || 'MCP Server';
                    const serverDesc = result.probe_result?.serverInfo?.description || '';
                    const defaultSlug = toDefaultSlug(serverName);
                    setDetected(result);
                    setAgentId(defaultSlug);
                    setDisplayName(serverName + ' Agent');
                    if (serverDesc) setDescription(serverDesc);
                    setStep('persona');
                } else {
                    setConnectError(result.error || 'Probe failed: server did not respond as an MCP endpoint.');
                }
            } catch (err) {
                setConnectError(err.message || 'Network error reaching the server.');
            } finally {
                setDetecting(false);
            }
        }
    }

    function handleSlugChange(val) {
        setAgentId(val);
        if (val.length > 0 && !SLUG_RE.test(val)) {
            setSlugError('Use lowercase letters, digits, underscores; must start with a letter.');
        } else {
            setSlugError(null);
        }
    }

    // Endpoint branch deploy (P1)
    async function handleEndpointDeploy() {
        setDeploying(true);
        setPersonaError(null);
        try {
            const result = await deployPower(orgId, {
                url: url.trim(),
                authKind,
                authValue: authValue.trim(),
                persona: {
                    agent_id: agentId,
                    name: displayName,
                    description: description || undefined,
                    icon: icon || undefined,
                    system_prompt_additions: systemPromptAdditions || undefined,
                },
            });
            setDeployed(result);
            setStep('success');
            window.dispatchEvent(new CustomEvent('powers:deployed', {
                detail: { tool_id: result?.tool_id, agent_id: result?.agent_id },
            }));
        } catch (err) {
            const body = err.response?.body || {};
            const msg = body.message || body.error || err.message || 'Deploy failed.';
            setPersonaError(msg);
        } finally {
            setDeploying(false);
        }
    }

    // Repo branch finalize (P2.C) — called from persona step after build succeeds
    async function handleRepoFinalize() {
        setDeploying(true);
        setPersonaError(null);
        try {
            const result = await finalizeRepoDeploy(orgId, toolDefId, {
                agent_id: agentId,
                name: displayName,
                description: description || undefined,
                icon: icon || undefined,
                system_prompt_additions: systemPromptAdditions || undefined,
            });
            setDeployed(result);
            setStep('success');
            window.dispatchEvent(new CustomEvent('powers:deployed', {
                detail: { tool_id: result?.tool_id, agent_id: result?.agent_id },
            }));
        } catch (err) {
            const body = err.response?.body || {};
            const msg = body.message || body.error || err.message || 'Deploy failed.';
            setPersonaError(msg);
        } finally {
            setDeploying(false);
        }
    }

    function handleBackToConnect() {
        setStep('connect');
        setBranch(null);
        setRepoStep(null);
        setDetected(null);
        setPersonaError(null);
        setTerminalError(null);
        setToolDefId(null);
        setBuildFailed(null);
        setEnvVars([]);
        setRepoRef('');
        setForceSuffix(null);
        setDuplicateInfo(null);
    }

    // D1: 409 already_installed — user chose an action
    function handleDuplicateDetected(info) {
        setDuplicateInfo(info);
        setStep('repo_duplicate');
    }

    function handleDuplicateUpdate() {
        // Navigate user to the existing tool's detail page
        if (duplicateInfo?.existing?.tool_def_id) {
            window.location.href = `/tools/${encodeURIComponent(duplicateInfo.existing.tool_id || duplicateInfo.existing.tool_def_id)}`;
        }
    }

    function handleDuplicateInstallSuffix() {
        // Generate a short suffix and re-initiate build
        const suffix = Math.random().toString(36).slice(2, 6);
        setForceSuffix(suffix);
        setDuplicateInfo(null);
        setStep('repo_initiating');
    }

    // ── Repo branch: build done → show persona step ───────────────────────────
    function handleBuildSuccess({ toolDefId: tdId }) {
        setToolDefId(tdId);
        // Pre-populate persona slug + description from repo name
        const match = url.trim().match(/(?:github|gitlab)\.com\/([\w.-]+)\/([\w.-]+)/);
        if (match) {
            const repoName = match[2];
            const slug = toDefaultSlug(repoName);
            setAgentId(slug);
            setDisplayName(`${repoName} Agent`);
            // Pre-fill a brief description so agents don't show "No description available"
            if (!description) setDescription(`${repoName} MCP server deployed as a sandboxed agent.`);
        }
        setStep('persona');
        setRepoStep('done');
    }

    function handleBuildFailed({ reason }) {
        setBuildFailed(reason);
        setRepoStep('build_failed');
    }

    // ── Called after build kickoff succeeds → switch to polling step ──────────
    function handleBuildInitiated({ toolDefId: tdId }) {
        setToolDefId(tdId);
        setRepoStep('build');
        setStep('repo_build');
    }

    const serverInfo = detected?.probe_result?.serverInfo || {};
    const tools = detected?.probe_result?.tools || [];

    // ── Determine what footer buttons to show ─────────────────────────────────
    const isRepoPersona = branch === 'repo' && step === 'persona';

    const wizardBody = (
        <>
            <Modal.Header
                title="Deploy External Repository"
                description={
                    branch === 'repo'
                        ? 'Clone an external MCP repository and run it as a sandboxed Quox agent.'
                        : 'Connect an MCP server or external repository and deploy it as a Quox agent.'
                }
                onClose={inline ? undefined : onClose}
                icon={
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4 16v4h16v-4"/>
                        <polyline points="8 12 12 8 16 12"/>
                        <line x1="12" y1="8" x2="12" y2="20"/>
                    </svg>
                }
            />

            <Modal.Body className="deploy-power-wizard">

                {/* ── CONNECT STEP ─────────────────────────────────────────── */}
                {step === 'connect' && (
                    <div className="wizard-step">
                        <div className="wizard-field">
                            <label className="wizard-label">External Repository or MCP URL</label>
                            <input
                                type="url"
                                className="qx-input"
                                placeholder="https://example.com/mcp  or  https://github.com/owner/repo"
                                value={url}
                                onChange={e => setUrl(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter' && detectEnabled) handleConnectSubmit(); }}
                                autoFocus
                            />
                            <span className="wizard-hint">
                                Paste an MCP server URL to connect directly, or a Git repository URL (GitHub / GitLab / Gitea) to clone &amp; build.
                            </span>
                        </div>

                        {!isGitHubRepoUrl(url) && (
                            <>
                                <div className="wizard-field">
                                    <label className="wizard-label">Authentication</label>
                                    <select
                                        className="qx-select"
                                        value={authKind}
                                        onChange={e => { setAuthKind(e.target.value); setAuthValue(''); }}
                                    >
                                        {AUTH_KINDS.map(k => (
                                            <option key={k.value} value={k.value}>{k.label}</option>
                                        ))}
                                    </select>
                                </div>

                                {authKind !== 'none' && (
                                    <div className="wizard-field">
                                        <label className="wizard-label">{authValueLabel}</label>
                                        <input
                                            type="text"
                                            className="qx-input"
                                            placeholder={authKind === 'header' ? 'Authorization: Bearer my-token' : 'Enter token'}
                                            value={authValue}
                                            onChange={e => setAuthValue(e.target.value)}
                                        />
                                        {authValueHint && (
                                            <span className="wizard-hint">{authValueHint}</span>
                                        )}
                                    </div>
                                )}
                            </>
                        )}

                        {isGitHubRepoUrl(url) && (
                            <div className="wizard-hint" style={{ background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 6, padding: '8px 12px', fontSize: '0.8rem' }}>
                                GitHub repo detected — Quox will clone and build this repo in a sandboxed container.
                            </div>
                        )}

                        {/* D3: transport_hint HTTP banner */}
                        {transportHint && !transportHintDismissed && (
                            <div
                                data-testid="transport-hint-banner"
                                style={{
                                    display: 'flex', alignItems: 'flex-start', gap: 10,
                                    background: 'rgba(234,179,8,0.08)',
                                    border: '1px solid rgba(234,179,8,0.35)',
                                    borderRadius: 6, padding: '10px 12px',
                                    fontSize: '0.82rem',
                                    color: 'rgba(255,255,255,0.9)',
                                }}
                            >
                                <svg
                                    width="16" height="16" viewBox="0 0 24 24"
                                    style={{ fill: 'none', stroke: '#eab308', strokeWidth: 2, flexShrink: 0, marginTop: 1 }}
                                    strokeLinecap="round" strokeLinejoin="round"
                                >
                                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                                    <line x1="12" y1="9" x2="12" y2="13"/>
                                    <line x1="12" y1="17" x2="12.01" y2="17"/>
                                </svg>
                                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                                    <span>
                                        <strong style={{ color: '#eab308' }}>HTTP transport detected.</strong>{' '}
                                        This repo uses HTTP transport, not stdio. Use the <em>MCP Server (Endpoint)</em> tab instead — <code>mcp_hosted</code> only supports stdio MCPs.
                                    </span>
                                    <div style={{ display: 'flex', gap: 8 }}>
                                        <button
                                            style={{
                                                background: 'rgba(234,179,8,0.15)',
                                                border: '1px solid rgba(234,179,8,0.4)',
                                                borderRadius: 4,
                                                color: '#eab308',
                                                fontSize: '0.78rem',
                                                padding: '3px 10px',
                                                cursor: 'pointer',
                                            }}
                                            onClick={() => {
                                                // Switch to endpoint tab: clear branch, reset URL so user can paste it as an endpoint URL
                                                setBranch('endpoint');
                                                setTransportHintDismissed(true);
                                            }}
                                        >
                                            <svg width="12" height="12" viewBox="0 0 24 24" style={{ fill: 'none', stroke: '#eab308', strokeWidth: 2, marginRight: 4 }} strokeLinecap="round" strokeLinejoin="round">
                                                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                                                <polyline points="15 3 21 3 21 9"/>
                                                <line x1="10" y1="14" x2="21" y2="3"/>
                                            </svg>
                                            Switch to MCP Server tab
                                        </button>
                                        <button
                                            style={{
                                                background: 'transparent',
                                                border: 'none',
                                                color: 'rgba(255,255,255,0.4)',
                                                fontSize: '0.78rem',
                                                padding: '3px 6px',
                                                cursor: 'pointer',
                                            }}
                                            onClick={() => setTransportHintDismissed(true)}
                                        >
                                            Dismiss
                                        </button>
                                    </div>
                                </div>
                            </div>
                        )}

                        {connectError && (
                            <div className="wizard-error-inline">{connectError}</div>
                        )}
                    </div>
                )}

                {/* ── REPO: NOTICE STEP ─────────────────────────────────────── */}
                {step === 'repo_notice' && (
                    <RepoNoticeStep
                        repoUrl={url.trim()}
                        repoRef={repoRef}
                        onRepoRefChange={setRepoRef}
                    />
                )}

                {/* ── REPO: ENV VARS STEP ───────────────────────────────────── */}
                {step === 'repo_env' && (
                    <RepoEnvStep envVars={envVars} onEnvVarsChange={setEnvVars} />
                )}

                {/* ── REPO: INITIATING BUILD ────────────────────────────────── */}
                {step === 'repo_initiating' && (
                    <RepoInitiateStep
                        orgId={orgId}
                        repoUrl={url.trim()}
                        envVars={envVars}
                        repoRef={repoRef}
                        forceSuffix={forceSuffix}
                        onReady={handleBuildInitiated}
                        onDuplicate={handleDuplicateDetected}
                        onError={msg => {
                            setTerminalError(msg);
                            setStep('error');
                        }}
                    />
                )}

                {/* ── D1: DUPLICATE DETECTED ────────────────────────────────── */}
                {step === 'repo_duplicate' && duplicateInfo && (
                    <div className="wizard-step">
                        <div className="wizard-server-banner" style={{ background: 'rgba(234,179,8,0.08)', borderColor: 'rgba(234,179,8,0.3)' }}>
                            <svg width="16" height="16" viewBox="0 0 24 24" style={{ fill: 'none', stroke: '#eab308', strokeWidth: 2, flexShrink: 0 }} strokeLinecap="round" strokeLinejoin="round">
                                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                                <line x1="12" y1="9" x2="12" y2="13"/>
                                <line x1="12" y1="17" x2="12.01" y2="17"/>
                            </svg>
                            <span style={{ fontSize: '0.85rem' }}>
                                {duplicateInfo.message || 'This repo is already deployed to your org.'}
                            </span>
                        </div>
                        {duplicateInfo.existing && (
                            <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary, #aaa)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                                <div>Agent: <strong>{duplicateInfo.existing.agent_id || duplicateInfo.existing.tool_id}</strong></div>
                                <div>Status: <strong>{duplicateInfo.existing.status}</strong></div>
                                <div>Version: <strong>{duplicateInfo.existing.current_version}</strong></div>
                                {duplicateInfo.existing.deployed_at && (
                                    <div>Deployed: <strong>{new Date(duplicateInfo.existing.deployed_at).toLocaleDateString()}</strong></div>
                                )}
                            </div>
                        )}
                        <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary, #aaa)' }}>
                            What would you like to do?
                        </div>
                    </div>
                )}

                {/* ── REPO: BUILD PROGRESS ──────────────────────────────────── */}
                {step === 'repo_build' && toolDefId && (
                    <RepoBuildStep
                        orgId={orgId}
                        repoUrl={url.trim()}
                        envVars={envVars}
                        toolDefId={toolDefId}
                        onSuccess={handleBuildSuccess}
                        onFailed={handleBuildFailed}
                    />
                )}

                {/* ── PERSONA STEP (endpoint branch + repo branch post-build) ── */}
                {step === 'persona' && (
                    <div className="wizard-step">
                        {branch === 'endpoint' && (
                            <div className="wizard-server-banner">
                                Connected to{' '}
                                <strong>{serverInfo.name || 'MCP Server'}</strong>
                                {serverInfo.version && ` (v${serverInfo.version})`}
                                {' '}&mdash; {tools.length} tool{tools.length !== 1 ? 's' : ''} available.
                            </div>
                        )}

                        {branch === 'repo' && (
                            <div className="wizard-server-banner" style={{ background: 'rgba(34,197,94,0.08)', borderColor: 'rgba(34,197,94,0.25)' }}>
                                Build complete. Configure your agent below.
                            </div>
                        )}

                        {branch === 'endpoint' && tools.length > 0 && (
                            <div className="wizard-tools-list">
                                {tools.map(t => (
                                    <div key={t.name} className="wizard-tool-row">
                                        <span className="wizard-tool-name">{t.name}</span>
                                        {t.description && (
                                            <span className="wizard-tool-desc">
                                                &mdash; {truncate(t.description, 80)}
                                            </span>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}

                        <div className="wizard-field">
                            <label className="wizard-label">Agent slug (required)</label>
                            <input
                                type="text"
                                className="qx-input"
                                placeholder="my_mcp_agent"
                                value={agentId}
                                onChange={e => handleSlugChange(e.target.value)}
                                autoFocus
                            />
                            <span className="wizard-hint">lowercase letters, digits, underscores; must start with a letter</span>
                            {slugError && (
                                <div className="wizard-error-inline">{slugError}</div>
                            )}
                        </div>

                        <div className="wizard-field">
                            <label className="wizard-label">Display name (required)</label>
                            <input
                                type="text"
                                className="qx-input"
                                placeholder="My MCP Agent"
                                value={displayName}
                                onChange={e => setDisplayName(e.target.value)}
                            />
                        </div>

                        <div className="wizard-field">
                            <label className="wizard-label">Description (optional)</label>
                            <textarea
                                className="qx-input"
                                rows={2}
                                placeholder="What this agent does..."
                                value={description}
                                onChange={e => setDescription(e.target.value)}
                                style={{ resize: 'vertical' }}
                            />
                        </div>

                        <div className="wizard-field">
                            <label className="wizard-label">Icon (optional)</label>
                            <input
                                type="text"
                                className="qx-input"
                                placeholder="Emoji or icon name"
                                value={icon}
                                onChange={e => setIcon(e.target.value)}
                            />
                        </div>

                        <div className="wizard-field">
                            <label className="wizard-label">System prompt additions (optional)</label>
                            <textarea
                                className="qx-input"
                                rows={3}
                                placeholder="Extra system prompt for this agent (optional)"
                                value={systemPromptAdditions}
                                onChange={e => setSystemPromptAdditions(e.target.value)}
                                style={{ resize: 'vertical' }}
                            />
                        </div>

                        {personaError && (
                            <div className="wizard-error-inline">{personaError}</div>
                        )}
                    </div>
                )}

                {/* ── SUCCESS STEP ─────────────────────────────────────────── */}
                {step === 'success' && (
                    <div className="wizard-success-block">
                        <div className="wizard-success-icon">
                            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--hal-green, #22c55e)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="20 6 9 17 4 12"/>
                            </svg>
                        </div>
                        <h2 className="wizard-success-heading">Power deployed.</h2>
                        <p className="wizard-success-sub">
                            <strong>{displayName}</strong> is ready to use.
                        </p>
                        <div className="wizard-id-block">
                            <div>Tool ID: {deployed?.tool_id}</div>
                            <div>Agent ID: {deployed?.agent_id}</div>
                        </div>
                        <p style={{ fontSize: '0.78rem', color: 'var(--text-muted, #888)', margin: 0 }}>
                            Reload /agents to see your new agent if it does not appear immediately.
                        </p>
                    </div>
                )}

                {/* ── ERROR STEP ───────────────────────────────────────────── */}
                {step === 'error' && (
                    <div className="wizard-success-block">
                        <div className="wizard-error-icon">
                            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--color-error, #ef4444)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <line x1="18" y1="6" x2="6" y2="18"/>
                                <line x1="6" y1="6" x2="18" y2="18"/>
                            </svg>
                        </div>
                        <h2 className="wizard-success-heading" style={{ color: 'var(--color-error, #ef4444)' }}>
                            Deployment failed.
                        </h2>
                        {terminalError && (
                            <div className="wizard-error-inline" style={{ width: '100%', textAlign: 'left' }}>
                                {terminalError}
                            </div>
                        )}
                    </div>
                )}

            </Modal.Body>

            <Modal.Footer>
                {step === 'connect' && (
                    <>
                        <button className="qx-btn qx-btn--ghost" onClick={onClose}>
                            Cancel
                        </button>
                        <button
                            className="qx-btn qx-btn--primary"
                            onClick={handleConnectSubmit}
                            disabled={!detectEnabled}
                        >
                            {detecting && <span className="wizard-spinner" />}
                            {detecting ? 'Detecting…' : isGitHubRepoUrl(url) ? 'Continue' : 'Detect'}
                        </button>
                    </>
                )}

                {step === 'repo_notice' && (
                    <>
                        <button className="qx-btn qx-btn--ghost" onClick={handleBackToConnect}>
                            Back
                        </button>
                        <button
                            className="qx-btn qx-btn--primary"
                            onClick={() => setStep('repo_env')}
                        >
                            Next
                        </button>
                    </>
                )}

                {step === 'repo_env' && (
                    <>
                        <button className="qx-btn qx-btn--ghost" onClick={() => setStep('repo_notice')}>
                            Back
                        </button>
                        <button
                            className="qx-btn qx-btn--primary"
                            onClick={() => setStep('repo_initiating')}
                        >
                            Start Build
                        </button>
                    </>
                )}

                {step === 'repo_initiating' && (
                    <button className="qx-btn qx-btn--ghost" disabled>
                        Starting…
                    </button>
                )}

                {step === 'repo_duplicate' && (
                    <>
                        <button className="qx-btn qx-btn--ghost" onClick={handleBackToConnect}>
                            Cancel
                        </button>
                        <button
                            className="qx-btn qx-btn--ghost"
                            onClick={handleDuplicateInstallSuffix}
                        >
                            <svg width="14" height="14" viewBox="0 0 24 24" style={{ fill: 'none', stroke: '#6366f1', strokeWidth: 2, marginRight: 5 }} strokeLinecap="round" strokeLinejoin="round">
                                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                            </svg>
                            Install duplicate
                        </button>
                        <button
                            className="qx-btn qx-btn--primary"
                            onClick={handleDuplicateUpdate}
                        >
                            <svg width="14" height="14" viewBox="0 0 24 24" style={{ fill: 'none', stroke: '#fff', strokeWidth: 2, marginRight: 5 }} strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="23 4 23 10 17 10"/>
                                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                            </svg>
                            Update existing
                        </button>
                    </>
                )}

                {step === 'repo_build' && (
                    <button className="qx-btn qx-btn--ghost" onClick={onClose}>
                        Close (build continues in background)
                    </button>
                )}

                {step === 'persona' && (
                    <>
                        <button className="qx-btn qx-btn--ghost" onClick={handleBackToConnect}>
                            Back
                        </button>
                        <button
                            className="qx-btn qx-btn--primary"
                            onClick={isRepoPersona ? handleRepoFinalize : handleEndpointDeploy}
                            disabled={!deployEnabled}
                        >
                            {deploying && <span className="wizard-spinner" />}
                            {deploying ? 'Deploying…' : 'Deploy Agent'}
                        </button>
                    </>
                )}

                {step === 'success' && (
                    <>
                        <button className="qx-btn qx-btn--ghost" onClick={onClose}>
                            Close
                        </button>
                        <button
                            className="qx-btn qx-btn--primary"
                            onClick={() => onDeployed(deployed)}
                        >
                            Open in /agents
                        </button>
                    </>
                )}

                {step === 'error' && (
                    <>
                        <button className="qx-btn qx-btn--ghost" onClick={handleBackToConnect}>
                            Back
                        </button>
                    </>
                )}
            </Modal.Footer>
        </>
    );

    if (inline) {
        return wizardBody;
    }

    return (
        <Modal isOpen onClose={onClose} size="lg">
            {wizardBody}
        </Modal>
    );
}
