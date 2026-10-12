/**
 * VaultDashboardView — QuoxVault Dashboard
 *
 * Overview page at /vault showing vault health, credential stats,
 * type breakdown, recent activity, and expiring alerts.
 * Composes existing widgets into a full-page dashboard layout.
 */

import { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useVaultHealth, useVaultActivity } from '../../hooks/useVaultHealth';
import { useVaultCredentials } from '../../hooks/useVaultCredentials';
import { useConnectorStatus } from '../../hooks/useConnectorStatus';
import { INTEGRATION_TYPES } from '../../config/integrationTypes';
import '../../components/vault/vault.css';

const shieldIcon = (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
        <rect x="9" y="10" width="6" height="5" rx="1"/>
        <path d="M10 10V8a2 2 0 0 1 4 0v2"/>
    </svg>
);

const scanIcon = (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="23 4 23 10 17 10"/>
        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
    </svg>
);

function formatTimeAgo(dateStr) {
    if (!dateStr) return '';
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    return `${Math.floor(days / 30)}mo ago`;
}

const HEALTH_COLORS = {
    healthy: '#4ade80',
    failed: '#f87171',
    untested: '#6b7280',
    stale: '#fbbf24',
    expiring: '#fb923c',
    rotationOverdue: '#f59e0b'
};

const HEALTH_LABELS = {
    healthy: 'Healthy',
    failed: 'Failed',
    untested: 'Untested',
    stale: 'Stale',
    expiring: 'Expiring',
    rotationOverdue: 'Overdue'
};

function HealthStatCard({ status, count, total }) {
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    return (
        <div className="vault-stat-card">
            <div className="vault-stat-card__dot" style={{ backgroundColor: HEALTH_COLORS[status] }} />
            <div className="vault-stat-card__info">
                <span className="vault-stat-card__count">{count}</span>
                <span className="vault-stat-card__label">{HEALTH_LABELS[status]}</span>
            </div>
            <span className="vault-stat-card__pct">{pct}%</span>
        </div>
    );
}

