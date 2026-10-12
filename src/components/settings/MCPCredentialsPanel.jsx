/**
 * MCPCredentialsPanel — Settings › Account › MCP Credentials (MCPB-HARDEN Phase 2E)
 *
 * Manages per-user MCP tokens: list, generate, revoke, and download a
 * personalised .mcpb bundle that embeds the token so users don't need to
 * paste credentials manually into Claude Desktop.
 *
 * Manual QA checklist (Settings → Account → MCP Credentials):
 * 1. Empty state shown for new account.
 * 2. Generate credential — modal opens, label required, token shown ONCE with copy button.
 * 3. Token disappears after Mark as saved.
 * 4. New token appears in list as Active with no last_used_at.
 * 5. Revoke — confirmation modal, status flips to Revoked, button removed.
 * 6. Download Personalized Bundle — label modal, browser download starts, filename = quoxmcp-personalised.mcpb.
 * 7. Bundle is a valid zip (open with archive viewer, manifest.json has user's org_id/user_id baked in mcp_config.env, no user_config block).
 * 8. Deprecation banner visible at top.
 */

import { useState, useCallback, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import SettingsSection from './SettingsSection';
import SettingsCard from './SettingsCard';
import './settings.css';

// Derive the collector base URL — mirrors ClaudeDesktopInstall exactly.
function getCollectorBaseUrl() {
    if (typeof window === 'undefined') return 'http://localhost:9848';
    if (import.meta.env.VITE_COLLECTOR_URL) return import.meta.env.VITE_COLLECTOR_URL;
    return `${window.location.protocol}//${window.location.hostname}:9848`;
}

// ── Inline SVG icons (copied from ClaudeDesktopInstall — no new shared util) ──

const CopyIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" strokeWidth="2"
        strokeLinecap="round" strokeLinejoin="round"
        style={{ stroke: 'rgba(255,255,255,0.7)' }}>
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
);

const CheckIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" strokeWidth="2"
        strokeLinecap="round" strokeLinejoin="round"
        style={{ stroke: 'rgba(52,211,153,0.9)' }}>
        <polyline points="20 6 9 17 4 12" />
    </svg>
);

const DownloadIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" strokeWidth="2"
        strokeLinecap="round" strokeLinejoin="round"
        style={{ stroke: 'rgba(255,255,255,0.9)' }}>
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
);

const PlusIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" strokeWidth="2"
        strokeLinecap="round" strokeLinejoin="round"
        style={{ stroke: 'currentColor' }}>
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
);

const TrashIcon = () => (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" strokeWidth="2"
        strokeLinecap="round" strokeLinejoin="round"
        style={{ stroke: 'currentColor' }}>
        <polyline points="3 6 5 6 21 6" />
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
        <path d="M10 11v6M14 11v6" />
        <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
);

// ── Small helpers ─────────────────────────────────────────────────────────────

function formatDate(isoStr) {
    if (!isoStr) return '—';
    return new Date(isoStr).toLocaleDateString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
    });
}

function CopyButton({ value }) {
    const [copied, setCopied] = useState(false);
    const handleCopy = useCallback(() => {
        navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }).catch(() => {});
    }, [value]);
    return (
        <button
            type="button"
            onClick={handleCopy}
            title="Copy to clipboard"
            className="qx-btn qx-btn--ghost"
            style={{
                background: copied ? 'rgba(52,211,153,0.12)' : undefined,
                borderColor: copied ? 'rgba(52,211,153,0.35)' : undefined,
                padding: '7px 10px',
                flexShrink: 0,
            }}
        >
            {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
    );
}

// ── Inline modal backdrop ─────────────────────────────────────────────────────

function Modal({ onClose, children }) {
    return (
        <div
            role="dialog"
            aria-modal="true"
            onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
            style={{
                position: 'fixed', inset: 0, zIndex: 2000,
                background: 'rgba(0,0,0,0.72)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: 20,
            }}
        >
            <div style={{
                background: 'var(--m-bg-base)',
                borderRadius: 12,
                padding: 24,
                maxWidth: 480,
                width: '100%',
                border: '1px solid rgba(255,255,255,0.14)',
                boxShadow: '0 20px 50px rgba(0,0,0,0.5)',
            }}>
                {children}
            </div>
        </div>
    );
}

// ── Generate credential modal ─────────────────────────────────────────────────

