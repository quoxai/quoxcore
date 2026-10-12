/**
 * QuoxMCPView — Marketing + Ops surface for the QuoxMCP integration
 *
 * Sections:
 *  1. Hero — title, value prop, live status badges, personalised + generic download CTAs
 *  2. Install steps — expandable accordion, reuses CopyField / StepHeading
 *     pattern from ClaudeDesktopInstall
 *  3. Active sessions — table from /api/v1/mcp/status
 *  4. Tool catalog — /api/v1/tools/list?agent_id=quox, searchable
 *  5. Resources — /api/v1/resources/list, cards
 *  6. Prompts — /api/v1/prompts/list, cards with "Copy template" button
 *  7. Footer — links + version line
 */

import { useState, useEffect, useCallback, useRef, Component } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import TestConnectionButton from '../../components/mcp/TestConnectionButton';

// ── Constants ──────────────────────────────────────────────────────────────
const MCP_VERSION       = '1.2.0';
const MCPB_DOWNLOAD_URL = 'https://github.com/quoxai/quoxmcp/releases/latest/download/quoxmcp.mcpb';
const RELEASE_NOTES_URL = 'https://github.com/quoxai/quoxmcp/releases/latest';
const GITHUB_REPO_URL   = 'https://github.com/quoxai/quoxmcp';
const GITHUB_ISSUES_URL = 'https://github.com/quoxai/quoxmcp/issues';
const MCP_SPEC_URL      = 'https://modelcontextprotocol.io';
const DEFAULT_AGENT_ID  = 'quox';
const STATUS_POLL_MS    = 30000;
const ACTIVE_SESSION_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

// All API calls go through nginx proxy — no cross-origin absolute URL needed.
const COLLECTOR_BASE = '/collector';

// ── Helpers ────────────────────────────────────────────────────────────────
function relativeTime(isoStr) {
    if (!isoStr) return 'Never';
    const diffMs = Date.now() - new Date(isoStr).getTime();
    if (diffMs < 60000)  return `${Math.floor(diffMs / 1000)}s ago`;
    if (diffMs < 3600000) return `${Math.floor(diffMs / 60000)}m ago`;
    if (diffMs < 86400000) return `${Math.floor(diffMs / 3600000)}h ago`;
    return `${Math.floor(diffMs / 86400000)}d ago`;
}

// Simple debounce hook — avoids dependency on an external utility.
function useDebounce(value, delay) {
    const [debounced, setDebounced] = useState(value);
    useEffect(() => {
        const t = setTimeout(() => setDebounced(value), delay);
        return () => clearTimeout(t);
    }, [value, delay]);
    return debounced;
}

// ── ErrorBoundary — wraps the whole view so provider crashes show gracefully ──
class MCPViewErrorBoundary extends Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false };
    }
    static getDerivedStateFromError() {
        return { hasError: true };
    }
    render() {
        if (this.state.hasError) {
            return (
                <div className="qx-view">
                    <div className="qx-card" style={{ padding: 32, textAlign: 'center' }}>
                        <p style={{ color: 'rgba(255,255,255,0.6)', fontSize: 14 }}>
                            MCP page unavailable in this context: a required provider is missing.
                        </p>
                        <p style={{ color: 'rgba(255,255,255,0.35)', fontSize: 12, marginTop: 8 }}>
                            Try navigating away and back, or reload the page.
                        </p>
                    </div>
                </div>
            );
        }
        return this.props.children;
    }
}

// ── Shared inline SVG icons ────────────────────────────────────────────────
const DownloadIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" strokeWidth="2"
        strokeLinecap="round" strokeLinejoin="round"
        style={{ stroke: 'rgba(255,255,255,0.9)', flexShrink: 0 }}>
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
);

const ExternalLinkIcon = () => (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" strokeWidth="2"
        strokeLinecap="round" strokeLinejoin="round"
        style={{ stroke: 'rgba(255,255,255,0.7)', flexShrink: 0 }}>
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        <polyline points="15 3 21 3 21 9" />
        <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
);

const CopyIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" strokeWidth="2"
        strokeLinecap="round" strokeLinejoin="round"
        style={{ stroke: 'rgba(255,255,255,0.7)', flexShrink: 0 }}>
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
);

const CheckIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" strokeWidth="2"
        strokeLinecap="round" strokeLinejoin="round"
        style={{ stroke: 'rgba(52,211,153,0.9)', flexShrink: 0 }}>
        <polyline points="20 6 9 17 4 12" />
    </svg>
);

const ChevronDownIcon = ({ open }) => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" strokeWidth="2"
        strokeLinecap="round" strokeLinejoin="round"
        style={{
            stroke: 'rgba(255,255,255,0.5)',
            flexShrink: 0,
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 0.2s',
        }}>
        <polyline points="6 9 12 15 18 9" />
    </svg>
);

const EyeIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" strokeWidth="2"
        strokeLinecap="round" strokeLinejoin="round"
        style={{ stroke: 'rgba(255,255,255,0.5)', flexShrink: 0 }}>
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
        <circle cx="12" cy="12" r="3" />
    </svg>
);

const EyeOffIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" strokeWidth="2"
        strokeLinecap="round" strokeLinejoin="round"
        style={{ stroke: 'rgba(255,255,255,0.5)', flexShrink: 0 }}>
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
        <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
        <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
);

const StarIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" strokeWidth="2"
        strokeLinecap="round" strokeLinejoin="round"
        style={{ stroke: 'rgba(168,85,247,0.9)', flexShrink: 0 }}>
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
);

// ── Section heading style (inline — used in ~4 places) ─────────────────────
const SECTION_HEADING = {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: 'rgba(255,255,255,0.55)',
    marginBottom: 12,
};