function TypeBreakdownChart({ breakdown, total }) {
    if (!breakdown?.length || total === 0) return null;

    return (
        <div className="vault-type-chart">
            <div className="vault-type-chart__bar">
                {breakdown.map((item) => {
                    const pct = (item.count / total) * 100;
                    if (pct < 1) return null;
                    const color = INTEGRATION_TYPES[item.integration_type]?.color || '#6b7280';
                    return (
                        <div
                            key={item.integration_type}
                            title={`${item.integration_type}: ${item.count}`}
                            className="vault-type-chart__segment"
                            style={{ width: `${pct}%`, backgroundColor: color }}
                        />
                    );
                })}
            </div>
            <div className="vault-type-chart__legend">
                {breakdown.map((item) => {
                    const color = INTEGRATION_TYPES[item.integration_type]?.color || '#6b7280';
                    const name = INTEGRATION_TYPES[item.integration_type]?.name || item.integration_type;
                    return (
                        <div key={item.integration_type} className="vault-type-chart__legend-item">
                            <div className="vault-type-chart__legend-dot" style={{ backgroundColor: color }} />
                            <span className="vault-type-chart__legend-name">{name}</span>
                            <span className="vault-type-chart__legend-count">{item.count}</span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

const ACTION_META = {
    'integration.create': { label: 'Created', color: '#4ade80' },
    'integration.update': { label: 'Updated', color: '#38bdf8' },
    'integration.delete': { label: 'Deleted', color: '#f87171' },
    'integration.test': { label: 'Tested', color: '#a78bfa' },
    'integration.access': { label: 'Accessed', color: '#fbbf24' },
    'integration.set_default': { label: 'Set default', color: '#38bdf8' },
    'integration.rotate': { label: 'Rotated', color: '#22d3ee' }
};

function RecentActivity({ events }) {
    if (!events?.length) {
        return <div className="vault-empty-state">No vault activity yet</div>;
    }

    return (
        <div className="vault-activity-list">
            {events.slice(0, 10).map((event, i) => {
                const meta = ACTION_META[event.action] || { label: event.action, color: '#6b7280' };
                let metadata = {};
                try { metadata = JSON.parse(event.metadata_json || '{}'); } catch { /* ignore */ }
                const detail = metadata.integration_type || metadata.label || '';
                return (
                    <div key={event.id || i} className="vault-activity-item">
                        <span className="vault-activity-item__action" style={{ color: meta.color }}>
                            {meta.label}
                        </span>
                        {detail && <span className="vault-activity-item__detail">{detail}</span>}
                        <span className="vault-activity-item__time">{formatTimeAgo(event.created_at)}</span>
                    </div>
                );
            })}
        </div>
    );
}

const CONNECTOR_ICONS = {
    github: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ color: 'rgba(255,255,255,0.85)' }}>
            <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.17 6.839 9.49.5.09.682-.217.682-.482 0-.237-.009-.866-.013-1.7-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.464-1.11-1.464-.908-.62.069-.607.069-.607 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0 1 12 6.836c.85.004 1.705.115 2.504.337 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.167 22 16.418 22 12c0-5.523-4.477-10-10-10z" fill="currentColor"/>
        </svg>
    ),
    jira: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ color: '#2684FF' }}>
            <path d="M11.53 2c0 2.4 1.97 4.35 4.35 4.35h1.78v1.7c0 2.4 1.97 4.35 4.35 4.35V2.84A.84.84 0 0 0 21.17 2H11.53z" fill="currentColor" opacity="0.6"/>
            <path d="M6.77 6.8a4.36 4.36 0 0 0 4.34 4.34h1.78v1.72a4.36 4.36 0 0 0 4.35 4.34V7.63a.84.84 0 0 0-.84-.84H6.77z" fill="currentColor" opacity="0.8"/>
            <path d="M2 11.6a4.36 4.36 0 0 0 4.35 4.35h1.78v1.71c0 2.4 1.97 4.35 4.35 4.35V12.43a.84.84 0 0 0-.84-.84H2z" fill="currentColor"/>
        </svg>
    ),
    notion: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ color: 'rgba(255,255,255,0.85)' }}>
            <path d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L18.06 2.1c-.42-.326-.98-.7-2.055-.607L3.01 2.74c-.466.047-.56.28-.373.466l1.822.979zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.84-.046.933-.56.933-1.167V6.354c0-.606-.233-.933-.746-.886l-15.177.886c-.56.047-.747.327-.747.934zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.607.327-1.167.514-1.634.514-.747 0-.933-.234-1.494-.934l-4.577-7.186v6.952l1.447.327s0 .84-1.167.84l-3.22.187c-.092-.187 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.234 4.764 7.28v-6.44l-1.214-.14c-.093-.514.28-.886.747-.933l3.221-.187zM2.877 1.16l13.589-.84c1.681-.14 2.1.187 2.8.7l3.876 2.707c.466.326.606.746.606 1.306v14.93c0 .932-.373 1.632-1.68 1.726l-15.458.933c-.98.047-1.447-.093-1.96-.746L1.56 18.22c-.56-.747-.793-1.307-.793-1.96V2.88c0-.84.373-1.587 2.11-1.72z" fill="currentColor"/>
        </svg>
    ),
    linear: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ color: '#5E6AD2' }}>
            <path d="M2.513 12.833a9.98 9.98 0 0 0 2.143 4.006l7.69-7.69A.67.67 0 0 1 13 9.62v3.044a.67.67 0 0 1-.195.473l-5.6 5.6a9.96 9.96 0 0 0 4.607 1.26c5.523 0 10-4.477 10-10 0-5.522-4.477-10-10-10-5.522 0-10 4.478-10 10 0 1.15.195 2.254.554 3.283l5.355-5.355a.67.67 0 0 1 .946 0l.946.946a.67.67 0 0 1 0 .946l-7.1 7.1z" fill="currentColor"/>
        </svg>
    ),
};

const CATEGORY_LABELS = {
    developer: 'Developer',
    project_management: 'Project Management',
    knowledge: 'Knowledge Base',
};