function GenerateModal({ onClose, onSuccess }) {
    const [label, setLabel] = useState('');
    const [busy, setBusy]   = useState(false);
    const [error, setError] = useState(null);

    const handleSubmit = useCallback(async (e) => {
        e.preventDefault();
        if (!label.trim()) { setError('A label is required.'); return; }
        setBusy(true);
        setError(null);
        try {
            const res = await fetch('/api/auth/tokens/mcp', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ label: label.trim() }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                setError(data.message || data.error || `Server error (${res.status})`);
                return;
            }
            onSuccess(data); // { id, token, label, created_at }
        } catch {
            setError('Network error — please try again.');
        } finally {
            setBusy(false);
        }
    }, [label, onSuccess]);

    return (
        <Modal onClose={onClose}>
            <h2 style={{ fontSize: 18, fontWeight: 600, color: 'rgba(255,255,255,0.9)', marginTop: 0, marginBottom: 6 }}>
                Generate MCP Credential
            </h2>
            <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.55)', marginBottom: 20, lineHeight: 1.6 }}>
                Give this credential a descriptive label so you can identify it later (e.g. "Claude Desktop on MacBook Pro").
            </p>
            <form onSubmit={handleSubmit}>
                <label htmlFor="mcp-label" style={{
                    display: 'block', fontSize: 12, fontWeight: 500,
                    color: 'rgba(255,255,255,0.55)', textTransform: 'uppercase',
                    letterSpacing: '0.03em', marginBottom: 6,
                }}>
                    Label
                </label>
                <input
                    id="mcp-label"
                    type="text"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="e.g. Claude Desktop on MacBook Pro"
                    autoFocus
                    className="qx-input"
                    style={{
                        width: '100%',
                        boxSizing: 'border-box',
                        padding: '9px 12px',
                        fontSize: 13,
                        marginBottom: 16,
                    }}
                />
                {error && (
                    <div role="alert" style={{
                        background: 'rgba(248,113,113,0.08)',
                        border: '1px solid rgba(248,113,113,0.3)',
                        borderRadius: 6, padding: '8px 12px',
                        fontSize: 13, color: 'rgba(248,113,113,0.95)',
                        marginBottom: 16,
                    }}>
                        {error}
                    </div>
                )}
                <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                    <button type="button" onClick={onClose} disabled={busy} style={secondaryBtnStyle(busy)}>
                        Cancel
                    </button>
                    <button type="submit" disabled={busy || !label.trim()} style={primaryBtnStyle(busy || !label.trim())}>
                        {busy ? 'Generating…' : 'Generate'}
                    </button>
                </div>
            </form>
        </Modal>
    );
}

// ── Token-reveal modal — shown immediately after generation ───────────────────

function TokenRevealModal({ tokenData, onClose }) {
    const [saved, setSaved] = useState(false);
    if (saved) {
        onClose();
        return null;
    }
    return (
        <Modal onClose={() => { /* prevent backdrop-click dismiss on reveal */ }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                <span style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: 28, height: 28, borderRadius: '50%',
                    background: 'rgba(52,211,153,0.14)',
                    border: '1px solid rgba(52,211,153,0.35)',
                    flexShrink: 0,
                }}>
                    <CheckIcon />
                </span>
                <h2 style={{ fontSize: 18, fontWeight: 600, color: 'rgba(255,255,255,0.9)', margin: 0 }}>
                    Credential created
                </h2>
            </div>
            <div style={{
                background: 'rgba(245,158,11,0.07)',
                border: '1px solid rgba(245,158,11,0.28)',
                borderRadius: 6, padding: '10px 14px',
                fontSize: 13, color: 'rgba(255,200,80,0.9)',
                lineHeight: 1.6, marginBottom: 16,
            }}>
                Copy this token now. You will never see it again — it is not stored on the server after this point.
            </div>

            <div style={{ fontSize: 12, fontWeight: 500, color: 'rgba(255,255,255,0.55)', textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: 6 }}>
                {tokenData.label}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 20 }}>
                <input
                    readOnly
                    value={tokenData.token}
                    className="qx-input qx-input--mono"
                    style={{
                        flex: 1,
                        padding: '8px 12px',
                        fontSize: 12,
                    }}
                />
                <CopyButton value={tokenData.token} />
            </div>

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button
                    type="button"
                    onClick={() => setSaved(true)}
                    style={primaryBtnStyle(false)}
                >
                    Mark as saved
                </button>
            </div>
        </Modal>
    );
}

// ── Revoke confirmation modal ─────────────────────────────────────────────────