// ── CopyField ──────────────────────────────────────────────────────────────
function CopyField({ value, label, note, masked = false }) {
    const [copied, setCopied]     = useState(false);
    const [revealed, setRevealed] = useState(false);

    const handleCopy = useCallback(() => {
        navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }).catch(() => {});
    }, [value]);

    const display = masked && !revealed ? '•'.repeat(Math.min(value.length, 32)) : value;

    return (
        <div style={{ marginBottom: 14 }}>
            {label && (
                <div style={{
                    fontSize: 11,
                    color: 'rgba(255,255,255,0.55)',
                    marginBottom: 5,
                    fontWeight: 600,
                    letterSpacing: '0.04em',
                    textTransform: 'uppercase',
                }}>
                    {label}
                </div>
            )}
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                    readOnly
                    value={display}
                    className="qx-input"
                    style={{
                        flex: 1,
                        color: masked && !revealed ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.88)',
                        fontFamily: 'monospace',
                        letterSpacing: masked && !revealed ? '0.08em' : undefined,
                    }}
                />
                {masked && (
                    <button
                        type="button"
                        onClick={() => setRevealed(r => !r)}
                        className="qx-btn"
                        aria-label={revealed ? `Hide ${label ?? 'value'}` : `Reveal ${label ?? 'value'}`}
                        title={revealed ? 'Hide' : 'Reveal'}
                    >
                        {revealed ? <EyeOffIcon /> : <EyeIcon />}
                    </button>
                )}
                <button
                    type="button"
                    onClick={handleCopy}
                    className="qx-btn"
                    aria-label={`Copy ${label ?? 'value'} to clipboard`}
                    title="Copy to clipboard"
                    style={{
                        background: copied ? 'rgba(52,211,153,0.1)' : undefined,
                        borderColor: copied ? 'rgba(52,211,153,0.3)' : undefined,
                    }}
                >
                    {copied ? <CheckIcon /> : <CopyIcon />}
                </button>
            </div>
            {note && (
                <p style={{ margin: '5px 0 0', fontSize: 11, color: 'rgba(255,255,255,0.45)', lineHeight: 1.5 }}>
                    {note}
                </p>
            )}
        </div>
    );
}

// ── StepHeading ────────────────────────────────────────────────────────────
function StepHeading({ number, title }) {
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 24,
                height: 24,
                borderRadius: '50%',
                background: 'rgba(168,85,247,0.16)',
                border: '1px solid rgba(168,85,247,0.3)',
                color: 'rgba(200,150,255,0.9)',
                fontSize: 12,
                fontWeight: 700,
                flexShrink: 0,
            }}>
                {number}
            </span>
            <span style={{ fontWeight: 600, fontSize: 14, color: 'rgba(255,255,255,0.82)' }}>
                {title}
            </span>
        </div>
    );
}

// ── Status dot helpers ─────────────────────────────────────────────────────
function statusDotColor(activeSessions, lastSeenAt) {
    if (!lastSeenAt) return 'rgba(255,255,255,0.25)';
    const diffMs = Date.now() - new Date(lastSeenAt).getTime();
    if (diffMs < ACTIVE_SESSION_WINDOW_MS) return 'rgba(52,211,153,0.9)';
    if (diffMs < 3600000) return 'rgba(245,158,11,0.9)';
    return 'rgba(248,113,113,0.85)';
}