function ConnectorStatusCard({ bridge, tools, loading }) {
    if (loading) {
        return (
            <div className="vault-card">
                <div className="vault-card__header">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M18 20V10"/>
                        <path d="M12 20V4"/>
                        <path d="M6 20v-6"/>
                    </svg>
                    <span className="vault-card__title">Connectors</span>
                </div>
                <div className="vault-empty-state">Loading...</div>
            </div>
        );
    }

    const registeredCount = bridge?.registeredConnectors || 0;
    const pooledCount = bridge?.pool?.totalInstances || 0;

    // Group tools by connector
    const byConnector = {};
    for (const tool of tools) {
        if (!byConnector[tool.connector]) {
            byConnector[tool.connector] = {
                id: tool.connector,
                name: tool.connectorName,
                category: tool.category,
                tools: [],
            };
        }
        byConnector[tool.connector].tools.push(tool);
    }
    const activeConnectors = Object.values(byConnector);
    const registeredIds = ['github', 'jira', 'notion', 'linear'];
    const inactiveIds = registeredIds.filter(id => !byConnector[id]);

    return (
        <div className="vault-card">
            <div className="vault-card__header">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3"/>
                    <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/>
                </svg>
                <span className="vault-card__title">Connectors</span>
                <span className="vault-card__badge">{tools.length} tools</span>
            </div>

            {/* Summary row */}
            <div style={{
                display: 'flex', gap: '16px', marginBottom: '12px',
                fontSize: '11px', color: 'var(--text-secondary, #a1a1aa)',
                textTransform: 'uppercase', letterSpacing: '0.06em',
            }}>
                <span>{registeredCount} registered</span>
                <span style={{ color: activeConnectors.length > 0 ? '#4ade80' : 'inherit' }}>
                    {activeConnectors.length} active
                </span>
                {pooledCount > 0 && <span>{pooledCount} pooled</span>}
            </div>

            {/* Active connectors with credentials */}
            {activeConnectors.map(conn => (
                <div key={conn.id} className="vault-connector-row">
                    <div className="vault-connector-row__icon">
                        {CONNECTOR_ICONS[conn.id] || ''}
                    </div>
                    <div className="vault-connector-row__info">
                        <span className="vault-connector-row__name">{conn.name}</span>
                        <span className="vault-connector-row__meta">
                            {conn.tools.length} tools {CATEGORY_LABELS[conn.category] ? `· ${CATEGORY_LABELS[conn.category]}` : ''}
                        </span>
                    </div>
                    <span className="vault-connector-row__status vault-connector-row__status--active">Active</span>
                </div>
            ))}

            {/* Inactive connectors (no credentials) */}
            {inactiveIds.map(id => {
                const names = { github: 'GitHub', jira: 'Jira', notion: 'Notion', linear: 'Linear' };
                return (
                    <div key={id} className="vault-connector-row vault-connector-row--inactive">
                        <div className="vault-connector-row__icon" style={{ opacity: 0.4 }}>
                            {CONNECTOR_ICONS[id] || ''}
                        </div>
                        <div className="vault-connector-row__info">
                            <span className="vault-connector-row__name">{names[id]}</span>
                            <span className="vault-connector-row__meta">No credentials in vault</span>
                        </div>
                        <span className="vault-connector-row__status vault-connector-row__status--inactive">—</span>
                    </div>
                );
            })}

            {tools.length === 0 && activeConnectors.length === 0 && (
                <div className="vault-empty-state" style={{ fontSize: '12px', padding: '8px 0' }}>
                    Add connector credentials to the vault to activate tools
                </div>
            )}
        </div>
    );
}

