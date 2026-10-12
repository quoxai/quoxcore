/**
 * VPNPanel - VPN Tunnel Status
 *
 * Displays:
 * - WireGuard peers list
 * - IPsec tunnel status
 * - Handshake age with warning colors
 * - Traffic stats per tunnel
 */

import './routeros.css';

// Icons
const VPNIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
        <path d="M12 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/>
        <path d="M12 11v4"/>
    </svg>
);

function formatBytes(bytes) {
    if (!bytes) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatHandshakeAge(timestamp) {
    if (!timestamp) return 'Never';

    const now = new Date();
    const time = new Date(timestamp);
    const diff = now - time;

    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(diff / (1000 * 60));

    if (seconds < 60) return `${seconds}s ago`;
    if (minutes < 60) return `${minutes}m ago`;
    return 'Stale';
}

function getHandshakeClass(timestamp) {
    if (!timestamp) return 'stale';

    const now = new Date();
    const time = new Date(timestamp);
    const diff = now - time;
    const minutes = diff / (1000 * 60);

    if (minutes > 3) return 'stale';
    if (minutes > 2) return 'warning';
    return '';
}

function WireGuardTunnel({ tunnel }) {
    const handshakeClass = getHandshakeClass(tunnel.lastHandshake);

    return (
        <div className="ros-tunnel">
            <div className="ros-tunnel__header">
                <div className="ros-tunnel__name">
                    {tunnel.name}
                    <span className="ros-tunnel__type">WireGuard</span>
                </div>
                <div className="ros-tunnel__status">
                    <span className={`ros-tunnel__status-dot ${tunnel.status}`} />
                    <span>{tunnel.status}</span>
                </div>
            </div>
            <div className="ros-tunnel__details">
                <div className="ros-tunnel__detail">
                    <span className="ros-tunnel__detail-label">Endpoint</span>
                    <span className="ros-tunnel__detail-value">{tunnel.endpoint}</span>
                </div>
                <div className="ros-tunnel__detail">
                    <span className="ros-tunnel__detail-label">Allowed IPs</span>
                    <span className="ros-tunnel__detail-value">{tunnel.allowedIPs}</span>
                </div>
                <div className="ros-tunnel__detail">
                    <span className="ros-tunnel__detail-label">TX</span>
                    <span className="ros-tunnel__detail-value">{formatBytes(tunnel.txBytes)}</span>
                </div>
                <div className="ros-tunnel__detail">
                    <span className="ros-tunnel__detail-label">RX</span>
                    <span className="ros-tunnel__detail-value">{formatBytes(tunnel.rxBytes)}</span>
                </div>
            </div>
            <div className={`ros-tunnel__handshake ${handshakeClass}`}>
                Last handshake: {formatHandshakeAge(tunnel.lastHandshake)}
            </div>
        </div>
    );
}

function IPsecTunnel({ tunnel }) {
    return (
        <div className="ros-tunnel">
            <div className="ros-tunnel__header">
                <div className="ros-tunnel__name">
                    {tunnel.name}
                    <span className="ros-tunnel__type">IPsec</span>
                </div>
                <div className="ros-tunnel__status">
                    <span className={`ros-tunnel__status-dot ${tunnel.status}`} />
                    <span>{tunnel.status}</span>
                </div>
            </div>
            <div className="ros-tunnel__details">
                <div className="ros-tunnel__detail">
                    <span className="ros-tunnel__detail-label">Local</span>
                    <span className="ros-tunnel__detail-value">{tunnel.localAddress}</span>
                </div>
                <div className="ros-tunnel__detail">
                    <span className="ros-tunnel__detail-label">Remote</span>
                    <span className="ros-tunnel__detail-value">{tunnel.remoteAddress}</span>
                </div>
                <div className="ros-tunnel__detail">
                    <span className="ros-tunnel__detail-label">Phase 1</span>
                    <span className="ros-tunnel__detail-value">{tunnel.phase1}</span>
                </div>
                <div className="ros-tunnel__detail">
                    <span className="ros-tunnel__detail-label">Phase 2</span>
                    <span className="ros-tunnel__detail-value">{tunnel.phase2}</span>
                </div>
            </div>
            {tunnel.uptime && (
                <div className="ros-tunnel__handshake">
                    Uptime: {tunnel.uptime}
                </div>
            )}
        </div>
    );
}

export default function VPNPanel({ tunnels = [] }) {
    const wireguardTunnels = tunnels.filter(t => t.type === 'wireguard');
    const ipsecTunnels = tunnels.filter(t => t.type === 'ipsec');
    const connectedCount = tunnels.filter(t => t.status === 'connected' || t.status === 'established').length;

    return (
        <div className="ros-panel">
            <div className="ros-panel__header">
                <h3 className="ros-panel__title">
                    <VPNIcon />
                    VPN Tunnels
                    <span style={{
                        marginLeft: '8px',
                        fontSize: '12px',
                        color: 'var(--m-text-tertiary)',
                        fontWeight: 'normal'
                    }}>
                        {connectedCount}/{tunnels.length} connected
                    </span>
                </h3>
            </div>
            <div className="ros-panel__body">
                <div className="ros-vpn__list">
                    {tunnels.length === 0 ? (
                        <div className="ros-alerts__empty">
                            <VPNIcon />
                            <p>No VPN tunnels configured</p>
                        </div>
                    ) : (
                        <>
                            {wireguardTunnels.map(tunnel => (
                                <WireGuardTunnel key={tunnel.id} tunnel={tunnel} />
                            ))}
                            {ipsecTunnels.map(tunnel => (
                                <IPsecTunnel key={tunnel.id} tunnel={tunnel} />
                            ))}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
