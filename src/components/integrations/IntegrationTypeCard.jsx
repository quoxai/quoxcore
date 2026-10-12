/**
 * IntegrationTypeCard — Card for the integrations browse grid
 *
 * Shows integration name, description, brand color accent, and connection status.
 * Used in IntegrationsBrowse grid view.
 */

import { useMemo } from 'react';

// Generate initials from integration name for fallback icon
function getInitials(name) {
    if (!name) return '?';
    const words = name.split(/[\s-]+/);
    if (words.length === 1) return name.slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
}

export default function IntegrationTypeCard({ type, credentialCount, onClick, typeIcons }) {
    const isConnected = credentialCount > 0;
    const icon = typeIcons?.[type.id];

    const accentStyle = useMemo(() => ({
        backgroundColor: type.color ? `${type.color}18` : 'rgba(255,255,255,0.05)',
        color: type.color || 'var(--text-secondary)'
    }), [type.color]);

    return (
        <button
            className={`browse-card ${isConnected ? 'browse-card--connected' : ''}`}
            onClick={() => onClick(type)}
            title={type.name}
        >
            {/* Brand accent strip */}
            <div className="browse-card__accent" style={{ backgroundColor: type.color || '#6b7280' }} />

            <div className="browse-card__body">
                {/* Icon */}
                <div className="browse-card__icon" style={accentStyle}>
                    {icon ? (
                        <span className="browse-card__brand-icon">{icon}</span>
                    ) : (
                        <span className="browse-card__initials">{getInitials(type.name)}</span>
                    )}
                </div>

                {/* Info */}
                <div className="browse-card__info">
                    <span className="browse-card__name">{type.name}</span>
                    <span className="browse-card__desc">{type.description || 'No description'}</span>
                </div>

                {/* Status */}
                {isConnected && (
                    <div className="browse-card__status">
                        <span className="browse-card__connected-dot" />
                        <span className="browse-card__connected-label">
                            {credentialCount}
                        </span>
                    </div>
                )}
            </div>
        </button>
    );
}