function ExpiringCredentials({ credentials }) {
    const expiring = useMemo(() => {
        const now = Date.now();
        const in30d = now + 30 * 24 * 60 * 60 * 1000;
        return credentials
            .filter(c => c.expires_at && new Date(c.expires_at).getTime() < in30d)
            .sort((a, b) => new Date(a.expires_at) - new Date(b.expires_at));
    }, [credentials]);

    if (!expiring.length) return null;

    return (
        <div className="vault-card">
            <div className="vault-card__header">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fb923c" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                    <line x1="12" y1="9" x2="12" y2="13"/>
                    <line x1="12" y1="17" x2="12.01" y2="17"/>
                </svg>
                <span className="vault-card__title">Expiring Soon</span>
                <span className="vault-card__badge vault-card__badge--warning">{expiring.length}</span>
            </div>
            <div className="vault-expiry-list">
                {expiring.slice(0, 5).map(cred => {
                    const daysLeft = Math.max(0, Math.ceil((new Date(cred.expires_at) - Date.now()) / (1000 * 60 * 60 * 24)));
                    return (
                        <div key={cred.id} className="vault-expiry-item">
                            <span className="vault-expiry-item__label">{cred.label || cred.integration_type}</span>
                            <span className={`vault-expiry-item__days ${daysLeft <= 7 ? 'vault-expiry-item__days--critical' : ''}`}>
                                {daysLeft === 0 ? 'Today' : `${daysLeft}d`}
                            </span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

/**
 * CertificateExpiryCard — VAULT-AUDIT P7
 * Cert-specific view of upcoming expiry: only credential_kind === 'tls_cert'
 * rows with an expires_at set. Sourced from the same credentials list
 * (GET vault credentials) already fetched for the dashboard — no new endpoint.
 */
function CertificateExpiryCard({ credentials }) {
    const certs = useMemo(() => {
        return credentials
            .filter(c => c.credential_kind === 'tls_cert' && c.expires_at)
            .sort((a, b) => new Date(a.expires_at) - new Date(b.expires_at));
    }, [credentials]);

    if (!certs.length) return null;

    return (
        <div className="vault-card">
            <div className="vault-card__header">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                    <path d="M9 12l2 2 4-4"/>
                </svg>
                <span className="vault-card__title">Certificate Expiry</span>
                <span className="vault-card__badge vault-card__badge--warning">{certs.length}</span>
            </div>
            <div className="vault-expiry-list">
                {certs.slice(0, 5).map(cred => {
                    const isExpired = new Date(cred.expires_at) < new Date();
                    const daysLeft = Math.max(0, Math.ceil((new Date(cred.expires_at) - Date.now()) / (1000 * 60 * 60 * 24)));
                    return (
                        <div key={cred.id} className="vault-expiry-item">
                            <span className="vault-expiry-item__label">{cred.label || cred.integration_type}</span>
                            <span className={`vault-expiry-item__days ${isExpired || daysLeft <= 7 ? 'vault-expiry-item__days--critical' : ''}`}>
                                {isExpired ? 'Expired' : daysLeft === 0 ? 'Today' : `${daysLeft}d`}
                            </span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

// Matches the backend health scanner's STALE_THRESHOLD_DAYS (services/auth/
// services/credentialHealthScanner.js) — presentation-only mirror, the
// server remains authoritative for the real stale/health-scan verdict.
const SESSION_STALE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * SessionStalenessCard — VAULT-AUDIT P7
 * Surfaces web_login credentials (session-backed logins) that haven't been
 * used in 30+ days, or have never been used. Sourced from the same
 * credentials list already fetched for the dashboard.
 */
function SessionStalenessCard({ credentials }) {
    const staleSessions = useMemo(() => {
        const now = Date.now();
        return credentials.filter(c => {
            if (c.credential_kind !== 'web_login') return false;
            if (!c.last_used_at) return true;
            return (now - new Date(c.last_used_at).getTime()) > SESSION_STALE_THRESHOLD_MS;
        });
    }, [credentials]);

    if (!staleSessions.length) return null;

    return (
        <div className="vault-card">
            <div className="vault-card__header">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"/>
                    <polyline points="12 6 12 12 16 14"/>
                </svg>
                <span className="vault-card__title">Session Staleness</span>
                <span className="vault-card__badge vault-card__badge--warning">{staleSessions.length}</span>
            </div>
            <div className="vault-expiry-list">
                {staleSessions.slice(0, 5).map(cred => (
                    <div key={cred.id} className="vault-expiry-item">
                        <span className="vault-expiry-item__label">{cred.label || cred.integration_type}</span>
                        <span className="vault-expiry-item__days">
                            {cred.last_used_at ? formatTimeAgo(cred.last_used_at) : 'Never used'}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
}

const HEALTH_ISSUE_LABELS = {
    stale: 'Stale',
    failed_test: 'Test Failed',
    untested: 'Untested',
    no_default: 'No Default',
    expired: 'Expired',
    expiring: 'Expiring',
    rotation_overdue: 'Rotation Overdue',
};

const HEALTH_SEVERITY_BADGE = {
    error: 'vault-badge--error',
    warning: 'vault-badge--warning',
    info: 'vault-badge--success',
};

/**
 * HealthScanFlagsCard — VAULT-AUDIT P7
 * Surfaces every issue the health scan flagged (POST vault/health-scan),
 * not just expiry/staleness — failed tests, untested creds, no-default
 * types, rotation overdue. Previously computed by useVaultHealth() but
 * never rendered on the dashboard.
 */
function HealthScanFlagsCard({ issues, scanning }) {
    if (!issues?.length) {
        if (scanning) {
            return (
                <div className="vault-card">
                    <div className="vault-card__header">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                        </svg>
                        <span className="vault-card__title">Health Scan Flags</span>
                    </div>
                    <div className="vault-empty-state">Scanning...</div>
                </div>
            );
        }
        return null;
    }

    return (
        <div className="vault-card">
            <div className="vault-card__header">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                    <line x1="12" y1="9" x2="12" y2="13"/>
                    <line x1="12" y1="17" x2="12.01" y2="17"/>
                </svg>
                <span className="vault-card__title">Health Scan Flags</span>
                <span className="vault-card__badge vault-card__badge--warning">{issues.length}</span>
            </div>
            <div className="vault-expiry-list">
                {issues.slice(0, 8).map((issue, i) => (
                    <div key={issue.credentialId || `${issue.type}-${issue.issue}-${i}`} className="vault-expiry-item">
                        <span className="vault-expiry-item__label">{issue.label || issue.type}</span>
                        <span className={`vault-badge ${HEALTH_SEVERITY_BADGE[issue.severity] || ''}`}>
                            {HEALTH_ISSUE_LABELS[issue.issue] || issue.issue}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
}

export default function VaultDashboardView() {
    const navigate = useNavigate();
    const { stats, issues, loading: statsLoading, runScan, scanning } = useVaultHealth();
    const { events, loading: activityLoading } = useVaultActivity({ limit: 10 });
    const { credentials, loading: credsLoading } = useVaultCredentials();
    const { bridge, tools: connectorTools, loading: connectorsLoading } = useConnectorStatus();

    // VAULT-AUDIT P7: proactively surface health-scan flags (failed tests,
    // rotation overdue, no-default types, etc.) instead of requiring the
    // user to click "Health Scan" first. Reuses the existing POST
    // health-scan endpoint — no new endpoint added.
    useEffect(() => {
        runScan();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    if (statsLoading && credsLoading) {
        return (
            <div className="vault-dashboard">
                <div className="vault-dashboard__header">
                    <div className="vault-dashboard__title-row">
                        <span className="vault-dashboard__icon">{shieldIcon}</span>
                        <h1 className="vault-dashboard__title">QuoxVault</h1>
                    </div>
                </div>
                <div className="vault-dashboard__loading">Loading vault data...</div>
            </div>
        );
    }

    const total = stats?.total || 0;
    const healthy = stats?.healthy || 0;
    const failed = stats?.failed || 0;
    const untested = stats?.untested || 0;
    const stale = stats?.stale || 0;
    const expiring = stats?.expiring || 0;

    return (
        <div className="vault-dashboard">
            {/* Header */}
            <div className="vault-dashboard__header">
                <div className="vault-dashboard__title-row">
                    <span className="vault-dashboard__icon">{shieldIcon}</span>
                    <h1 className="vault-dashboard__title">QuoxVault</h1>
                    <span className="vault-dashboard__badge">AES-256-GCM</span>
                </div>
                <div className="vault-dashboard__actions">
                    <button
                        className="vault-btn vault-btn--secondary"
                        onClick={runScan}
                        disabled={scanning}
                    >
                        <span className={scanning ? 'vault-spin' : ''}>
                            {scanIcon}
                        </span>
                        {scanning ? 'Scanning...' : 'Health Scan'}
                    </button>
                    <button
                        className="vault-btn vault-btn--secondary"
                        onClick={() => navigate('/vault/browse')}
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
                            <rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" />
                        </svg>
                        Browse Integrations
                    </button>
                    <button
                        className="vault-btn vault-btn--primary"
                        onClick={() => navigate('/vault/credentials')}
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <line x1="12" y1="5" x2="12" y2="19"/>
                            <line x1="5" y1="12" x2="19" y2="12"/>
                        </svg>
                        Add Credential
                    </button>
                </div>
            </div>

            {/* Stats Grid */}
            <div className="vault-dashboard__stats">
                <div className="vault-card vault-card--highlight">
                    <div className="vault-card__big-number">{total}</div>
                    <div className="vault-card__big-label">Total Credentials</div>
                </div>
                <HealthStatCard status="healthy" count={healthy} total={total} />
                <HealthStatCard status="failed" count={failed} total={total} />
                <HealthStatCard status="untested" count={untested} total={total} />
                {stale > 0 && <HealthStatCard status="stale" count={stale} total={total} />}
                {expiring > 0 && <HealthStatCard status="expiring" count={expiring} total={total} />}
            </div>

            {/* Main Content Grid */}
            <div className="vault-dashboard__grid">
                {/* Type Breakdown */}
                <div className="vault-card">
                    <div className="vault-card__header">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="18" y1="20" x2="18" y2="10"/>
                            <line x1="12" y1="20" x2="12" y2="4"/>
                            <line x1="6" y1="20" x2="6" y2="14"/>
                        </svg>
                        <span className="vault-card__title">By Type</span>
                    </div>
                    <TypeBreakdownChart breakdown={stats?.typeBreakdown} total={total} />
                    {(!stats?.typeBreakdown?.length) && (
                        <div className="vault-empty-state">No credentials stored yet</div>
                    )}
                </div>

                {/* Connector Status */}
                <ConnectorStatusCard bridge={bridge} tools={connectorTools} loading={connectorsLoading} />

                {/* Recent Activity */}
                <div className="vault-card">
                    <div className="vault-card__header">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                        </svg>
                        <span className="vault-card__title">Recent Activity</span>
                        <button
                            className="vault-card__link"
                            onClick={() => navigate('/vault/activity')}
                        >
                            View All
                        </button>
                    </div>
                    {activityLoading ? (
                        <div className="vault-empty-state">Loading...</div>
                    ) : (
                        <RecentActivity events={events} />
                    )}
                </div>

                {/* Expiring Credentials */}
                <ExpiringCredentials credentials={credentials} />

                {/* VAULT-AUDIT P7 — kind-aware health cards */}
                <CertificateExpiryCard credentials={credentials} />
                <SessionStalenessCard credentials={credentials} />
                <HealthScanFlagsCard issues={issues} scanning={scanning} />

                {/* Quick Actions */}
                <div className="vault-card">
                    <div className="vault-card__header">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
                        </svg>
                        <span className="vault-card__title">Quick Actions</span>
                    </div>
                    <div className="vault-quick-actions">
                        <button className="vault-quick-action" onClick={() => navigate('/vault/credentials')}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
                            </svg>
                            Manage Credentials
                        </button>
                        <button className="vault-quick-action" onClick={() => navigate('/vault/folders')}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                            </svg>
                            Organize Folders
                        </button>
                        <button className="vault-quick-action" onClick={() => navigate('/vault/leases')}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <circle cx="12" cy="12" r="10"/>
                                <polyline points="12 6 12 12 16 14"/>
                            </svg>
                            View Leases
                        </button>
                    </div>
                </div>

                {/* Usage Stats */}
                {stats?.totalUseCount > 0 && (
                    <div className="vault-card">
                        <div className="vault-card__header">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                            </svg>
                            <span className="vault-card__title">Usage</span>
                        </div>
                        <div className="vault-usage-summary">
                            <div className="vault-usage-summary__count">{stats.totalUseCount.toLocaleString()}</div>
                            <div className="vault-usage-summary__label">total API calls</div>
                            {stats.mostUsed && (
                                <div className="vault-usage-summary__top">
                                    Top: <strong>{stats.mostUsed.label}</strong> ({stats.mostUsed.use_count} uses)
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