function RevokeModal({ token, onClose, onRevoked }) {
    const [busy, setBusy]   = useState(false);
    const [error, setError] = useState(null);

    const handleRevoke = useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(`/api/auth/tokens/mcp/${token.id}`, {
                method: 'DELETE',
                credentials: 'include',
            });
            if (res.ok || res.status === 204 || res.status === 404) {
                onRevoked(token.id);
            } else {
                const data = await res.json().catch(() => ({}));
                setError(data.message || data.error || `Server error (${res.status})`);
            }
        } catch {
            setError('Network error — please try again.');
        } finally {
            setBusy(false);
        }
    }, [token, onRevoked]);

    return (
        <Modal onClose={onClose}>
            <h2 style={{ fontSize: 18, fontWeight: 600, color: 'rgba(248,113,113,0.95)', marginTop: 0, marginBottom: 12 }}>
                Revoke Credential
            </h2>
            <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.65)', lineHeight: 1.6, marginBottom: 8 }}>
                You are about to revoke:
            </p>
            <p style={{ fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.85)', marginBottom: 16 }}>
                &ldquo;{token.label}&rdquo;
            </p>
            <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.55)', lineHeight: 1.6, marginBottom: 20 }}>
                Any Claude Desktop or MCP client using this credential will lose access immediately. This cannot be undone.
            </p>
            {error && (
                <div role="alert" style={{
                    background: 'rgba(248,113,113,0.08)',
                    border: '1px solid rgba(248,113,113,0.3)',
                    borderRadius: 6, padding: '8px 12px',
                    fontSize: 13, color: 'rgba(248,113,113,0.95)',
                    marginBottom: 16,
                }}>
                    {error}
                </div>
            )}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button type="button" onClick={onClose} disabled={busy} style={secondaryBtnStyle(busy)}>
                    Cancel
                </button>
                <button type="button" onClick={handleRevoke} disabled={busy} style={dangerBtnStyle(busy)}>
                    {busy ? 'Revoking…' : 'Revoke'}
                </button>
            </div>
        </Modal>
    );
}

// ── Bundle download modal ─────────────────────────────────────────────────────

function BundleModal({ onClose, onSuccess }) {
    const [label, setLabel] = useState('Claude Desktop');
    const [busy, setBusy]   = useState(false);
    const [error, setError] = useState(null);
    const collectorUrl = getCollectorBaseUrl();

    const handleDownload = useCallback(async (e) => {
        e.preventDefault();
        if (!label.trim()) { setError('A label is required.'); return; }
        setBusy(true);
        setError(null);
        try {
            // Step 1 — mint a token
            const tokenRes = await fetch('/api/auth/tokens/mcp', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ label: label.trim() }),
            });
            const tokenData = await tokenRes.json().catch(() => ({}));
            if (!tokenRes.ok) {
                setError(tokenData.message || tokenData.error || `Could not generate credential (${tokenRes.status})`);
                return;
            }

            // Step 2 — request personalised bundle.
            // Path is RELATIVE so the nginx /collector/ proxy forwards it
            // and the user JWT cookie travels (cross-origin to :9848 would drop it).
            // collectorUrl in the body is the ABSOLUTE URL Claude Desktop will hit.
            const bundleRes = await fetch('/collector/api/v1/mcp/bundle', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    token: tokenData.token,
                    collector_url: collectorUrl,
                    agent_id: 'quox',
                }),
            });
            if (!bundleRes.ok) {
                setError(`Bundle generation failed (${bundleRes.status}) — please try again.`);
                return;
            }

            // Trigger browser download
            const blob = await bundleRes.blob();
            const url  = URL.createObjectURL(blob);
            const a    = document.createElement('a');
            a.href     = url;
            a.download = 'quoxmcp-personalised.mcpb';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            onSuccess(); // refresh token list + show toast
        } catch (err) {
            setError(`Network error — ${err.message || 'please try again'}.`);
        } finally {
            setBusy(false);
        }
    }, [label, collectorUrl, onSuccess]);

    return (
        <Modal onClose={onClose}>
            <h2 style={{ fontSize: 18, fontWeight: 600, color: 'rgba(255,255,255,0.9)', marginTop: 0, marginBottom: 6 }}>
                Download Personalized Bundle
            </h2>
            <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.55)', marginBottom: 20, lineHeight: 1.6 }}>
                A credential will be minted and baked into the <code style={{ background: 'rgba(255,255,255,0.08)', borderRadius: 4, padding: '1px 5px' }}>.mcpb</code> file so Claude Desktop connects automatically — no manual config needed.
            </p>
            <form onSubmit={handleDownload}>
                <label htmlFor="bundle-label" style={{
                    display: 'block', fontSize: 12, fontWeight: 500,
                    color: 'rgba(255,255,255,0.55)', textTransform: 'uppercase',
                    letterSpacing: '0.03em', marginBottom: 6,
                }}>
                    Label for this credential
                </label>
                <input
                    id="bundle-label"
                    type="text"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="e.g. Claude Desktop on MacBook Pro"
                    autoFocus
                    className="qx-input"
                    style={{
                        width: '100%',
                        boxSizing: 'border-box',
                        padding: '9px 12px',
                        fontSize: 13,
                        marginBottom: 16,
                    }}
                />
                {error && (
                    <div role="alert" style={{
                        background: 'rgba(248,113,113,0.08)',
                        border: '1px solid rgba(248,113,113,0.3)',
                        borderRadius: 6, padding: '8px 12px',
                        fontSize: 13, color: 'rgba(248,113,113,0.95)',
                        marginBottom: 16,
                    }}>
                        {error}
                    </div>
                )}
                <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                    <button type="button" onClick={onClose} disabled={busy} style={secondaryBtnStyle(busy)}>
                        Cancel
                    </button>
                    <button type="submit" disabled={busy || !label.trim()} style={primaryBtnStyle(busy || !label.trim())}>
                        <DownloadIcon />
                        {busy ? 'Preparing…' : 'Download Bundle'}
                    </button>
                </div>
            </form>
        </Modal>
    );
}

