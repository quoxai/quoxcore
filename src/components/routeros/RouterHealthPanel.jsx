/**
 * RouterHealthPanel - Router Health Score and System Stats
 *
 * Displays:
 * - Overall health score as circular progress
 * - CPU/Memory/Temperature/Disk bars
 * - Router model, version, uptime
 * - Connection status indicator
 */

import './routeros.css';

// Icons
const HeartIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
    </svg>
);

function HealthScoreRing({ score }) {
    const radius = 52;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference - (score / 100) * circumference;
    const scoreClass = score >= 70 ? '' : score >= 40 ? 'warning' : 'critical';
    const scoreColor = score >= 70 ? '#10b981' : score >= 40 ? '#f59e0b' : '#ef4444';

    return (
        <div className="ros-health__score">
            <svg className="ros-health__score-ring" viewBox="0 0 120 120">
                <circle className="bg" cx="60" cy="60" r={radius} />
                <circle
                    className={`progress ${scoreClass}`}
                    cx="60"
                    cy="60"
                    r={radius}
                    strokeDasharray={circumference}
                    strokeDashoffset={offset}
                />
            </svg>
            <div className="ros-health__score-value">
                <span className="ros-health__score-number" style={{ color: scoreColor }}>
                    {score}
                </span>
                <span className="ros-health__score-label">Health</span>
            </div>
        </div>
    );
}

function MetricBar({ label, value, max = 100, unit = '%' }) {
    const percentage = Math.min((value / max) * 100, 100);
    const barClass = percentage >= 80 ? 'critical' : percentage >= 60 ? 'warning' : '';

    return (
        <div className="ros-health__metric">
            <div className="ros-health__metric-header">
                <span className="ros-health__metric-label">{label}</span>
                <span className="ros-health__metric-value">{value}{unit}</span>
            </div>
            <div className="ros-health__metric-bar">
                <div
                    className={`ros-health__metric-fill ${barClass}`}
                    style={{ width: `${percentage}%` }}
                />
            </div>
        </div>
    );
}

export default function RouterHealthPanel({ router, health }) {
    if (!router || !health) {
        return (
            <div className="ros-panel">
                <div className="ros-panel__header">
                    <h3 className="ros-panel__title">
                        <HeartIcon />
                        Router Health
                    </h3>
                </div>
                <div className="ros-panel__body">
                    <div className="ros-loading">
                        <div className="ros-loading__spinner" />
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="ros-panel">
            <div className="ros-panel__header">
                <h3 className="ros-panel__title">
                    <HeartIcon />
                    Router Health
                </h3>
            </div>
            <div className="ros-panel__body">
                <div className="ros-health">
                    <HealthScoreRing score={health.score} />
                    <div className="ros-health__metrics">
                        <MetricBar label="CPU" value={health.cpu} />
                        <MetricBar label="Memory" value={health.memory} />
                        <MetricBar label="Temperature" value={health.temperature} max={100} unit="°C" />
                        <MetricBar label="Disk" value={health.disk} />
                    </div>
                </div>
                <div className="ros-health__info">
                    <div className="ros-health__info-item">
                        <span className="ros-health__info-label">Model</span>
                        <span className="ros-health__info-value">{router.model}</span>
                    </div>
                    <div className="ros-health__info-item">
                        <span className="ros-health__info-label">Version</span>
                        <span className="ros-health__info-value">RouterOS {router.version}</span>
                    </div>
                    <div className="ros-health__info-item">
                        <span className="ros-health__info-label">Uptime</span>
                        <span className="ros-health__info-value">{router.uptime}</span>
                    </div>
                    <div className="ros-health__info-item">
                        <span className="ros-health__info-label">IP Address</span>
                        <span className="ros-health__info-value">{router.ip}</span>
                    </div>
                </div>
            </div>
        </div>
    );
}
