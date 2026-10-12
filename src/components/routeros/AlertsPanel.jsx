/**
 * AlertsPanel - Active Alerts Display
 *
 * Displays:
 * - Severity-based alert cards (critical, high, medium, low)
 * - Plain English toggle
 * - "Fix it for me" action buttons
 * - Link to troubleshoot wizard
 */

import { useState } from 'react';
import './routeros.css';

// Icons
const AlertIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
        <line x1="12" y1="9" x2="12" y2="13"/>
        <line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
);

const CheckIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="20 6 9 17 4 12"/>
    </svg>
);

const WrenchIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
    </svg>
);

const ChatIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    </svg>
);

function formatTimeAgo(timestamp) {
    if (!timestamp) return '';

    const now = new Date();
    const time = new Date(timestamp);
    const diff = now - time;

    const minutes = Math.floor(diff / (1000 * 60));
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${days}d ago`;
}

function AlertItem({ alert, showTechnical, onAskNetwatch }) {
    return (
        <div className={`ros-alert ros-alert--${alert.severity}`}>
            <div className="ros-alert__header">
                <span className="ros-alert__severity">{alert.severity}</span>
                <span className="ros-alert__time">{formatTimeAgo(alert.timestamp)}</span>
            </div>
            <div className="ros-alert__message">
                {alert.plainEnglish}
            </div>
            {showTechnical && alert.technical && (
                <div className="ros-alert__technical">
                    {alert.technical}
                </div>
            )}
            <div className="ros-alert__actions">
                {alert.action && (
                    <button className="ros-alert__action">
                        <WrenchIcon />
                        Fix it
                    </button>
                )}
                <button
                    className="ros-alert__action"
                    onClick={() => onAskNetwatch(`Tell me more about this alert: ${alert.plainEnglish}`)}
                >
                    <ChatIcon />
                    Ask NETWATCH
                </button>
            </div>
        </div>
    );
}

export default function AlertsPanel({ alerts = [], onAskNetwatch }) {
    const [showTechnical, setShowTechnical] = useState(false);

    // Sort by severity (critical/high first) then by timestamp
    const sortedAlerts = [...alerts].sort((a, b) => {
        const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
        const sevDiff = (severityOrder[a.severity] || 4) - (severityOrder[b.severity] || 4);
        if (sevDiff !== 0) return sevDiff;
        return new Date(b.timestamp) - new Date(a.timestamp);
    });

    const criticalCount = alerts.filter(a => a.severity === 'critical' || a.severity === 'high').length;

    return (
        <div className="ros-panel">
            <div className="ros-panel__header">
                <h3 className="ros-panel__title">
                    <AlertIcon />
                    Alerts
                    {criticalCount > 0 && (
                        <span style={{
                            marginLeft: '8px',
                            padding: '2px 6px',
                            background: 'rgba(239, 68, 68, 0.2)',
                            borderRadius: '4px',
                            fontSize: '11px',
                            fontWeight: 'bold',
                            color: '#ef4444'
                        }}>
                            {criticalCount} critical
                        </span>
                    )}
                </h3>
                <div className="ros-panel__actions">
                    <label className="ros-alerts__toggle">
                        <input
                            type="checkbox"
                            checked={showTechnical}
                            onChange={(e) => setShowTechnical(e.target.checked)}
                        />
                        Show technical
                    </label>
                </div>
            </div>
            <div className="ros-panel__body">
                <div className="ros-alerts__list">
                    {sortedAlerts.length === 0 ? (
                        <div className="ros-alerts__empty">
                            <CheckIcon />
                            <p>No active alerts</p>
                        </div>
                    ) : (
                        sortedAlerts.map(alert => (
                            <AlertItem
                                key={alert.id}
                                alert={alert}
                                showTechnical={showTechnical}
                                onAskNetwatch={onAskNetwatch}
                            />
                        ))
                    )}
                </div>
            </div>
        </div>
    );
}