// ── Button style helpers (mirrors ClaudeDesktopInstall inline style approach) ──

function primaryBtnStyle(disabled) {
    return {
        display: 'inline-flex', alignItems: 'center', gap: 7,
        padding: '8px 16px',
        background: disabled ? 'rgba(255,255,255,0.04)' : 'rgba(139,92,246,0.18)',
        border: `1px solid ${disabled ? 'rgba(255,255,255,0.1)' : 'rgba(139,92,246,0.45)'}`,
        borderRadius: 6,
        color: disabled ? 'rgba(255,255,255,0.3)' : 'rgba(196,181,253,0.95)',
        fontSize: 13, fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'background 0.15s, border-color 0.15s, color 0.15s',
    };
}

function secondaryBtnStyle(disabled) {
    return {
        display: 'inline-flex', alignItems: 'center', gap: 7,
        padding: '8px 14px',
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 6,
        color: disabled ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.65)',
        fontSize: 13, fontWeight: 500,
        cursor: disabled ? 'not-allowed' : 'pointer',
    };
}

function dangerBtnStyle(disabled) {
    return {
        display: 'inline-flex', alignItems: 'center', gap: 7,
        padding: '8px 16px',
        background: disabled ? 'rgba(255,255,255,0.04)' : 'rgba(248,113,113,0.12)',
        border: `1px solid ${disabled ? 'rgba(255,255,255,0.1)' : 'rgba(248,113,113,0.35)'}`,
        borderRadius: 6,
        color: disabled ? 'rgba(255,255,255,0.3)' : 'rgba(248,113,113,0.95)',
        fontSize: 13, fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'background 0.15s, border-color 0.15s',
    };
}

// ── Token row in the table ────────────────────────────────────────────────────

