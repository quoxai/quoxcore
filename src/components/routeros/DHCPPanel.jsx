/**
 * DHCPPanel - DHCP Lease Management
 *
 * Displays:
 * - Pool utilization progress bar
 * - Active/Total lease count
 * - IP conflict warning banner
 * - Lease table: hostname, IP, MAC, vendor, expires
 * - Reserve/Release action buttons
 */

import { useMemo } from 'react';
import './routeros.css';

// Icons
const DHCPIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M4 11a9 9 0 0 1 9 9"/>
        <path d="M4 4a16 16 0 0 1 16 16"/>
        <circle cx="5" cy="19" r="2"/>
    </svg>
);

function formatTimeRemaining(expiresAt) {
    if (!expiresAt) return 'Static';

    const now = new Date();
    const expires = new Date(expiresAt);
    const diff = expires - now;

    if (diff <= 0) return 'Expired';

    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

function PoolUtilization({ pool }) {
    const percentage = pool.total > 0 ? Math.round((pool.used / pool.total) * 100) : 0;
    const barClass = percentage >= 80 ? 'critical' : percentage >= 60 ? 'warning' : '';

    return (
        <div className="ros-dhcp__pool">
            <div className="ros-dhcp__pool-header">
                <span className="ros-dhcp__pool-name">{pool.name}</span>
                <span className="ros-dhcp__pool-stats">
                    {pool.used}/{pool.total} ({percentage}%)
                </span>
            </div>
            <div className="ros-dhcp__pool-bar">
                <div
                    className={`ros-dhcp__pool-fill ${barClass}`}
                    style={{ width: `${percentage}%` }}
                />
            </div>
        </div>
    );
}

function LeaseItem({ lease, onClick }) {
    return (
        <button className="ros-lease" onClick={() => onClick(lease)}>
            <span className="ros-lease__ip">{lease.ip}</span>
            <span className="ros-lease__hostname">{lease.hostname || 'Unknown'}</span>
            <span className={`ros-lease__badge ${lease.isStatic ? 'static' : 'dynamic'}`}>
                {lease.isStatic ? 'Static' : 'Dynamic'}
            </span>
            <span className="ros-lease__expires">
                {formatTimeRemaining(lease.expires)}
            </span>
        </button>
    );
}

export default function DHCPPanel({ leases = [], pools = [], onSelectLease }) {
    const sortedLeases = useMemo(() => {
        return [...leases].sort((a, b) => {
            // Static leases first
            if (a.isStatic && !b.isStatic) return -1;
            if (!a.isStatic && b.isStatic) return 1;
            // Then by IP
            return a.ip.localeCompare(b.ip, undefined, { numeric: true });
        });
    }, [leases]);

    const staticCount = leases.filter(l => l.isStatic).length;
    const dynamicCount = leases.filter(l => !l.isStatic).length;

    return (
        <div className="ros-panel">
            <div className="ros-panel__header">
                <h3 className="ros-panel__title">
                    <DHCPIcon />
                    DHCP Leases
                    <span style={{
                        marginLeft: '8px',
                        fontSize: '12px',
                        color: 'var(--m-text-tertiary)',
                        fontWeight: 'normal'
                    }}>
                        {staticCount} static, {dynamicCount} dynamic
                    </span>
                </h3>
            </div>
            <div className="ros-panel__body">
                {/* Pool Utilization */}
                {pools.map(pool => (
                    <PoolUtilization key={pool.id} pool={pool} />
                ))}

                {/* Leases List */}
                <div className="ros-dhcp__leases">
                    {sortedLeases.length === 0 ? (
                        <div className="ros-alerts__empty">
                            <DHCPIcon />
                            <p>No active leases</p>
                        </div>
                    ) : (
                        sortedLeases.map(lease => (
                            <LeaseItem
                                key={lease.id}
                                lease={lease}
                                onClick={onSelectLease}
                            />
                        ))
                    )}
                </div>
            </div>
        </div>
    );
}
