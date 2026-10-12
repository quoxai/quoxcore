/**
 * VaultLeasesView — QuoxVault Credential Leases
 *
 * Full lease management: pending requests, active leases with countdown,
 * and history of expired/revoked/denied leases.
 */

import { useState, useEffect, useCallback } from 'react';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { csrfFetch } from '../../utils/csrfFetch';
import { VAULT_LEASES, VAULT_LEASE_APPROVE, VAULT_LEASE_DENY, VAULT_LEASE_REVOKE } from '../../config/apiPaths';
import '../../components/vault/vault.css';

const clockIcon = (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <polyline points="12 6 12 12 16 14"/>
    </svg>
);

const ENFORCEMENT_BANNER = {
    off: {
        variant: 'warn',
        title: 'Lease enforcement: off',
        text: 'Credential leases are advisory-only for this org — access is never blocked or audited on missing leases.'
    },
    advisory: {
        variant: 'info',
        title: 'Lease enforcement: advisory',
        text: 'Missing an active lease does not block access yet — it is logged to the vault activity feed.'
    },
    enforced: {
        variant: 'success',
        title: 'Lease enforcement: enforced',
        text: 'Agents without an active lease are refused access to lease-required credentials.'
    }
};

function EnforcementModeBanner({ mode }) {
    const info = ENFORCEMENT_BANNER[mode];
    if (!info) return null;
    return (
        <div className={`qx-banner qx-banner--${info.variant}`} role="status" data-testid="lease-enforcement-banner">
            <span className="qx-banner__title">{info.title}</span>
            <span>{info.text}</span>
        </div>
    );
}

const STATUS_LABELS = {
    pending: 'Pending',
    active: 'Active',
    expired: 'Expired',
    revoked: 'Revoked',
    denied: 'Denied',
    cancelled: 'Cancelled'
};

const STATUS_COLORS = {
    pending: '#f59e0b',
    active: '#22c55e',
    expired: '#6b7280',
    revoked: '#ef4444',
    denied: '#ef4444',
    cancelled: '#6b7280'
};

function formatTimeRemaining(expiresAt) {
    if (!expiresAt) return '—';
    const diff = new Date(expiresAt).getTime() - Date.now();
    if (diff <= 0) return 'Expired';
    const mins = Math.floor(diff / 60000);
    const hrs = Math.floor(mins / 60);
    if (hrs > 0) return `${hrs}h ${mins % 60}m`;
    return `${mins}m`;
}

function formatDate(dateStr) {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
}

function LeaseCard({ lease, onApprove, onDeny, onRevoke }) {
    const isPending = lease.status === 'pending';
    const isActive = lease.status === 'active';

    return (
        <div className="vault-lease-card" data-status={lease.status}>
            <div className="vault-lease-card__header">
                <span
                    className="vault-lease-card__status"
                    style={{ color: STATUS_COLORS[lease.status], borderColor: STATUS_COLORS[lease.status] }}
                >
                    {STATUS_LABELS[lease.status]}
                </span>
                <span className="vault-lease-card__agent">{lease.requested_by_agent_id}</span>
            </div>

            <div className="vault-lease-card__body">
                <div className="vault-lease-card__field">
                    <span className="vault-lease-card__label">Credential</span>
                    <span className="vault-lease-card__value">{lease.credential_id?.slice(0, 12)}...</span>
                </div>
                {lease.justification && (
                    <div className="vault-lease-card__field">
                        <span className="vault-lease-card__label">Justification</span>
                        <span className="vault-lease-card__value">{lease.justification}</span>
                    </div>
                )}
                {isActive && (
                    <>
                        <div className="vault-lease-card__field">
                            <span className="vault-lease-card__label">Time remaining</span>
                            <span className="vault-lease-card__value vault-lease-card__countdown">
                                {formatTimeRemaining(lease.expires_at)}
                            </span>
                        </div>
                        <div className="vault-lease-card__field">
                            <span className="vault-lease-card__label">Uses</span>
                            <span className="vault-lease-card__value">
                                {lease.use_count}{lease.max_uses ? ` / ${lease.max_uses}` : ''}
                            </span>
                        </div>
                    </>
                )}
                <div className="vault-lease-card__field">
                    <span className="vault-lease-card__label">Requested</span>
                    <span className="vault-lease-card__value">{formatDate(lease.requested_at || lease.created_at)}</span>
                </div>
                {lease.granted_at && (
                    <div className="vault-lease-card__field">
                        <span className="vault-lease-card__label">Granted</span>
                        <span className="vault-lease-card__value">{formatDate(lease.granted_at)}</span>
                    </div>
                )}
            </div>

            <div className="vault-lease-card__actions">
                {isPending && onApprove && (
                    <>
                        <button className="vault-btn vault-btn--sm vault-btn--primary" onClick={() => onApprove(lease)}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>
                            Approve
                        </button>
                        <button className="vault-btn vault-btn--sm vault-btn--danger" onClick={() => onDeny(lease)}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                            Deny
                        </button>
                    </>
                )}
                {isActive && onRevoke && (
                    <button className="vault-btn vault-btn--sm vault-btn--danger" onClick={() => onRevoke(lease)}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                        Revoke
                    </button>
                )}
            </div>
        </div>
    );
}