// ── Install Steps (expandable) ─────────────────────────────────────────────
function InstallSteps({ orgId, userId }) {
    const [open, setOpen] = useState(false);
    const collectorUrl = `${window.location.protocol}//${window.location.hostname}/collector`;

    return (
        <section className="qx-card" style={{ marginBottom: 16 }}>
            <button
                type="button"
                onClick={() => setOpen(o => !o)}
                style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    cursor: 'pointer',
                }}
            >
                <span style={{ fontSize: 15, fontWeight: 700, color: 'rgba(255,255,255,0.88)' }}>
                    Install in 4 steps
                </span>
                <ChevronDownIcon open={open} />
            </button>

            {open && (
                <div style={{ marginTop: 20 }}>
                    {/* Step 1 */}
                    <div style={{ marginBottom: 20 }}>
                        <StepHeading number="1" title="Download the bundle" />
                        <p style={{ margin: '0 0 12px', fontSize: 13, color: 'rgba(255,255,255,0.7)', lineHeight: 1.6 }}>
                            For zero-typing install, get your{' '}
                            <strong style={{ color: 'rgba(200,150,255,0.9)' }}>personalised bundle</strong>{' '}
                            from Settings → MCP Credentials. It embeds your Org ID, User ID, and service key
                            so you don&apos;t need to paste anything. The generic bundle below requires manually
                            pasting those values during install.
                        </p>
                        <p style={{ margin: '0 0 12px', fontSize: 13, color: 'rgba(255,255,255,0.7)', lineHeight: 1.6 }}>
                            The{' '}
                            <code style={{ background: 'rgba(255,255,255,0.08)', borderRadius: 4, padding: '1px 5px' }}>.mcpb</code>{' '}
                            bundle packages the QuoxMCP server and its manifest in a single file that Claude Desktop can install directly.
                        </p>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                            <Link
                                to="/settings?section=account/mcp-credentials"
                                className="qx-btn qx-btn--primary"
                                style={{ display: 'inline-flex', alignItems: 'center', gap: 8, textDecoration: 'none' }}
                            >
                                <StarIcon />
                                Get personalised bundle
                            </Link>
                            <a
                                href={MCPB_DOWNLOAD_URL}
                                download="quoxmcp.mcpb"
                                className="qx-btn"
                                style={{ display: 'inline-flex', alignItems: 'center', gap: 8, textDecoration: 'none' }}
                            >
                                <DownloadIcon />
                                Generic bundle (manual config)
                            </a>
                        </div>
                    </div>

                    {/* Step 2 */}
                    <div style={{ marginBottom: 20 }}>
                        <StepHeading number="2" title="Open it in Claude Desktop" />
                        <p style={{ margin: 0, fontSize: 13, color: 'rgba(255,255,255,0.7)', lineHeight: 1.7 }}>
                            Double-click the downloaded{' '}
                            <code style={{ background: 'rgba(255,255,255,0.08)', borderRadius: 4, padding: '1px 5px' }}>.mcpb</code>{' '}
                            file. Claude Desktop will open an install dialog.
                        </p>
                        <p style={{ margin: '8px 0 0', fontSize: 12, color: 'rgba(255,255,255,0.45)', lineHeight: 1.6 }}>
                            <strong style={{ color: 'rgba(255,255,255,0.7)' }}>macOS note:</strong>{' '}
                            The first time, right-click → Open if Gatekeeper warns about an unverified developer.
                        </p>
                    </div>

                    {/* Step 3 — only shown for generic bundle users */}
                    <div style={{ marginBottom: 20 }}>
                        <StepHeading number="3" title="Paste these values (generic bundle only)" />
                        <p style={{ margin: '0 0 16px', fontSize: 13, color: 'rgba(255,255,255,0.7)', lineHeight: 1.6 }}>
                            The install dialog will ask for five values. Copy each one below.
                            The <strong style={{ color: 'rgba(255,255,255,0.88)' }}>Org ID</strong> and{' '}
                            <strong style={{ color: 'rgba(255,255,255,0.88)' }}>User ID</strong> are required
                            from v1.2.0 onward for audit trail attribution.
                            If you used the personalised bundle, skip this step.
                        </p>

                        <CopyField
                            label="Collector URL"
                            value={collectorUrl}
                            note="Base URL of this QuoxCORE collector (the install dialog calls this the 'server URL')."
                        />

                        {orgId ? (
                            <CopyField
                                label="Org ID"
                                value={orgId}
                                note="Your organisation's unique identifier, used for audit trail attribution in v1.2.0+."
                            />
                        ) : (
                            <div style={{ marginBottom: 14 }}>
                                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', marginBottom: 5, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                                    Org ID
                                </div>
                                <div style={{ background: 'rgba(245,158,11,0.07)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: 10, padding: '10px 14px', fontSize: 13, color: 'rgba(255,200,80,0.85)', lineHeight: 1.6 }}>
                                    Find this in your dashboard profile. Sign in to see your Org ID here.
                                </div>
                            </div>
                        )}

                        {userId ? (
                            <CopyField
                                label="User ID"
                                value={userId}
                                note="Your account's unique identifier, used for audit trail attribution in v1.2.0+."
                            />
                        ) : (
                            <div style={{ marginBottom: 14 }}>
                                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', marginBottom: 5, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                                    User ID
                                </div>
                                <div style={{ background: 'rgba(245,158,11,0.07)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: 10, padding: '10px 14px', fontSize: 13, color: 'rgba(255,200,80,0.85)', lineHeight: 1.6 }}>
                                    Find this in your dashboard profile. Sign in to see your User ID here.
                                </div>
                            </div>
                        )}

                        <div style={{ marginBottom: 14 }}>
                            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', marginBottom: 5, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                                Service Key
                            </div>
                            <div style={{ background: 'rgba(245,158,11,0.07)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: 10, padding: '12px 14px' }}>
                                <p style={{ margin: '0 0 8px', fontSize: 13, color: 'rgba(255,200,80,0.85)', lineHeight: 1.6 }}>
                                    Find this in your QuoxCORE deployment&apos;s{' '}
                                    <code style={{ background: 'rgba(255,255,255,0.08)', borderRadius: 4, padding: '1px 5px' }}>.env</code> file:
                                </p>
                                <CopyField label="Variable name" value="INTERNAL_SERVICE_KEY" />
                            </div>
                        </div>

                        <CopyField
                            label="Agent ID"
                            value={DEFAULT_AGENT_ID}
                            note="Leave as default unless you have configured specialist RBAC with a custom agent ID."
                        />
                    </div>

                    {/* Step 4 */}
                    <div>
                        <StepHeading number="4" title="Restart Claude Desktop" />
                        <p style={{ margin: 0, fontSize: 13, color: 'rgba(255,255,255,0.7)', lineHeight: 1.7 }}>
                            After install, fully quit Claude Desktop{' '}
                            <span style={{ color: 'rgba(255,255,255,0.45)' }}>(⌘Q on Mac · right-click Quit on Windows)</span>{' '}
                            and relaunch. The{' '}
                            <code style={{ background: 'rgba(255,255,255,0.08)', borderRadius: 4, padding: '1px 5px' }}>quox</code>{' '}
                            server will appear in the{' '}
                            <span style={{ fontFamily: 'monospace', fontSize: 14 }}>🔌</span> tools menu.
                        </p>
                    </div>
                </div>
            )}
        </section>
    );
}

// ── Revoke session confirmation modal ──────────────────────────────────────
function RevokeSessionModal({ session, onClose, onRevoked }) {
    const [busy, setBusy]   = useState(false);
    const [error, setError] = useState(null);

    const handleRevoke = useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(`/api/auth/tokens/mcp/${session.token_id}`, {
                method: 'DELETE',
                credentials: 'include',
            });
            if (res.status === 204 || res.status === 200) {
                onRevoked();
            } else if (res.status === 404) {
                setError('Token already revoked or not found.');
            } else {
                const data = await res.json().catch(() => ({}));
                setError(data.message || data.error || `Server error (${res.status})`);
            }
        } catch {
            setError('Network error. Please try again.');
        } finally {
            setBusy(false);
        }
    }, [session.token_id, onRevoked]);

    // Modal backdrop pattern from MCPCredentialsPanel
    return (
        <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="revoke-session-modal-title"
            onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
            style={{
                position: 'fixed', inset: 0, zIndex: 3000,
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
                <h2
                    id="revoke-session-modal-title"
                    style={{ fontSize: 18, fontWeight: 600, color: 'rgba(248,113,113,0.95)', marginTop: 0, marginBottom: 12 }}
                >
                    Revoke Session
                </h2>
                <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.65)', lineHeight: 1.6, marginBottom: 8 }}>
                    This will disconnect Claude Desktop for this user. They will need to reinstall to continue.
                </p>
                <p style={{ fontSize: 12, fontFamily: 'monospace', color: 'rgba(147,210,255,0.7)', marginBottom: 16 }}>
                    Session: {session.session_id ? session.session_id.slice(0, 16) + '…' : '—'}
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
                    <button
                        type="button"
                        onClick={onClose}
                        disabled={busy}
                        className="qx-btn"
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={handleRevoke}
                        disabled={busy}
                        className="qx-btn qx-btn--danger"
                        aria-label="Revoke session and disconnect Claude Desktop"
                    >
                        {busy ? 'Revoking…' : 'Revoke'}
                    </button>
                </div>
            </div>
        </div>
    );
}

// ── Session detail drawer ──────────────────────────────────────────────────
function SessionDrawer({ session, onClose, onRevoked }) {
    const [calls, setCalls]       = useState([]);
    const [loading, setLoading]   = useState(true);
    const [fetchError, setFetchError] = useState(null);
    const [showRevoke, setShowRevoke] = useState(false);

    // Fetch calls on open
    useEffect(() => {
        if (!session) return;
        setLoading(true);
        setFetchError(null);
        fetch(
            `${COLLECTOR_BASE}/api/v1/mcp/sessions/${encodeURIComponent(session.session_id)}/calls?limit=50`,
            { credentials: 'include', signal: AbortSignal.timeout(10000) }
        )
            .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
            .then(data => setCalls(Array.isArray(data.calls) ? data.calls : []))
            .catch(err => setFetchError(err.message))
            .finally(() => setLoading(false));
    }, [session]);

    // Escape key closes drawer
    useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);

    if (!session) return null;

    const isActive = session.last_seen_at
        ? (Date.now() - new Date(session.last_seen_at).getTime()) < ACTIVE_SESSION_WINDOW_MS
        : false;

    const labelId = 'session-drawer-label';

    function formatCallTime(ts) {
        if (!ts) return '—';
        const d = new Date(ts);
        return d.toTimeString().slice(0, 8);
    }

    return (
        <>
            {/* Backdrop */}
            <div
                onClick={onClose}
                style={{
                    position: 'fixed', inset: 0, zIndex: 1200,
                    background: 'rgba(0,0,0,0.4)',
                }}
            />

            {/* Drawer */}
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby={labelId}
                style={{
                    position: 'fixed',
                    top: 0,
                    right: 0,
                    bottom: 0,
                    width: 480,
                    zIndex: 1300,
                    display: 'flex',
                    flexDirection: 'column',
                    background: 'var(--m-bg-base)',
                    borderLeft: '1px solid rgba(255,255,255,0.12)',
                    boxShadow: '-8px 0 32px rgba(0,0,0,0.4)',
                    transform: 'translateX(0)',
                    transition: 'transform 200ms ease',
                    overflow: 'hidden',
                }}
            >
                {/* Header */}
                <div className="qx-card" style={{
                    borderRadius: 0,
                    borderTop: 'none',
                    borderLeft: 'none',
                    borderRight: 'none',
                    borderBottom: '1px solid rgba(255,255,255,0.1)',
                    flexShrink: 0,
                    padding: '14px 16px',
                }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 10 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <span
                                id={labelId}
                                style={{ fontFamily: 'monospace', fontSize: 13, color: 'rgba(147,210,255,0.85)', wordBreak: 'break-all' }}
                            >
                                {session.session_id ? session.session_id.slice(0, 12) + '…' : '—'}
                            </span>
                        </div>
                        <button
                            type="button"
                            onClick={onClose}
                            className="qx-btn qx-btn--sm"
                            aria-label="Close session detail"
                            style={{ flexShrink: 0, padding: '4px 8px', lineHeight: 1 }}
                        >
                            ✕
                        </button>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        {/* Agent pill */}
                        <span style={{
                            fontSize: 11, fontWeight: 600,
                            color: 'rgba(200,150,255,0.9)',
                            background: 'rgba(168,85,247,0.12)',
                            border: '1px solid rgba(168,85,247,0.25)',
                            borderRadius: 20, padding: '2px 8px',
                        }}>
                            {session.agent_id ?? 'unknown'}
                        </span>

                        {/* Host */}
                        {session.host && (
                            <span style={{
                                fontSize: 11, fontFamily: 'monospace',
                                color: 'rgba(255,255,255,0.55)',
                                background: 'rgba(255,255,255,0.06)',
                                borderRadius: 4, padding: '2px 6px',
                            }}>
                                {session.host}
                            </span>
                        )}

                        {/* Active / Idle badge */}
                        <span style={{
                            fontSize: 11, fontWeight: 600,
                            color: isActive ? 'rgba(52,211,153,0.95)' : 'rgba(245,158,11,0.9)',
                            background: isActive ? 'rgba(52,211,153,0.08)' : 'rgba(245,158,11,0.08)',
                            border: `1px solid ${isActive ? 'rgba(52,211,153,0.25)' : 'rgba(245,158,11,0.25)'}`,
                            borderRadius: 20, padding: '2px 8px',
                        }}>
                            {isActive ? 'Active' : 'Idle'}
                        </span>

                        {/* Revoke button — only if token_id present */}
                        {session.token_id && (
                            <button
                                type="button"
                                onClick={() => setShowRevoke(true)}
                                className="qx-btn qx-btn--danger qx-btn--sm"
                                aria-label="Revoke session and disconnect Claude Desktop"
                                style={{ marginLeft: 'auto' }}
                            >
                                Revoke session
                            </button>
                        )}
                    </div>
                </div>

                {/* Body — calls table */}
                <div style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>
                    {loading && (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '32px 0', gap: 10 }}>
                            <span className="qx-spinner qx-spinner--sm" />
                            <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.45)' }}>Loading…</span>
                        </div>
                    )}

                    {fetchError && !loading && (
                        <div style={{
                            padding: '10px 12px',
                            background: 'rgba(248,113,113,0.07)',
                            border: '1px solid rgba(248,113,113,0.2)',
                            borderRadius: 10,
                            fontSize: 13,
                            color: 'rgba(248,113,113,0.9)',
                        }}>
                            Could not load calls: {fetchError}
                        </div>
                    )}

                    {!loading && !fetchError && calls.length === 0 && (
                        <div className="qx-empty">
                            No tool calls yet for this session.
                        </div>
                    )}

                    {!loading && !fetchError && calls.length > 0 && (
                        <table className="qx-table" style={{ width: '100%' }}>
                            <thead>
                                <tr>
                                    <th>Time</th>
                                    <th>Tool</th>
                                    <th className="qx-num">ms</th>
                                    <th>Result</th>
                                    <th>Args</th>
                                </tr>
                            </thead>
                            <tbody>
                                {calls.map((c, i) => (
                                    <tr key={c.id ?? i}>
                                        <td className="qx-mono" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                                            {formatCallTime(c.ts)}
                                        </td>
                                        <td className="qx-mono" style={{ fontSize: 11 }}>{c.tool_name ?? '—'}</td>
                                        <td className="qx-num" style={{ fontSize: 11 }}>{c.duration_ms ?? '—'}</td>
                                        <td style={{ fontSize: 13, textAlign: 'center' }}>
                                            {c.success ? (
                                                <span style={{ color: 'rgba(52,211,153,0.9)' }}>✓</span>
                                            ) : (
                                                <span style={{ color: 'rgba(248,113,113,0.9)' }}>✗</span>
                                            )}
                                        </td>
                                        <td style={{
                                            fontSize: 11,
                                            color: 'rgba(255,255,255,0.45)',
                                            maxWidth: 160,
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                            whiteSpace: 'nowrap',
                                        }}>
                                            {c.args_summary ?? ''}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            </div>

            {/* Revoke confirmation modal — rendered above the drawer */}
            {showRevoke && (
                <RevokeSessionModal
                    session={session}
                    onClose={() => setShowRevoke(false)}
                    onRevoked={() => {
                        setShowRevoke(false);
                        onRevoked();
                    }}
                />
            )}
        </>
    );
}

// ── Active Sessions Panel ──────────────────────────────────────────────────
function ActiveSessionsPanel({ sessions, onRefresh }) {
    const [selectedSession, setSelectedSession] = useState(null);

    const handleRowClick = useCallback((s) => {
        setSelectedSession(s);
    }, []);

    const handleDrawerClose = useCallback(() => {
        setSelectedSession(null);
    }, []);

    const handleRevoked = useCallback(() => {
        setSelectedSession(null);
        if (onRefresh) onRefresh();
    }, [onRefresh]);

    if (!sessions || sessions.length === 0) {
        return (
            <section className="qx-card" style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
                    <div style={{ ...SECTION_HEADING, marginBottom: 0, flex: 1 }}>Active Sessions</div>
                    <TestConnectionButton collectorUrl={COLLECTOR_BASE} />
                </div>
                <div className="qx-empty">
                    No Claude Desktop activity yet. Install the bundle to get started.
                </div>
            </section>
        );
    }

    const COL_STYLE = {
        padding: '10px 14px',
        fontSize: 12,
        color: 'rgba(255,255,255,0.7)',
        borderBottom: '1px solid rgba(255,255,255,0.05)',
        verticalAlign: 'top',
    };

    const HEADER_STYLE = {
        ...COL_STYLE,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        color: 'rgba(255,255,255,0.45)',
        borderBottom: '1px solid rgba(255,255,255,0.08)',
        padding: '8px 14px',
    };

    return (
        <>
            <section className="qx-card" style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
                    <div style={{ ...SECTION_HEADING, marginBottom: 0, flex: 1 }}>Active Sessions</div>
                    <TestConnectionButton collectorUrl={COLLECTOR_BASE} />
                </div>
                <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead>
                            <tr>
                                {['Session', 'Agent', 'Last seen', 'Host', '24h calls', 'Recent tools'].map(h => (
                                    <th key={h} style={HEADER_STYLE}>{h}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {sessions.map((s, i) => {
                                const recentTools = Array.isArray(s.recent_tools) ? s.recent_tools.slice(0, 3).join(', ') : '—';
                                const isSelected = selectedSession?.session_id === s.session_id;
                                return (
                                    <tr
                                        key={s.session_id ?? i}
                                        onClick={() => handleRowClick(s)}
                                        style={{
                                            background: isSelected
                                                ? 'rgba(147,210,255,0.06)'
                                                : i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)',
                                            cursor: 'pointer',
                                        }}
                                        title="Click to view session detail"
                                    >
                                        <td style={{ ...COL_STYLE, fontFamily: 'monospace', fontSize: 11, color: 'rgba(147,210,255,0.7)' }}>
                                            {s.session_id ? s.session_id.slice(0, 12) + '…' : '—'}
                                        </td>
                                        <td style={COL_STYLE}>{s.agent_id ?? '—'}</td>
                                        <td style={{ ...COL_STYLE, fontFamily: 'monospace', fontSize: 11 }}>
                                            {relativeTime(s.last_seen_at)}
                                        </td>
                                        <td style={{ ...COL_STYLE, fontFamily: 'monospace', fontSize: 11 }}>
                                            {s.host ?? '—'}
                                        </td>
                                        <td style={{ ...COL_STYLE, textAlign: 'right' }}>
                                            {s.calls_24h ?? 0}
                                        </td>
                                        <td style={{ ...COL_STYLE, fontSize: 11, color: 'rgba(255,255,255,0.45)' }}>
                                            {recentTools}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            </section>

            {/* Session detail drawer — portal-style, rendered outside card flow */}
            {selectedSession && (
                <SessionDrawer
                    session={selectedSession}
                    onClose={handleDrawerClose}
                    onRevoked={handleRevoked}
                />
            )}
        </>
    );
}

// ── Tool Catalog ───────────────────────────────────────────────────────────
function ToolCatalog() {
    const [tools, setTools]       = useState([]);
    const [loading, setLoading]   = useState(true);
    const [error, setError]       = useState(null);
    const [query, setQuery]       = useState('');
    const debouncedQuery          = useDebounce(query, 200);

    useEffect(() => {
        setLoading(true);
        setError(null);
        fetch(`${COLLECTOR_BASE}/api/v1/tools/list?agent_id=${DEFAULT_AGENT_ID}`, {
            credentials: 'include',
            signal: AbortSignal.timeout(15000),
        })
            .then(r => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.json();
            })
            .then(data => {
                const list = Array.isArray(data.tools) ? data.tools : [];
                setTools(list);
            })
            .catch(err => setError(err.message))
            .finally(() => setLoading(false));
    }, []);

    const filtered = debouncedQuery
        ? tools.filter(t => {
            const q = debouncedQuery.toLowerCase();
            return (
                (t.name ?? '').toLowerCase().includes(q) ||
                (t.description ?? '').toLowerCase().includes(q)
            );
        })
        : tools;

    // Group by category if available
    const hasCategories = tools.some(t => t.category);
    const groups = hasCategories
        ? filtered.reduce((acc, t) => {
            const cat = t.category || 'Other';
            (acc[cat] = acc[cat] || []).push(t);
            return acc;
        }, {})
        : { '': filtered };

    return (
        <section className="qx-card" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
                <div style={{ ...SECTION_HEADING, marginBottom: 0, flex: 1 }}>
                    Tool Catalog
                </div>
                {!loading && !error && (
                    <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', fontFamily: 'monospace' }}>
                        Showing {filtered.length} of {tools.length}
                    </span>
                )}
            </div>

            {/* Search */}
            <div style={{ marginBottom: 14 }}>
                <input
                    type="search"
                    placeholder="Search tools by name or description…"
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    className="qx-input"
                    style={{ width: '100%', boxSizing: 'border-box' }}
                />
            </div>

            {loading && (
                <div style={{ padding: '16px 0', color: 'rgba(255,255,255,0.45)', fontSize: 13, fontStyle: 'italic' }}>
                    Loading tools…
                </div>
            )}

            {error && !loading && (
                <div style={{
                    padding: '12px 14px',
                    background: 'rgba(248,113,113,0.07)',
                    border: '1px solid rgba(248,113,113,0.2)',
                    borderRadius: 10,
                    fontSize: 13,
                    color: 'rgba(248,113,113,0.9)',
                }}>
                    Could not load tools: {error}
                </div>
            )}

            {!loading && !error && filtered.length === 0 && debouncedQuery && (
                <div style={{ padding: '12px 0', color: 'rgba(255,255,255,0.45)', fontSize: 13 }}>
                    No tools match &ldquo;{debouncedQuery}&rdquo;
                </div>
            )}

            {!loading && !error && (
                Object.entries(groups).map(([cat, items]) => (
                    <div key={cat} style={{ marginBottom: cat ? 16 : 0 }}>
                        {cat && (
                            <div style={{
                                fontSize: 11,
                                fontWeight: 700,
                                color: 'rgba(147,210,255,0.7)',
                                letterSpacing: '0.06em',
                                textTransform: 'uppercase',
                                marginBottom: 6,
                                paddingBottom: 4,
                                borderBottom: '1px solid rgba(255,255,255,0.06)',
                            }}>
                                {cat}
                            </div>
                        )}
                        {items.map((tool, i) => (
                            <div key={tool.name ?? i} style={{
                                display: 'flex',
                                alignItems: 'baseline',
                                gap: 10,
                                padding: '6px 0',
                                borderBottom: i < items.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none',
                            }}>
                                <span style={{
                                    fontFamily: 'monospace',
                                    fontSize: 12,
                                    color: 'rgba(147,210,255,0.8)',
                                    flexShrink: 0,
                                    minWidth: 200,
                                }}>
                                    {tool.name}
                                </span>
                                <span style={{
                                    fontSize: 12,
                                    color: 'rgba(255,255,255,0.55)',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                    flex: 1,
                                }}>
                                    {tool.description ?? ''}
                                </span>
                                {tool.category && !hasCategories && (
                                    <span style={{
                                        fontSize: 10,
                                        fontWeight: 600,
                                        color: 'rgba(168,85,247,0.8)',
                                        background: 'rgba(168,85,247,0.08)',
                                        borderRadius: 10,
                                        padding: '1px 7px',
                                        flexShrink: 0,
                                    }}>
                                        {tool.category}
                                    </span>
                                )}
                            </div>
                        ))}
                    </div>
                ))
            )}
        </section>
    );
}

// ── Resources ──────────────────────────────────────────────────────────────
function ResourcesPanel() {
    const [resources, setResources] = useState([]);
    const [loading, setLoading]     = useState(true);
    const [error, setError]         = useState(null);

    useEffect(() => {
        fetch(`${COLLECTOR_BASE}/api/v1/resources/list`, {
            credentials: 'include',
            signal: AbortSignal.timeout(10000),
        })
            .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
            .then(data => setResources(Array.isArray(data.resources) ? data.resources : []))
            .catch(err => setError(err.message))
            .finally(() => setLoading(false));
    }, []);

    return (
        <section className="qx-card" style={{ marginBottom: 16 }}>
            <div style={SECTION_HEADING}>Resources ({loading ? '…' : resources.length})</div>

            {loading && <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 13, fontStyle: 'italic' }}>Loading resources…</div>}
            {error && !loading && (
                <div style={{ padding: '10px 12px', background: 'rgba(248,113,113,0.07)', border: '1px solid rgba(248,113,113,0.2)', borderRadius: 10, fontSize: 13, color: 'rgba(248,113,113,0.9)' }}>
                    Could not load resources: {error}
                </div>
            )}

            {!loading && !error && resources.length === 0 && (
                <div className="qx-empty">
                    No resources available yet. They&apos;ll appear once the collector populates them.
                </div>
            )}

            {!loading && !error && resources.length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
                    {resources.map((r, i) => (
                        <div key={r.uri ?? i} style={{
                            background: 'var(--m-bg-base)',
                            border: '1px solid var(--m-border-default)',
                            borderRadius: 'var(--qx-radius)',
                            padding: '14px 16px',
                        }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.88)', marginBottom: 4 }}>
                                {r.name ?? r.title ?? r.uri}
                            </div>
                            {r.description && (
                                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)', lineHeight: 1.5, marginBottom: 8 }}>
                                    {r.description}
                                </div>
                            )}
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                                {r.mimeType && (
                                    <span style={{ fontSize: 10, fontWeight: 600, color: 'rgba(147,210,255,0.7)', background: 'rgba(147,210,255,0.08)', borderRadius: 10, padding: '1px 7px' }}>
                                        {r.mimeType}
                                    </span>
                                )}
                                {r.uri && (
                                    <span style={{ fontSize: 10, fontFamily: 'monospace', color: 'rgba(255,255,255,0.45)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>
                                        {r.uri}
                                    </span>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </section>
    );
}

// ── Prompts ────────────────────────────────────────────────────────────────
function PromptsPanel() {
    const [prompts, setPrompts]   = useState([]);
    const [loading, setLoading]   = useState(true);
    const [error, setError]       = useState(null);
    const [copied, setCopied]     = useState(null);

    useEffect(() => {
        fetch(`${COLLECTOR_BASE}/api/v1/prompts/list`, {
            credentials: 'include',
            signal: AbortSignal.timeout(10000),
        })
            .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
            .then(data => setPrompts(Array.isArray(data.prompts) ? data.prompts : []))
            .catch(err => setError(err.message))
            .finally(() => setLoading(false));
    }, []);

    const handleCopyTemplate = useCallback((prompt, idx) => {
        // Use first message text if available, else the description, else the name
        const text = prompt.messages?.[0]?.content?.text
            ?? prompt.messages?.[0]?.content
            ?? prompt.description
            ?? prompt.name
            ?? '';
        navigator.clipboard.writeText(typeof text === 'string' ? text : JSON.stringify(text))
            .then(() => {
                setCopied(idx);
                setTimeout(() => setCopied(null), 2000);
            })
            .catch(() => {});
    }, []);

    return (
        <section className="qx-card" style={{ marginBottom: 16 }}>
            <div style={SECTION_HEADING}>Prompts ({loading ? '…' : prompts.length})</div>

            {loading && <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 13, fontStyle: 'italic' }}>Loading prompts…</div>}
            {error && !loading && (
                <div style={{ padding: '10px 12px', background: 'rgba(248,113,113,0.07)', border: '1px solid rgba(248,113,113,0.2)', borderRadius: 10, fontSize: 13, color: 'rgba(248,113,113,0.9)' }}>
                    Could not load prompts: {error}
                </div>
            )}

            {!loading && !error && prompts.length === 0 && (
                <div className="qx-empty">
                    No prompts available yet. They&apos;ll appear once the collector populates them.
                </div>
            )}

            {!loading && !error && prompts.length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
                    {prompts.map((p, i) => {
                        const args = Array.isArray(p.arguments) ? p.arguments : [];
                        return (
                            <div key={p.name ?? i} style={{
                                background: 'var(--m-bg-base)',
                                border: '1px solid var(--m-border-default)',
                                borderRadius: 'var(--qx-radius)',
                                padding: '14px 16px',
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 8,
                            }}>
                                <div style={{ fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.88)' }}>
                                    {p.name ?? p.title ?? `Prompt ${i + 1}`}
                                </div>
                                {p.description && (
                                    <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)', lineHeight: 1.5 }}>
                                        {p.description}
                                    </div>
                                )}
                                {args.length > 0 && (
                                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                                        {args.map(a => (
                                            <span key={a.name ?? a} style={{
                                                fontSize: 10,
                                                fontFamily: 'monospace',
                                                color: 'rgba(147,210,255,0.7)',
                                                background: 'rgba(147,210,255,0.08)',
                                                borderRadius: 4,
                                                padding: '2px 6px',
                                            }}>
                                                {a.name ?? a}
                                                {a.required ? ' *' : ''}
                                            </span>
                                        ))}
                                    </div>
                                )}
                                <button
                                    type="button"
                                    onClick={() => handleCopyTemplate(p, i)}
                                    aria-label={`Copy template for ${p.name ?? `Prompt ${i + 1}`} to clipboard`}
                                    className="qx-btn"
                                    style={{
                                        alignSelf: 'flex-start',
                                        background: copied === i ? 'rgba(52,211,153,0.1)' : undefined,
                                        borderColor: copied === i ? 'rgba(52,211,153,0.3)' : undefined,
                                        color: copied === i ? 'rgba(52,211,153,0.9)' : undefined,
                                    }}
                                >
                                    {copied === i ? <CheckIcon /> : <CopyIcon />}
                                    {copied === i ? 'Copied!' : 'Copy template'}
                                </button>
                            </div>
                        );
                    })}
                </div>
            )}
        </section>
    );
}

// ── Footer ─────────────────────────────────────────────────────────────────
function FooterSection() {
    const linkStyle = {
        color: 'rgba(147,210,255,0.7)',
        fontSize: 12,
        textDecoration: 'underline',
        textDecorationColor: 'rgba(147,210,255,0.2)',
    };

    return (
        <section className="qx-card" style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 12,
        }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                <a href={GITHUB_REPO_URL} target="_blank" rel="noopener noreferrer" style={linkStyle}>GitHub</a>
                <a href={GITHUB_ISSUES_URL} target="_blank" rel="noopener noreferrer" style={linkStyle}>Issues</a>
                <a href={RELEASE_NOTES_URL} target="_blank" rel="noopener noreferrer" style={linkStyle}>Releases</a>
                <a href={MCP_SPEC_URL} target="_blank" rel="noopener noreferrer" style={linkStyle}>MCP Specification</a>
                <Link to="/settings?section=account/mcp-credentials" style={linkStyle}>
                    Manage MCP credentials in Settings &rarr;
                </Link>
            </div>
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', fontFamily: 'monospace' }}>
                QuoxMCP v{MCP_VERSION} · Bundle 3.2MB · Bundled in MCPB format
            </span>
        </section>
    );
}

// ── Main View ──────────────────────────────────────────────────────────────
export default function QuoxMCPView() {
    const { user }         = useAuth();
    const { currentOrg }   = useWorkspace() || {};

    const userId = user?.id         ?? null;
    const orgId  = currentOrg?.id   ?? null;

    // Sessions are fetched in HeroSection and passed down via a shared
    // state lifted here so ActiveSessionsPanel can display them without
    // a second independent poll. refreshTick bumps to trigger a re-fetch
    // after a revoke action.
    const [sessions, setSessions]   = useState([]);
    const [refreshTick, setRefreshTick] = useState(0);

    const onSessionsUpdate = useCallback((s) => setSessions(s), []);
    const onSessionsRefresh = useCallback(() => setRefreshTick(t => t + 1), []);

    return (
        <MCPViewErrorBoundary>
            <div className="qx-view">
                <div style={{ maxWidth: 1100, margin: '0 auto', width: '100%', boxSizing: 'border-box' }}>
                    <div className="qx-stack">
                        <HeroSectionWithSessionSync
                            orgId={orgId}
                            userId={userId}
                            onSessionsUpdate={onSessionsUpdate}
                            refreshTick={refreshTick}
                        />
                        <InstallSteps
                            orgId={orgId}
                            userId={userId}
                        />
                        <ActiveSessionsPanel sessions={sessions} onRefresh={onSessionsRefresh} />
                        <ToolCatalog />
                        <ResourcesPanel />
                        <PromptsPanel />
                        <FooterSection />
                    </div>
                </div>
            </div>
        </MCPViewErrorBoundary>
    );
}

// ── HeroSectionWithSessionSync ─────────────────────────────────────────────
// Wrapper that also propagates sessions upward so ActiveSessionsPanel avoids
// a second /api/v1/mcp/status request.
function HeroSectionWithSessionSync({ orgId, userId, onSessionsUpdate, refreshTick }) {
    const [summary, setSummary]         = useState(null);
    const [statusError, setStatusError] = useState(null);
    const mountedRef                    = useRef(true);
    const failCountRef                  = useRef(0);

    useEffect(() => {
        mountedRef.current = true;

        const fetchStatus = async () => {
            try {
                const params = new URLSearchParams();
                if (orgId)  params.set('org_id', orgId);
                if (userId) params.set('user_id', userId);
                const res = await fetch(
                    `/collector/api/v1/mcp/status?${params}`,
                    { credentials: 'include', signal: AbortSignal.timeout(8000) }
                );
                if (!mountedRef.current) return;
                if (res.ok) {
                    const data = await res.json();
                    failCountRef.current = 0;
                    setStatusError(null);
                    const newSummary  = data.summary ?? null;
                    const newSessions = Array.isArray(data.sessions) ? data.sessions : [];
                    setSummary(newSummary);
                    onSessionsUpdate(newSessions);
                } else {
                    failCountRef.current += 1;
                    if (failCountRef.current >= 3) {
                        setStatusError('Could not reach collector status endpoint. Sessions counter may be stale.');
                    }
                }
            } catch {
                // Network error counts as a failure
                failCountRef.current += 1;
                if (mountedRef.current && failCountRef.current >= 3) {
                    setStatusError('Could not reach collector status endpoint. Sessions counter may be stale.');
                }
            }
        };

        fetchStatus();

        // Pause polling when the tab is backgrounded — resume on visibility.
        let interval = setInterval(fetchStatus, STATUS_POLL_MS);

        const handleVisibilityChange = () => {
            if (document.hidden) {
                clearInterval(interval);
            } else {
                fetchStatus();
                interval = setInterval(fetchStatus, STATUS_POLL_MS);
            }
        };

        document.addEventListener('visibilitychange', handleVisibilityChange);

        return () => {
            mountedRef.current = false;
            clearInterval(interval);
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, [orgId, userId, onSessionsUpdate, refreshTick]);

    const activeSessions = summary?.active_sessions ?? 0;
    const totalCalls     = summary?.total_calls_24h ?? 0;
    const lastSeenAt     = summary?.last_seen_at ?? null;
    const dotColor       = statusDotColor(activeSessions, lastSeenAt);

    return (
        <section className="qx-card">
            {statusError && (
                <div style={{
                    marginBottom: 12,
                    padding: '8px 12px',
                    background: 'rgba(245,158,11,0.07)',
                    border: '1px solid rgba(245,158,11,0.2)',
                    borderRadius: 10,
                    fontSize: 12,
                    color: 'rgba(255,200,80,0.85)',
                }}>
                    {statusError}
                </div>
            )}
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 14 }}>
                <div style={{ flex: 1, minWidth: 260 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                        <h1 style={{
                            margin: 0,
                            fontSize: 24,
                            fontWeight: 700,
                            color: 'rgba(255,255,255,0.95)',
                            letterSpacing: '-0.02em',
                        }}>
                            QuoxMCP
                        </h1>
                        <span style={{
                            fontSize: 11,
                            fontWeight: 600,
                            color: 'rgba(200,150,255,0.9)',
                            background: 'rgba(168,85,247,0.12)',
                            border: '1px solid rgba(168,85,247,0.25)',
                            borderRadius: 20,
                            padding: '2px 8px',
                            letterSpacing: '0.02em',
                        }}>
                            Claude Desktop integration
                        </span>
                    </div>
                    <p style={{ margin: '0 0 14px', fontSize: 13, color: 'rgba(255,255,255,0.7)', lineHeight: 1.6 }}>
                        130+ infrastructure tools, 5 live resources, 4 operational prompts, for any Claude Desktop user in your org.
                    </p>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        {/* Primary CTA: personalised bundle */}
                        <Link
                            to="/settings?section=account/mcp-credentials"
                            className="qx-btn qx-btn--primary"
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 8, textDecoration: 'none' }}
                        >
                            <StarIcon />
                            Get personalised bundle
                        </Link>
                        {/* Secondary: generic GitHub download */}
                        <a
                            href={MCPB_DOWNLOAD_URL}
                            download="quoxmcp.mcpb"
                            className="qx-btn"
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 8, textDecoration: 'none' }}
                        >
                            <DownloadIcon />
                            Generic bundle (v{MCP_VERSION})
                        </a>
                        <a
                            href={RELEASE_NOTES_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 5,
                                fontSize: 13,
                                color: 'rgba(255,255,255,0.55)',
                                textDecoration: 'underline',
                                textDecorationColor: 'rgba(255,255,255,0.2)',
                            }}
                        >
                            View release notes
                            <ExternalLinkIcon />
                        </a>
                    </div>
                    <p style={{ margin: '8px 0 0', fontSize: 12, color: 'rgba(255,255,255,0.35)' }}>
                        Latest release: v{MCP_VERSION},{' '}
                        <a href={GITHUB_REPO_URL} target="_blank" rel="noopener noreferrer"
                            style={{ color: 'rgba(147,210,255,0.7)', textDecoration: 'underline' }}>
                            GitHub repo
                        </a>
                    </p>
                </div>

                {/* Status badges */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 200, flexShrink: 0 }}>
                    <div style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '8px 12px',
                        background: 'var(--m-bg-base)',
                        border: '1px solid var(--m-border-default)',
                        borderRadius: 10,
                    }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: dotColor, flexShrink: 0 }} />
                        <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)' }}>Active sessions:</span>
                        <span style={{ fontSize: 13, fontWeight: 700, color: 'rgba(255,255,255,0.95)', marginLeft: 'auto' }}>
                            {activeSessions}
                        </span>
                    </div>
                    <div style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '8px 12px',
                        background: 'var(--m-bg-base)',
                        border: '1px solid var(--m-border-default)',
                        borderRadius: 10,
                    }}>
                        <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)' }}>Total calls today:</span>
                        <span style={{ fontSize: 13, fontWeight: 700, color: 'rgba(255,255,255,0.95)', marginLeft: 'auto' }}>
                            {totalCalls.toLocaleString()}
                        </span>
                    </div>
                    <div style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '8px 12px',
                        background: 'var(--m-bg-base)',
                        border: '1px solid var(--m-border-default)',
                        borderRadius: 10,
                    }}>
                        <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)' }}>Last call:</span>
                        <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)', marginLeft: 'auto', fontFamily: 'monospace' }}>
                            {lastSeenAt ? relativeTime(lastSeenAt) : 'Never'}
                        </span>
                    </div>
                </div>
            </div>
        </section>
    );
}
