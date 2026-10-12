/**
 * ClaudeDesktopInstall — Settings panel for connecting Claude Desktop
 * via the QuoxMCP bundle (.mcpb).
 *
 * Shows:
 *  - Last Seen status badge (polls /api/v1/mcp/status every 30s)
 *  - Download button for quoxmcp.mcpb (latest release)
 *  - Step-by-step install instructions
 *  - Copyable values: Collector URL, Org ID, User ID, Service Key (placeholder), Agent ID
 *  - Test Connection button (hits /api/v1/tools/list?agent_id=quox)
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { Link } from 'react-router-dom';
import SettingsSection from './SettingsSection';
import SettingsCard from './SettingsCard';
import TestConnectionButton from '../mcp/TestConnectionButton';
import './settings.css';

const MCPB_DOWNLOAD_URL = 'https://github.com/quoxai/quoxmcp/releases/latest/download/quoxmcp.mcpb';
const RELEASE_NOTES_URL  = 'https://github.com/quoxai/quoxmcp/releases/latest';
const DEFAULT_AGENT_ID   = 'quox';
const MCP_STATUS_POLL_MS = 30000;

// Derive the collector base URL from the browser origin using the same
// pattern as AgentFleetPanel (relative nginx proxy path).
function getCollectorBaseUrl() {
    if (typeof window === 'undefined') return 'http://localhost:9848';
    if (import.meta.env.VITE_COLLECTOR_URL) return import.meta.env.VITE_COLLECTOR_URL;
    return `${window.location.protocol}//${window.location.hostname}:9848`;
}

// ── Icons ──────────────────────────────────────────────────────────────────
const DownloadIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" strokeWidth="2"
        strokeLinecap="round" strokeLinejoin="round"
        style={{ stroke: 'rgba(255,255,255,0.9)' }}>
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
);

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

const EyeIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" strokeWidth="2"
        strokeLinecap="round" strokeLinejoin="round"
        style={{ stroke: 'rgba(255,255,255,0.5)' }}>
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
        <circle cx="12" cy="12" r="3" />
    </svg>
);

const EyeOffIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" strokeWidth="2"
        strokeLinecap="round" strokeLinejoin="round"
        style={{ stroke: 'rgba(255,255,255,0.5)' }}>
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
        <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
        <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
);

// ── CopyField — read-only input with copy button ───────────────────────────
function CopyField({ value, masked = false, label, note }) {
    const [copied, setCopied]     = useState(false);
    const [revealed, setRevealed] = useState(false);

    const handleCopy = useCallback(() => {
        navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }).catch(() => {});
    }, [value]);

    const displayValue = masked && !revealed
        ? '•'.repeat(Math.min(value.length, 32))
        : value;

    return (
        <div style={{ marginBottom: 16 }}>
            <div style={{
                fontSize: 12,
                color: 'rgba(255,255,255,0.55)',
                marginBottom: 6,
                fontWeight: 500,
                letterSpacing: '0.03em',
                textTransform: 'uppercase',
            }}>
                {label}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                    readOnly
                    value={displayValue}
                    style={{
                        flex: 1,
                        background: 'rgba(255,255,255,0.05)',
                        border: '1px solid rgba(255,255,255,0.12)',
                        borderRadius: 6,
                        padding: '8px 12px',
                        color: masked && !revealed ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.9)',
                        fontSize: 13,
                        fontFamily: 'monospace',
                        outline: 'none',
                        letterSpacing: masked && !revealed ? '0.1em' : undefined,
                    }}
                />
                {masked && (
                    <button
                        type="button"
                        onClick={() => setRevealed(r => !r)}
                        style={{
                            background: 'rgba(255,255,255,0.06)',
                            border: '1px solid rgba(255,255,255,0.12)',
                            borderRadius: 6,
                            padding: '8px 10px',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                        }}
                        title={revealed ? 'Hide' : 'Reveal'}
                    >
                        {revealed ? <EyeOffIcon /> : <EyeIcon />}
                    </button>
                )}
                <button
                    type="button"
                    onClick={handleCopy}
                    style={{
                        background: copied ? 'rgba(52,211,153,0.12)' : 'rgba(255,255,255,0.06)',
                        border: `1px solid ${copied ? 'rgba(52,211,153,0.35)' : 'rgba(255,255,255,0.12)'}`,
                        borderRadius: 6,
                        padding: '8px 10px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        transition: 'background 0.15s, border-color 0.15s',
                    }}
                    title="Copy to clipboard"
                >
                    {copied ? <CheckIcon /> : <CopyIcon />}
                </button>
            </div>
            {note && (
                <p style={{ margin: '6px 0 0', fontSize: 12, color: 'rgba(255,255,255,0.4)', lineHeight: 1.5 }}>
                    {note}
                </p>
            )}
        </div>
    );
}

// ── Step header ────────────────────────────────────────────────────────────
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
                background: 'rgba(99,179,237,0.18)',
                border: '1px solid rgba(99,179,237,0.35)',
                color: 'rgba(147,210,255,0.9)',
                fontSize: 12,
                fontWeight: 700,
                flexShrink: 0,
            }}>
                {number}
            </span>
            <span style={{ fontWeight: 600, fontSize: 14, color: 'rgba(255,255,255,0.85)' }}>
                {title}
            </span>
        </div>
    );
}

// ── Last Seen Badge ────────────────────────────────────────────────────────
function getStatusAppearance(lastSeenAt, totalCalls) {
    if (!lastSeenAt) {
        return {
            label: 'No Claude Desktop activity yet',
            color: 'rgba(255,255,255,0.45)',
            bg: 'rgba(255,255,255,0.06)',
            border: 'rgba(255,255,255,0.12)',
            dot: 'rgba(255,255,255,0.3)',
        };
    }
    const diffMs  = Date.now() - new Date(lastSeenAt).getTime();
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffMs / 60000);
    const diffH   = Math.floor(diffMs / 3600000);
    const diffD   = Math.floor(diffMs / 86400000);

    if (diffMs < 5 * 60 * 1000) {
        return {
            label: `Connected, last call ${diffSec}s ago`,
            color: 'rgba(52,211,153,0.95)',
            bg: 'rgba(52,211,153,0.08)',
            border: 'rgba(52,211,153,0.25)',
            dot: 'rgba(52,211,153,0.9)',
        };
    }
    if (diffMs < 60 * 60 * 1000) {
        return {
            label: `Idle, last call ${diffMin}m ago`,
            color: 'rgba(245,158,11,0.95)',
            bg: 'rgba(245,158,11,0.08)',
            border: 'rgba(245,158,11,0.25)',
            dot: 'rgba(245,158,11,0.9)',
        };
    }
    const timeLabel = diffD >= 1
        ? `${diffD}d ago`
        : `${diffH}h ago`;
    return {
        label: `Disconnected, last seen ${timeLabel}`,
        color: 'rgba(248,113,113,0.95)',
        bg: 'rgba(248,113,113,0.08)',
        border: 'rgba(248,113,113,0.25)',
        dot: 'rgba(248,113,113,0.9)',
    };
}

function LastSeenBadge({ orgId, userId, collectorUrl }) {
    const [summary, setSummary] = useState(null);
    const [loading, setLoading] = useState(true);
    const mountedRef = useRef(true);

    useEffect(() => {
        mountedRef.current = true;

        const fetchStatus = async () => {
            try {
                const params = new URLSearchParams();
                if (orgId)  params.set('org_id',  orgId);
                if (userId) params.set('user_id', userId);
                const res = await fetch(
                    `${collectorUrl}/api/v1/mcp/status?${params}`,
                    { signal: AbortSignal.timeout(8000) }
                );
                if (!mountedRef.current) return;
                if (res.ok) {
                    const data = await res.json();
                    setSummary(data.summary ?? null);
                }
            } catch {
                // Non-fatal — badge stays in last known state
            } finally {
                if (mountedRef.current) setLoading(false);
            }
        };

        fetchStatus();
        const interval = setInterval(fetchStatus, MCP_STATUS_POLL_MS);
        return () => {
            mountedRef.current = false;
            clearInterval(interval);
        };
    }, [collectorUrl, orgId, userId]);

    if (loading) {
        return (
            <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.35)', fontStyle: 'italic' }}>
                Checking connection&hellip;
            </span>
        );
    }

    const lastSeenAt = summary?.last_seen_at ?? null;
    const totalCalls = summary?.total_calls_24h ?? 0;
    const { label, color, bg, border, dot } = getStatusAppearance(lastSeenAt, totalCalls);

    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 10px',
                background: bg,
                border: `1px solid ${border}`,
                borderRadius: 20,
                fontSize: 12,
                fontWeight: 500,
                color,
            }}>
                <span style={{
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    background: dot,
                    flexShrink: 0,
                }} />
                {label}
            </span>
            {lastSeenAt && totalCalls > 0 && (
                <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)' }}>
                    ({totalCalls} call{totalCalls !== 1 ? 's' : ''} today)
                </span>
            )}
        </div>
    );
}

// ── Main component ─────────────────────────────────────────────────────────
export default function ClaudeDesktopInstall() {
    const collectorUrl = getCollectorBaseUrl();
    const { user }        = useAuth();
    const { currentOrg }  = useWorkspace() || {};

    const userId = user?.id   ?? null;
    const orgId  = currentOrg?.id ?? null;

    return (
        <SettingsSection
            title="Connect Claude Desktop"
            description="Install the QuoxMCP bundle to expose 130+ infrastructure tools, 5 resources, and 4 operational prompts directly inside Claude Desktop."
        >
            {/* MCPB-HARDEN-2F deprecation notice for v1.2.x manual installs */}
            <div style={{
                marginBottom: 16,
                padding: '10px 14px',
                background: 'rgba(251,191,36,0.07)',
                border: '1px solid rgba(251,191,36,0.25)',
                borderRadius: 6,
                fontSize: 13,
                color: 'rgba(251,191,36,0.92)',
                lineHeight: 1.5,
            }}>
                <strong>Security update (2026-05-01):</strong> per-user MCP credentials replaced
                the shared service key. If you installed Claude Desktop before this date, please
                visit{' '}
                <Link to="/settings?section=account/mcp-credentials"
                    style={{ color: 'rgba(251,191,36,0.95)', textDecoration: 'underline' }}>
                    MCP Credentials
                </Link>{' '}
                and download a personalised bundle, one click, no fields to paste.
            </div>

            {/* Link to the dedicated QuoxMCP dashboard page */}
            <div style={{ marginBottom: 16 }}>
                <Link
                    to="/quoxmcp"
                    style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        fontSize: 13,
                        color: 'rgba(147,210,255,0.8)',
                        textDecoration: 'none',
                        borderBottom: '1px solid rgba(147,210,255,0.25)',
                        paddingBottom: 1,
                    }}
                >
                    Open dashboard page →
                </Link>
            </div>

            {/* Connection status badge */}
            <SettingsCard title="Connection Status" glass>
                <LastSeenBadge
                    orgId={orgId}
                    userId={userId}
                    collectorUrl={collectorUrl}
                />
            </SettingsCard>

            {/* Step 1 — Download */}
            <SettingsCard title="Step 1: Download the bundle" glass>
                <p style={{ margin: '0 0 16px', fontSize: 13, color: 'rgba(255,255,255,0.65)', lineHeight: 1.6 }}>
                    The <code style={{ background: 'rgba(255,255,255,0.08)', borderRadius: 4, padding: '1px 5px' }}>.mcpb</code> bundle
                    packages the QuoxMCP server and its manifest in a single file that Claude Desktop can install directly.
                    The URL below always points to the latest release, no need to re-download for minor updates.
                </p>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                    <a
                        href={MCPB_DOWNLOAD_URL}
                        download="quoxmcp.mcpb"
                        style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 8,
                            padding: '9px 18px',
                            background: 'rgba(99,179,237,0.15)',
                            border: '1px solid rgba(99,179,237,0.4)',
                            borderRadius: 7,
                            color: 'rgba(147,210,255,0.95)',
                            fontSize: 14,
                            fontWeight: 600,
                            textDecoration: 'none',
                            transition: 'background 0.15s',
                        }}
                    >
                        <DownloadIcon />
                        Download quoxmcp.mcpb
                    </a>
                    <a
                        href={RELEASE_NOTES_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ fontSize: 13, color: 'rgba(255,255,255,0.45)', textDecoration: 'underline' }}
                    >
                        View release notes
                    </a>
                </div>
            </SettingsCard>

            {/* Step 2 — Open */}
            <SettingsCard title="Step 2: Open it" glass>
                <p style={{ margin: 0, fontSize: 13, color: 'rgba(255,255,255,0.65)', lineHeight: 1.7 }}>
                    Double-click the downloaded{' '}
                    <code style={{ background: 'rgba(255,255,255,0.08)', borderRadius: 4, padding: '1px 5px' }}>.mcpb</code>{' '}
                    file. Claude Desktop will open an install dialog.
                </p>
                <p style={{ margin: '10px 0 0', fontSize: 12, color: 'rgba(255,255,255,0.45)', lineHeight: 1.6 }}>
                    <strong style={{ color: 'rgba(255,255,255,0.6)' }}>macOS note:</strong>{' '}
                    The first time, right-click → Open if Gatekeeper warns about an unverified developer.
                </p>
            </SettingsCard>

            {/* Step 3 — Values */}
            <SettingsCard title="Step 3: Paste these values" glass>
                <p style={{ margin: '0 0 20px', fontSize: 13, color: 'rgba(255,255,255,0.65)', lineHeight: 1.6 }}>
                    The install dialog will ask for five values. Copy each one below. The{' '}
                    <strong style={{ color: 'rgba(255,255,255,0.8)' }}>Org ID</strong> and{' '}
                    <strong style={{ color: 'rgba(255,255,255,0.8)' }}>User ID</strong> are required
                    from v1.2.0 onward for audit trail attribution.
                </p>

                <CopyField
                    label="Collector URL"
                    value={collectorUrl}
                    note="Base URL of this QuoxCORE collector (the install dialog calls this the 'server URL')."
                />

                {/* Org ID */}
                {orgId ? (
                    <CopyField
                        label="Org ID"
                        value={orgId}
                        note="Your organisation's unique identifier, used for audit trail attribution in v1.2.0+."
                    />
                ) : (
                    <div style={{ marginBottom: 16 }}>
                        <div style={{
                            fontSize: 12,
                            color: 'rgba(255,255,255,0.55)',
                            marginBottom: 6,
                            fontWeight: 500,
                            letterSpacing: '0.03em',
                            textTransform: 'uppercase',
                        }}>
                            Org ID
                        </div>
                        <div style={{
                            background: 'rgba(245,158,11,0.07)',
                            border: '1px solid rgba(245,158,11,0.25)',
                            borderRadius: 6,
                            padding: '10px 14px',
                            fontSize: 13,
                            color: 'rgba(255,200,80,0.85)',
                            lineHeight: 1.6,
                        }}>
                            Find this in your dashboard profile. Sign in to see your Org ID here.
                        </div>
                    </div>
                )}

                {/* User ID */}
                {userId ? (
                    <CopyField
                        label="User ID"
                        value={userId}
                        note="Your account's unique identifier, used for audit trail attribution in v1.2.0+."
                    />
                ) : (
                    <div style={{ marginBottom: 16 }}>
                        <div style={{
                            fontSize: 12,
                            color: 'rgba(255,255,255,0.55)',
                            marginBottom: 6,
                            fontWeight: 500,
                            letterSpacing: '0.03em',
                            textTransform: 'uppercase',
                        }}>
                            User ID
                        </div>
                        <div style={{
                            background: 'rgba(245,158,11,0.07)',
                            border: '1px solid rgba(245,158,11,0.25)',
                            borderRadius: 6,
                            padding: '10px 14px',
                            fontSize: 13,
                            color: 'rgba(255,200,80,0.85)',
                            lineHeight: 1.6,
                        }}>
                            Find this in your dashboard profile. Sign in to see your User ID here.
                        </div>
                    </div>
                )}

                {/* Service Key — no endpoint exists yet; show .env placeholder */}
                <div style={{ marginBottom: 16 }}>
                    <div style={{
                        fontSize: 12,
                        color: 'rgba(255,255,255,0.55)',
                        marginBottom: 6,
                        fontWeight: 500,
                        letterSpacing: '0.03em',
                        textTransform: 'uppercase',
                    }}>
                        Service Key
                    </div>
                    <div style={{
                        background: 'rgba(245,158,11,0.07)',
                        border: '1px solid rgba(245,158,11,0.25)',
                        borderRadius: 6,
                        padding: '12px 14px',
                    }}>
                        <p style={{ margin: '0 0 8px', fontSize: 13, color: 'rgba(255,200,80,0.85)', lineHeight: 1.6 }}>
                            Find this in your QuoxCORE deployment&apos;s <code style={{ background: 'rgba(255,255,255,0.08)', borderRadius: 4, padding: '1px 5px' }}>.env</code> file:
                        </p>
                        <CopyField
                            label="Variable name"
                            value="INTERNAL_SERVICE_KEY"
                            note="Copy the value of this variable from your collector .env and paste it into the install dialog."
                        />
                    </div>
                </div>

                <CopyField
                    label="Agent ID"
                    value={DEFAULT_AGENT_ID}
                    note="Leave as default unless you have configured specialist RBAC with a custom agent ID."
                />

                {/* Test Connection */}
                <TestConnectionButton collectorUrl={collectorUrl} />
            </SettingsCard>

            {/* Step 4 — Restart */}
            <SettingsCard title="Step 4: Restart Claude Desktop" glass>
                <p style={{ margin: 0, fontSize: 13, color: 'rgba(255,255,255,0.65)', lineHeight: 1.7 }}>
                    After install, fully quit Claude Desktop{' '}
                    <span style={{ color: 'rgba(255,255,255,0.45)' }}>(⌘Q on Mac · right-click Quit on Windows)</span>{' '}
                    and relaunch. The{' '}
                    <code style={{ background: 'rgba(255,255,255,0.08)', borderRadius: 4, padding: '1px 5px' }}>quox</code>{' '}
                    server will appear in the{' '}
                    <span style={{ fontFamily: 'monospace', fontSize: 14 }}>🔌</span> tools menu.
                </p>
            </SettingsCard>
        </SettingsSection>
    );
}