export default function VaultLeasesView() {
    const { currentOrg } = useWorkspace();
    const orgId = currentOrg?.id;
    const [leases, setLeases] = useState([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState('all');
    const [approveModal, setApproveModal] = useState(null);
    const [duration, setDuration] = useState(60);
    // VAULT-P5.M — sourced from the same GET .../vault/leases response the
    // list already fetches (no new endpoint); server-side truth only, never
    // claim a mode the backend isn't actually enforcing.
    const [enforcementMode, setEnforcementMode] = useState(null);

    const fetchLeases = useCallback(async () => {
        if (!orgId) { setLoading(false); return; }
        try {
            const params = filter !== 'all' ? `?status=${filter}` : '';
            const res = await fetch(`${VAULT_LEASES(orgId)}${params}`, { credentials: 'include' });
            if (res.ok) {
                const data = await res.json();
                setLeases(data.leases || []);
                setEnforcementMode(data.enforcement_mode || null);
            }
        } catch (err) {
            console.error('Failed to fetch leases:', err);
        } finally {
            setLoading(false);
        }
    }, [orgId, filter]);

    useEffect(() => {
        fetchLeases();
        // Auto-refresh every 30s for active lease countdowns
        const interval = setInterval(fetchLeases, 30000);
        return () => clearInterval(interval);
    }, [fetchLeases]);

    const handleApprove = useCallback(async () => {
        if (!approveModal || !orgId) return;
        try {
            const res = await csrfFetch(VAULT_LEASE_APPROVE(orgId, approveModal.id), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ duration_minutes: duration })
            });
            if (res.ok) {
                setApproveModal(null);
                fetchLeases();
            }
        } catch (err) {
            console.error('Failed to approve lease:', err);
        }
    }, [approveModal, orgId, duration, fetchLeases]);

    const handleDeny = useCallback(async (lease) => {
        if (!orgId) return;
        try {
            await csrfFetch(VAULT_LEASE_DENY(orgId, lease.id), {
                method: 'POST'
            });
            fetchLeases();
        } catch (err) {
            console.error('Failed to deny lease:', err);
        }
    }, [orgId, fetchLeases]);

    const handleRevoke = useCallback(async (lease) => {
        if (!orgId) return;
        try {
            await csrfFetch(VAULT_LEASE_REVOKE(orgId, lease.id), {
                method: 'POST'
            });
            fetchLeases();
        } catch (err) {
            console.error('Failed to revoke lease:', err);
        }
    }, [orgId, fetchLeases]);

    const pendingCount = leases.filter(l => l.status === 'pending').length;
    const activeCount = leases.filter(l => l.status === 'active').length;

    return (
        <div className="vault-page">
            <div className="vault-page__header">
                <div className="vault-page__title-row">
                    <span className="vault-page__icon">{clockIcon}</span>
                    <h1 className="vault-page__title">Credential Leases</h1>
                    {pendingCount > 0 && (
                        <span className="vault-lease-badge vault-lease-badge--pending">{pendingCount} pending</span>
                    )}
                    {activeCount > 0 && (
                        <span className="vault-lease-badge vault-lease-badge--active">{activeCount} active</span>
                    )}
                </div>
            </div>

            <EnforcementModeBanner mode={enforcementMode} />

            {/* Filter tabs */}
            <div className="vault-lease-filters">
                {['all', 'pending', 'active', 'expired', 'revoked', 'denied'].map(f => (
                    <button
                        key={f}
                        className={`vault-lease-filter ${filter === f ? 'vault-lease-filter--active' : ''}`}
                        onClick={() => { setFilter(f); setLoading(true); }}
                    >
                        {f === 'all' ? 'All' : STATUS_LABELS[f]}
                    </button>
                ))}
            </div>

            {/* Lease list */}
            {loading ? (
                <div className="vault-placeholder__text">Loading leases...</div>
            ) : leases.length === 0 ? (
                <div className="vault-placeholder">
                    <div className="vault-placeholder__icon">
                        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.3">
                            <circle cx="12" cy="12" r="10"/>
                            <polyline points="12 6 12 12 16 14"/>
                        </svg>
                    </div>
                    <h2 className="vault-placeholder__title">No leases found</h2>
                    <p className="vault-placeholder__text">
                        {filter === 'all'
                            ? 'Credential leases will appear here when agents request JIT access to lease-required credentials.'
                            : `No ${filter} leases.`}
                    </p>
                </div>
            ) : (
                <div className="vault-lease-grid">
                    {leases.map(lease => (
                        <LeaseCard
                            key={lease.id}
                            lease={lease}
                            onApprove={(l) => { setApproveModal(l); setDuration(60); }}
                            onDeny={handleDeny}
                            onRevoke={handleRevoke}
                        />
                    ))}
                </div>
            )}

            {/* Approve modal */}
            {approveModal && (
                <div className="vault-modal-overlay" onClick={() => setApproveModal(null)}>
                    <div className="vault-modal" onClick={e => e.stopPropagation()}>
                        <h3 className="vault-modal__title">Approve Lease Request</h3>
                        <p style={{ color: 'var(--ui-text-secondary)', fontSize: '14px', margin: '8px 0 16px' }}>
                            Agent <strong>{approveModal.requested_by_agent_id}</strong> requests credential access.
                        </p>
                        {approveModal.justification && (
                            <p style={{ color: 'var(--ui-text-secondary)', fontSize: '13px', fontStyle: 'italic', margin: '0 0 16px', padding: '8px 12px', background: 'var(--ui-bg-secondary)', borderRadius: '6px' }}>
                                "{approveModal.justification}"
                            </p>
                        )}
                        <div className="vault-form-field">
                            <label className="vault-form-field__label">Lease duration</label>
                            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                                {[15, 30, 60, 120].map(d => (
                                    <button
                                        key={d}
                                        className={`vault-btn vault-btn--sm ${duration === d ? 'vault-btn--primary' : 'vault-btn--secondary'}`}
                                        onClick={() => setDuration(d)}
                                    >
                                        {d < 60 ? `${d}m` : `${d / 60}h`}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '16px' }}>
                            <button className="vault-btn vault-btn--secondary" onClick={() => setApproveModal(null)}>Cancel</button>
                            <button className="vault-btn vault-btn--primary" onClick={handleApprove}>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>
                                Approve for {duration < 60 ? `${duration}m` : `${duration / 60}h`}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