function TokenRow({ tok, onRevoke }) {
    const isRevoked = Boolean(tok.revoked_at);
    return (
        <div style={{
            display: 'grid',
            gridTemplateColumns: '1fr auto auto auto',
            alignItems: 'center',
            gap: 12,
            padding: '11px 0',
            borderBottom: '1px solid rgba(255,255,255,0.06)',
        }}>
            {/* Label */}
            <div>
                <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.85)', fontWeight: 500 }}>
                    {tok.label}
                </div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', marginTop: 2 }}>
                    Created {formatDate(tok.created_at)}
                </div>
            </div>

            {/* Last used */}
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', whiteSpace: 'nowrap' }}>
                {tok.last_used_at ? `Used ${formatDate(tok.last_used_at)}` : 'Never used'}
            </div>

            {/* Status badge */}
            <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                padding: '3px 9px',
                borderRadius: 20,
                fontSize: 11, fontWeight: 600,
                background: isRevoked ? 'rgba(248,113,113,0.08)' : 'rgba(52,211,153,0.08)',
                border: `1px solid ${isRevoked ? 'rgba(248,113,113,0.25)' : 'rgba(52,211,153,0.25)'}`,
                color: isRevoked ? 'rgba(248,113,113,0.9)' : 'rgba(52,211,153,0.9)',
                whiteSpace: 'nowrap',
            }}>
                <span style={{
                    width: 6, height: 6, borderRadius: '50%',
                    background: isRevoked ? 'rgba(248,113,113,0.8)' : 'rgba(52,211,153,0.8)',
                    flexShrink: 0,
                }} />
                {isRevoked ? 'Revoked' : 'Active'}
            </span>

            {/* Revoke button (only for active tokens) */}
            <div style={{ minWidth: 28 }}>
                {!isRevoked && (
                    <button
                        type="button"
                        onClick={() => onRevoke(tok)}
                        title="Revoke this credential"
                        style={{
                            background: 'rgba(255,255,255,0.04)',
                            border: '1px solid rgba(255,255,255,0.1)',
                            borderRadius: 6,
                            padding: '5px 8px',
                            cursor: 'pointer',
                            display: 'inline-flex', alignItems: 'center',
                            color: 'rgba(248,113,113,0.7)',
                        }}
                    >
                        <TrashIcon />
                    </button>
                )}
            </div>
        </div>
    );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function MCPCredentialsPanel() {
    const { user } = useAuth();

    const [tokens, setTokens]               = useState([]);
    const [loading, setLoading]             = useState(true);
    const [fetchError, setFetchError]       = useState(null);

    // Modal state
    const [showGenerate, setShowGenerate]   = useState(false);
    const [newTokenData, setNewTokenData]   = useState(null); // { id, token, label, created_at }
    const [revokeTarget, setRevokeTarget]   = useState(null); // token object
    const [showBundle, setShowBundle]       = useState(false);

    // Toast
    const [toast, setToast]                 = useState(null);

    const showToast = useCallback((message, kind = 'success') => {
        setToast({ message, kind });
        setTimeout(() => setToast(null), 4000);
    }, []);

    const loadTokens = useCallback(async () => {
        setFetchError(null);
        try {
            const res = await fetch('/api/auth/tokens/mcp', { credentials: 'include' });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                setFetchError(data.message || data.error || `Failed to load tokens (${res.status})`);
                return;
            }
            const data = await res.json();
            setTokens(Array.isArray(data.tokens) ? data.tokens : []);
        } catch {
            setFetchError('Network error — could not load credentials.');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { if (user) loadTokens(); }, [user, loadTokens]);

    // Handlers
    const handleGenerateSuccess = useCallback((data) => {
        setShowGenerate(false);
        setNewTokenData(data);
        loadTokens();
    }, [loadTokens]);

    const handleTokenSaved = useCallback(() => {
        setNewTokenData(null);
    }, []);

    const handleRevoked = useCallback((id) => {
        setRevokeTarget(null);
        setTokens(prev => prev.map(t => t.id === id ? { ...t, revoked_at: new Date().toISOString() } : t));
        showToast('Credential revoked.');
    }, [showToast]);

    const handleBundleSuccess = useCallback(() => {
        setShowBundle(false);
        loadTokens();
        showToast('Bundle downloaded — credential added to your list.');
    }, [loadTokens, showToast]);

    const activeTokens  = tokens.filter(t => !t.revoked_at);
    const revokedTokens = tokens.filter(t => t.revoked_at);

    return (
        <>
            <SettingsSection
                title="MCP Credentials"
                description="Per-user tokens for Claude Desktop and other MCP clients. Each credential grants access to QuoxCORE tools via the MCP protocol."
            >
                {/* Deprecation banner */}
                <div style={{
                    background: 'rgba(245,158,11,0.07)',
                    border: '1px solid rgba(245,158,11,0.25)',
                    borderRadius: 8,
                    padding: '12px 16px',
                    marginBottom: 20,
                    fontSize: 13,
                    color: 'rgba(255,200,80,0.9)',
                    lineHeight: 1.6,
                }}>
                    <strong>If you installed Claude Desktop with QuoxMCP before 2026-05-01</strong>, please re-download your bundle for security improvements (per-user credentials are now required).
                </div>

                {/* Action buttons */}
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 24 }}>
                    <button
                        type="button"
                        onClick={() => setShowGenerate(true)}
                        style={primaryBtnStyle(false)}
                    >
                        <PlusIcon />
                        Generate new credential
                    </button>
                    <button
                        type="button"
                        onClick={() => setShowBundle(true)}
                        className="qx-btn qx-btn--primary"
                        style={{ padding: '8px 16px', fontSize: 13, fontWeight: 600 }}
                    >
                        <DownloadIcon />
                        Download Personalized Bundle
                    </button>
                </div>

                {/* Token list */}
                <SettingsCard glass>
                    {loading && (
                        <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.4)', fontStyle: 'italic', padding: '8px 0' }}>
                            Loading credentials&hellip;
                        </div>
                    )}

                    {!loading && fetchError && (
                        <div style={{
                            background: 'rgba(248,113,113,0.08)',
                            border: '1px solid rgba(248,113,113,0.25)',
                            borderRadius: 6, padding: '10px 14px',
                            fontSize: 13, color: 'rgba(248,113,113,0.9)',
                        }}>
                            {fetchError}
                        </div>
                    )}

                    {!loading && !fetchError && tokens.length === 0 && (
                        <div style={{
                            fontSize: 13,
                            color: 'rgba(255,255,255,0.45)',
                            lineHeight: 1.7,
                            padding: '4px 0',
                        }}>
                            You haven&apos;t issued any MCP credentials yet. Click <strong style={{ color: 'rgba(255,255,255,0.7)' }}>Generate new credential</strong> to create one, or <strong style={{ color: 'rgba(255,255,255,0.7)' }}>Download Personalized Bundle</strong> to install Claude Desktop with one click.
                        </div>
                    )}

                    {!loading && tokens.length > 0 && (
                        <>
                            {/* Column header */}
                            <div style={{
                                display: 'grid',
                                gridTemplateColumns: '1fr auto auto auto',
                                gap: 12,
                                padding: '0 0 8px',
                                borderBottom: '1px solid rgba(255,255,255,0.1)',
                                marginBottom: 2,
                            }}>
                                {['Label', 'Last used', 'Status', ''].map((h, i) => (
                                    <div key={i} style={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                                        {h}
                                    </div>
                                ))}
                            </div>

                            {activeTokens.map(t => (
                                <TokenRow key={t.id} tok={t} onRevoke={setRevokeTarget} />
                            ))}
                            {revokedTokens.map(t => (
                                <TokenRow key={t.id} tok={t} onRevoke={setRevokeTarget} />
                            ))}
                        </>
                    )}
                </SettingsCard>

                {/* Footer link to MCP status page */}
                <div style={{ marginTop: 16 }}>
                    <Link
                        to="/quoxmcp"
                        style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 5,
                            fontSize: 13,
                            color: 'rgba(147,210,255,0.75)',
                            textDecoration: 'none',
                            borderBottom: '1px solid rgba(147,210,255,0.22)',
                            paddingBottom: 1,
                        }}
                    >
                        View your MCP server status &rarr;
                    </Link>
                </div>
            </SettingsSection>

            {/* Toast notification */}
            {toast && (
                <div
                    role="status"
                    aria-live="polite"
                    style={{
                        position: 'fixed', bottom: 24, right: 24, zIndex: 3000,
                        background: toast.kind === 'success'
                            ? 'rgba(52,211,153,0.12)'
                            : 'rgba(248,113,113,0.12)',
                        border: `1px solid ${toast.kind === 'success' ? 'rgba(52,211,153,0.3)' : 'rgba(248,113,113,0.3)'}`,
                        borderRadius: 8, padding: '10px 16px',
                        fontSize: 13,
                        color: toast.kind === 'success' ? 'rgba(52,211,153,0.95)' : 'rgba(248,113,113,0.95)',
                        boxShadow: '0 4px 20px rgba(0,0,0,0.35)',
                        maxWidth: 320,
                    }}
                >
                    {toast.message}
                </div>
            )}

            {/* Modals */}
            {showGenerate && (
                <GenerateModal
                    onClose={() => setShowGenerate(false)}
                    onSuccess={handleGenerateSuccess}
                />
            )}
            {newTokenData && (
                <TokenRevealModal
                    tokenData={newTokenData}
                    onClose={handleTokenSaved}
                />
            )}
            {revokeTarget && (
                <RevokeModal
                    token={revokeTarget}
                    onClose={() => setRevokeTarget(null)}
                    onRevoked={handleRevoked}
                />
            )}
            {showBundle && (
                <BundleModal
                    onClose={() => setShowBundle(false)}
                    onSuccess={handleBundleSuccess}
                />
            )}
        </>
    );
}
