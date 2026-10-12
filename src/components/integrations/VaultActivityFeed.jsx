/**
 * VaultActivityFeed — QuoxVault Phase 2
 *
 * Timeline of recent vault events: access, test, rotation, create, delete.
 * Pulls from audit_events filtered to INTEGRATION_* actions.
 * Collapsible sidebar panel in vault view.
 */

import { useState, useMemo } from 'react';
import { useVaultActivity } from '../../hooks/useVaultHealth';

const ACTION_META = {
    'integration.create': { label: 'Created', icon: '+', color: '#4ade80' },
    'integration.update': { label: 'Updated', icon: '~', color: '#38bdf8' },
    'integration.delete': { label: 'Deleted', icon: '×', color: '#f87171' },
    'integration.test': { label: 'Tested', icon: '✓', color: '#a78bfa' },
    'integration.access': { label: 'Accessed', icon: '→', color: '#fbbf24' },
    'integration.set_default': { label: 'Set default', icon: '★', color: '#38bdf8' },
    'integration.rotate': { label: 'Rotated', icon: '↻', color: '#22d3ee' }
};

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

function ActivityItem({ event }) {
    const meta = ACTION_META[event.action] || {
        label: event.action, icon: '?', color: '#6b7280'
    };

    let metadata = {};
    try {
        metadata = JSON.parse(event.metadata_json || '{}');
    } catch { /* ignore */ }

    const detail = metadata.integration_type || metadata.label || '';

    return (
        <div style={styles.item}>
            <div style={{
                ...styles.iconCircle,
                color: meta.color,
                borderColor: `${meta.color}33`
            }}>
                {meta.icon}
            </div>
            <div style={styles.itemContent}>
                <div style={styles.itemAction}>
                    <span style={{ color: meta.color, fontWeight: 500 }}>{meta.label}</span>
                    {detail && <span style={styles.itemDetail}>{detail}</span>}
                </div>
                <div style={styles.itemMeta}>
                    {event.actor_id && (
                        <span>{event.actor_type === 'service' ? 'service' : event.actor_id.slice(0, 8)}</span>
                    )}
                    <span>{formatTimeAgo(event.created_at)}</span>
                </div>
            </div>
            {event.status === 'failure' && (
                <div style={styles.failBadge}>failed</div>
            )}
        </div>
    );
}

export default function VaultActivityFeed({ collapsed = false, onToggle }) {
    const { events, loading, refresh } = useVaultActivity({ limit: 30 });
    const [isCollapsed, setIsCollapsed] = useState(collapsed);

    const handleToggle = () => {
        const next = !isCollapsed;
        setIsCollapsed(next);
        onToggle?.(next);
    };

    if (loading && events.length === 0) {
        return (
            <div style={styles.container}>
                <div style={styles.header} onClick={handleToggle}>
                    <span style={styles.headerTitle}>Activity</span>
                </div>
                {!isCollapsed && (
                    <div style={{ ...styles.body, opacity: 0.5, textAlign: 'center', padding: '20px 0' }}>
                        Loading activity...
                    </div>
                )}
            </div>
        );
    }

    return (
        <div style={styles.container}>
            <div style={styles.header} onClick={handleToggle}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                    </svg>
                    <span style={styles.headerTitle}>Activity</span>
                    {events.length > 0 && (
                        <span style={styles.count}>{events.length}</span>
                    )}
                </div>
                <svg
                    width="14" height="14" viewBox="0 0 24 24"
                    fill="none" stroke="currentColor" strokeWidth="2"
                    style={{
                        transition: 'transform 0.2s',
                        transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)'
                    }}
                >
                    <polyline points="6 9 12 15 18 9"/>
                </svg>
            </div>

            {!isCollapsed && (
                <div style={styles.body}>
                    {events.length === 0 ? (
                        <div style={styles.empty}>No vault activity yet</div>
                    ) : (
                        <div style={styles.timeline}>
                            {events.map((event, i) => (
                                <ActivityItem key={event.id || i} event={event} />
                            ))}
                        </div>
                    )}
                    <button
                        style={styles.refreshBtn}
                        onClick={(e) => { e.stopPropagation(); refresh(); }}
                    >
                        Refresh
                    </button>
                </div>
            )}
        </div>
    );
}

const styles = {
    container: {
        background: 'var(--m-bg-elevated, rgba(255, 255, 255, 0.05))',
        border: '1px solid var(--m-border, #2a2a2e)',
        borderRadius: '12px',
        overflow: 'hidden'
    },
    header: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 16px',
        cursor: 'pointer',
        color: 'var(--text-primary, #e4e4e7)',
        borderBottom: '1px solid var(--m-border, #2a2a2e)',
        userSelect: 'none'
    },
    headerTitle: {
        fontSize: '13px',
        fontWeight: '600',
        letterSpacing: '0.02em'
    },
    count: {
        fontSize: '10px',
        fontWeight: '600',
        background: 'rgba(56, 189, 248, 0.15)',
        color: '#38bdf8',
        padding: '1px 6px',
        borderRadius: '8px'
    },
    body: {
        maxHeight: '400px',
        overflowY: 'auto'
    },
    timeline: {
        padding: '8px 0'
    },
    item: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: '10px',
        padding: '8px 16px',
        transition: 'background 0.1s'
    },
    iconCircle: {
        width: '24px',
        height: '24px',
        borderRadius: '50%',
        border: '1px solid',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '12px',
        fontWeight: '700',
        flexShrink: 0,
        marginTop: '1px'
    },
    itemContent: {
        flex: 1,
        minWidth: 0
    },
    itemAction: {
        fontSize: '12px',
        color: 'var(--text-primary, #e4e4e7)',
        display: 'flex',
        alignItems: 'center',
        gap: '6px'
    },
    itemDetail: {
        color: 'var(--text-secondary, #a1a1aa)',
        fontSize: '11px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
    },
    itemMeta: {
        fontSize: '10px',
        color: 'var(--text-tertiary, #71717a)',
        display: 'flex',
        gap: '8px',
        marginTop: '2px'
    },
    failBadge: {
        fontSize: '9px',
        fontWeight: '600',
        color: '#f87171',
        background: 'rgba(248, 113, 113, 0.12)',
        padding: '1px 5px',
        borderRadius: '3px',
        textTransform: 'uppercase',
        flexShrink: 0
    },
    empty: {
        textAlign: 'center',
        padding: '24px 16px',
        color: 'var(--text-tertiary, #71717a)',
        fontSize: '12px'
    },
    refreshBtn: {
        display: 'block',
        width: '100%',
        padding: '8px',
        background: 'none',
        border: 'none',
        borderTop: '1px solid var(--m-border, #2a2a2e)',
        color: 'var(--text-secondary, #a1a1aa)',
        fontSize: '11px',
        cursor: 'pointer',
        textAlign: 'center'
    }
};
