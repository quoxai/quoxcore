/**
 * VaultUsageWidget — QuoxVault Phase 5 (B3)
 *
 * Compact dashboard card showing credential usage analytics.
 * Shows type breakdown bar, most-used credential, total usage count.
 * Companion widget to VaultHealthWidget.
 */

import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useVaultHealth } from '../../hooks/useVaultHealth';
import { INTEGRATION_TYPES } from '../../config/integrationTypes';

const chartIcon = (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="20" x2="18" y2="10"/>
        <line x1="12" y1="20" x2="12" y2="4"/>
        <line x1="6" y1="20" x2="6" y2="14"/>
    </svg>
);

/**
 * Horizontal stacked bar showing credential distribution by type
 */
function TypeBreakdownBar({ breakdown, total }) {
    if (!breakdown?.length || total === 0) return null;

    return (
        <div style={styles.barContainer}>
            <div style={styles.barTrack}>
                {breakdown.map((item) => {
                    const pct = (item.count / total) * 100;
                    if (pct < 1) return null;
                    const color = INTEGRATION_TYPES[item.integration_type]?.color || '#6b7280';
                    return (
                        <div
                            key={item.integration_type}
                            title={`${item.integration_type}: ${item.count}`}
                            style={{
                                width: `${pct}%`,
                                backgroundColor: color,
                                height: '100%',
                                minWidth: '4px',
                                transition: 'width 0.3s ease'
                            }}
                        />
                    );
                })}
            </div>
            <div style={styles.barLegend}>
                {breakdown.slice(0, 4).map((item) => {
                    const color = INTEGRATION_TYPES[item.integration_type]?.color || '#6b7280';
                    const name = INTEGRATION_TYPES[item.integration_type]?.name || item.integration_type;
                    return (
                        <div key={item.integration_type} style={styles.legendItem}>
                            <div style={{
                                width: '6px',
                                height: '6px',
                                borderRadius: '2px',
                                backgroundColor: color,
                                flexShrink: 0
                            }} />
                            <span>{name}</span>
                            <span style={styles.legendCount}>{item.count}</span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

export default function VaultUsageWidget() {
    const { stats, loading, error } = useVaultHealth({ autoPoll: false });
    const navigate = useNavigate();

    const formattedUseCount = useMemo(() => {
        if (!stats?.totalUseCount) return '0';
        return stats.totalUseCount.toLocaleString();
    }, [stats?.totalUseCount]);

    if (loading) {
        return (
            <div style={styles.card}>
                <div style={styles.header}>
                    <span style={styles.iconWrap}>{chartIcon}</span>
                    <span style={styles.title}>Usage</span>
                </div>
                <div style={{ ...styles.body, opacity: 0.5 }}>Loading...</div>
            </div>
        );
    }

    if (error || !stats) {
        return null;
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
                    <span style={styles.iconWrap}>{chartIcon}</span>
                    <span style={styles.title}>Usage</span>
                </div>
            </div>

            <div style={styles.body}>
                <div style={styles.totalCount}>{formattedUseCount}</div>
                <div style={styles.totalLabel}>api calls</div>

                <TypeBreakdownBar
                    breakdown={stats.typeBreakdown}
                    total={stats.total}
                />

                {stats.mostUsed && (
                    <div style={styles.mostUsed}>
                        <span style={styles.mostUsedLabel}>Top:</span>
                        <span style={styles.mostUsedValue}>
                            {stats.mostUsed.label}
                        </span>
                        <span style={styles.mostUsedCount}>
                            ({stats.mostUsed.use_count})
                        </span>
                    </div>
                )}
            </div>
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
        color: '#a78bfa',
        display: 'inline-flex'
    },
    title: {
        fontSize: '14px',
        fontWeight: '600',
        color: 'var(--text-primary, #e4e4e7)',
        letterSpacing: '0.02em'
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
    barContainer: {
        marginBottom: '8px'
    },
    barTrack: {
        display: 'flex',
        height: '6px',
        borderRadius: '3px',
        overflow: 'hidden',
        backgroundColor: 'var(--m-border, #2a2a2e)',
        gap: '1px',
        marginBottom: '6px'
    },
    barLegend: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: '8px',
        justifyContent: 'center'
    },
    legendItem: {
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        fontSize: '10px',
        color: 'var(--text-secondary, #a1a1aa)'
    },
    legendCount: {
        color: 'var(--text-tertiary, #71717a)',
        fontSize: '10px'
    },
    mostUsed: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '4px',
        marginTop: '8px',
        paddingTop: '8px',
        borderTop: '1px solid var(--m-border, #2a2a2e)',
        fontSize: '11px'
    },
    mostUsedLabel: {
        color: 'var(--text-tertiary, #71717a)'
    },
    mostUsedValue: {
        color: 'var(--text-primary, #e4e4e7)',
        fontWeight: '500'
    },
    mostUsedCount: {
        color: 'var(--text-tertiary, #71717a)'
    }
};
