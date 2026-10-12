/**
 * VaultHealthWidget — QuoxVault Phase 2
 *
 * Compact dashboard card showing vault health at a glance.
 * Shows credential count, health breakdown, last scan time.
 * Clicking navigates to /vault.
 */

import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useVaultHealth } from '../../hooks/useVaultHealth';

const shieldIcon = (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
    </svg>
);

const scanIcon = (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="23 4 23 10 17 10"/>
        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
    </svg>
);

function HealthDot({ status, count }) {
    const colors = {
        healthy: '#4ade80',
        failed: '#f87171',
        untested: '#6b7280',
        stale: '#fbbf24',
        expiring: '#fb923c',
        rotationOverdue: '#f59e0b'
    };

    return (
        <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: '12px',
            color: 'var(--text-secondary, #a1a1aa)'
        }}>
            <div style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                backgroundColor: colors[status] || '#6b7280',
                boxShadow: count > 0 && status === 'failed' ? `0 0 6px ${colors[status]}` : 'none'
            }} />
            <span>{count}</span>
        </div>
    );
}

export default function VaultHealthWidget() {
    const { stats, loading, error, runScan, scanning } = useVaultHealth();
    const navigate = useNavigate();

    const timeAgo = useMemo(() => {
        if (!stats?.lastScanAt) return null;
        const diff = Date.now() - new Date(stats.lastScanAt).getTime();
        const hours = Math.floor(diff / 3600000);
        if (hours < 1) return 'just now';
        if (hours < 24) return `${hours}h ago`;
        return `${Math.floor(hours / 24)}d ago`;
    }, [stats?.lastScanAt]);

    if (loading) {
        return (
            <div style={styles.card}>
                <div style={styles.header}>
                    <span style={styles.iconWrap}>{shieldIcon}</span>
                    <span style={styles.title}>QuoxVault</span>
                </div>
                <div style={{ ...styles.body, opacity: 0.5 }}>Loading...</div>
            </div>
        );
    }

    if (error || !stats) {
        return null; // Don't show widget if vault unavailable
    }

    return (
        <div
            style={styles.card}
            onClick={() => navigate('/vault')}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && navigate('/vault')}
        >
            <div style={styles.header}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={styles.iconWrap}>{shieldIcon}</span>
                    <span style={styles.title}>QuoxVault</span>
                    <span style={styles.badge}>{stats.encryption}</span>
                </div>
                <button
                    style={styles.scanBtn}
                    onClick={(e) => { e.stopPropagation(); runScan(); }}
                    disabled={scanning}
                    title="Run health scan"
                >
                    <span style={{
                        display: 'inline-flex',
                        animation: scanning ? 'spin 1s linear infinite' : 'none'
                    }}>
                        {scanIcon}
                    </span>
                </button>
            </div>

            <div style={styles.body}>
                <div style={styles.totalCount}>{stats.total}</div>
                <div style={styles.totalLabel}>credentials</div>

                <div style={styles.healthRow}>
                    <HealthDot status="healthy" count={stats.healthy} />
                    <HealthDot status="failed" count={stats.failed} />
                    <HealthDot status="untested" count={stats.untested} />
                    <HealthDot status="stale" count={stats.stale} />
                    {stats.expiring > 0 && <HealthDot status="expiring" count={stats.expiring} />}
                    {stats.rotationOverdue > 0 && <HealthDot status="rotationOverdue" count={stats.rotationOverdue} />}
                </div>

                {stats.totalUseCount > 0 && (
                    <div style={styles.usageRow}>
                        {stats.totalUseCount.toLocaleString()} total uses
                    </div>
                )}
            </div>

            {timeAgo && (
                <div style={styles.footer}>
                    Last scan: {timeAgo}
                </div>
            )}
        </div>
    );
}

const styles = {
    card: {
        background: 'var(--m-bg-elevated, rgba(255, 255, 255, 0.05))',
        border: '1px solid var(--m-border, #2a2a2e)',
        borderRadius: '12px',
        padding: '16px',
        cursor: 'pointer',
        transition: 'border-color 0.2s, box-shadow 0.2s',
        minWidth: '200px'
    },
    header: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: '12px'
    },
    iconWrap: {
        color: '#38bdf8',
        display: 'inline-flex'
    },
    title: {
        fontSize: '14px',
        fontWeight: '600',
        color: 'var(--text-primary, #e4e4e7)',
        letterSpacing: '0.02em'
    },
    badge: {
        fontSize: '9px',
        fontWeight: '600',
        color: '#a78bfa',
        background: 'rgba(167, 139, 250, 0.12)',
        padding: '2px 6px',
        borderRadius: '4px',
        letterSpacing: '0.04em',
        textTransform: 'uppercase'
    },
    scanBtn: {
        background: 'none',
        border: 'none',
        color: 'var(--text-secondary, #a1a1aa)',
        cursor: 'pointer',
        padding: '4px',
        borderRadius: '4px',
        display: 'inline-flex',
        alignItems: 'center'
    },
    body: {
        textAlign: 'center'
    },
    totalCount: {
        fontSize: '28px',
        fontWeight: '700',
        color: 'var(--text-primary, #e4e4e7)',
        lineHeight: 1
    },
    totalLabel: {
        fontSize: '11px',
        color: 'var(--text-secondary, #a1a1aa)',
        marginBottom: '12px',
        textTransform: 'uppercase',
        letterSpacing: '0.08em'
    },
    healthRow: {
        display: 'flex',
        justifyContent: 'center',
        gap: '16px',
        marginBottom: '8px'
    },
    usageRow: {
        fontSize: '11px',
        color: 'var(--text-tertiary, #71717a)',
        marginTop: '4px'
    },
    footer: {
        fontSize: '10px',
        color: 'var(--text-tertiary, #71717a)',
        textAlign: 'center',
        marginTop: '8px',
        paddingTop: '8px',
        borderTop: '1px solid var(--m-border, #2a2a2e)'
    }
};
