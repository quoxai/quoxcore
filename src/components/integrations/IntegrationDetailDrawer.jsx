/**
 * IntegrationDetailDrawer — Right-side slide-over panel
 *
 * Shows full integration details: description, connection status,
 * existing credentials, field requirements, and actions.
 */

import { useMemo } from 'react';

// Icons
const CloseIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
);

const ExternalLinkIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        <polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
    </svg>
);

const PlusIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
    </svg>
);

const KeyIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
    </svg>
);

const HEALTH_COLORS = {
    success: '#4ade80',
    failed: '#f87171',
    untested: '#6b7280',
    // VAULT-INTEG P8: a format-only "success" (shape check only, no
    // network probe) is amber, never the same green as a real live pass.
    format_only: '#f59e0b'
};

function getInitials(name) {
    if (!name) return '?';
    const words = name.split(/[\s-]+/);
    if (words.length === 1) return name.slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
}

function formatTimeAgo(dateStr) {
    if (!dateStr) return 'Never';
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

export default function IntegrationDetailDrawer({
    type,
    credentials,
    categories,
    typeIcons,
    onClose,
    onAddCredential,
    onManageCredential
}) {
    if (!type) return null;

    const icon = typeIcons?.[type.id];
    const categoryName = categories?.[type.category]?.name || type.category || 'Custom';
    const isDeprecated = type.deprecated === true;
    // VAULT-INTEG P8: same rule as IntegrationCard.jsx — a format-only
    // "success" is a credential SHAPE check, never a real network probe.
    const isFormatOnly = (type.test_depth || type.testDepth) === 'format-only';

    const sortedCreds = useMemo(() => {
        if (!credentials?.length) return [];
        return [...credentials].sort((a, b) => {
            if (a.is_default && !b.is_default) return -1;
            if (!a.is_default && b.is_default) return 1;
            return new Date(b.created_at) - new Date(a.created_at);
        });
    }, [credentials]);

    return (
        <>
            <div className="drawer-overlay" onClick={onClose} />
            <div className="drawer-panel">
                {/* Header */}
                <div className="drawer-header">
                    <button className="drawer-close" onClick={onClose}>
                        <CloseIcon />
                    </button>
                </div>

                {/* Hero */}
                <div className="drawer-hero">
                    <div
                        className="drawer-hero__icon"
                        style={{
                            backgroundColor: type.color ? `${type.color}18` : 'rgba(255,255,255,0.05)',
                            color: type.color || 'var(--text-secondary)'
                        }}
                    >
                        {icon ? (
                            <span className="drawer-hero__brand-icon">{icon}</span>
                        ) : (
                            <span className="drawer-hero__initials">{getInitials(type.name)}</span>
                        )}
                    </div>
                    <div className="drawer-hero__info">
                        <h2 className="drawer-hero__name">{type.name}</h2>
                        <div className="drawer-hero__meta">
                            <span className="drawer-hero__category">{categoryName}</span>
                            {isDeprecated && (
                                <span className="drawer-hero__deprecated">Deprecated</span>
                            )}
                        </div>
                    </div>
                </div>

                {/* Description */}
                <div className="drawer-section">
                    <p className="drawer-description">{type.description || 'No description available.'}</p>
                </div>

                {/* Connection Status */}
                <div className="drawer-section">
                    <div className="drawer-status-bar">
                        <span className="drawer-status-bar__label">
                            {sortedCreds.length > 0
                                ? `${sortedCreds.length} credential${sortedCreds.length !== 1 ? 's' : ''} connected`
                                : 'Not connected'}
                        </span>
                        <button
                            className="drawer-btn drawer-btn--primary"
                            onClick={() => onAddCredential(type)}
                        >
                            <PlusIcon />
                            Add Credential
                        </button>
                    </div>
                </div>

                {/* Existing Credentials */}
                {sortedCreds.length > 0 && (
                    <div className="drawer-section">
                        <h3 className="drawer-section__title">Credentials</h3>
                        <div className="drawer-creds-list">
                            {sortedCreds.map(cred => (
                                <button
                                    key={cred.id}
                                    className="drawer-cred-item"
                                    onClick={() => onManageCredential(cred)}
                                >
                                    <div className="drawer-cred-item__left">
                                        <span
                                            className="drawer-cred-item__dot"
                                            title={cred.test_status === 'success' && isFormatOnly ? 'Format check only, no live connection made' : undefined}
                                            style={{ backgroundColor: cred.test_status === 'success' && isFormatOnly ? HEALTH_COLORS.format_only : (HEALTH_COLORS[cred.test_status] || HEALTH_COLORS.untested) }}
                                        />
                                        <div className="drawer-cred-item__info">
                                            <span className="drawer-cred-item__label">
                                                {cred.label || type.name}
                                                {cred.is_default && <span className="drawer-cred-item__default">Default</span>}
                                                {cred.test_status === 'success' && isFormatOnly && (
                                                    <span className="drawer-cred-item__format-only" title="Format check only, no live connection made">
                                                        format check only
                                                    </span>
                                                )}
                                            </span>
                                            <span className="drawer-cred-item__preview">{cred.key_preview || '••••••••'}</span>
                                        </div>
                                    </div>
                                    <span className="drawer-cred-item__time">
                                        {formatTimeAgo(cred.last_tested_at || cred.created_at)}
                                    </span>
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                {/* Required Fields */}
                {type.fields?.length > 0 && (
                    <div className="drawer-section">
                        <h3 className="drawer-section__title">Required to Connect</h3>
                        <div className="drawer-fields-list">
                            {type.fields.filter(f => f.required !== false).map(field => (
                                <div key={field.key} className="drawer-field-item">
                                    <KeyIcon />
                                    <span className="drawer-field-item__label">{field.label}</span>
                                    {field.prefix && (
                                        <code className="drawer-field-item__prefix">{field.prefix}...</code>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Docs link */}
                {type.docs && (
                    <div className="drawer-section drawer-section--footer">
                        <a
                            href={type.docs}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="drawer-docs-link"
                        >
                            <ExternalLinkIcon />
                            View API Documentation
                        </a>
                    </div>
                )}
            </div>
        </>
    );
}
