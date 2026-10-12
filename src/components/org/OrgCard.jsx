/**
 * OrgCard - Enhanced Organization Card Component
 *
 * Displays organization information with avatar, stats, and actions.
 * Supports active state, compact mode, and various role badges.
 */

import { useState } from 'react';
import Button from '../ui/Button';
import './org-components.css';

const ICONS = {
    building: (
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M3 21h18"/>
            <path d="M5 21V7l8-4v18"/>
            <path d="M19 21V11l-6-4"/>
            <path d="M9 9v.01"/>
            <path d="M9 12v.01"/>
            <path d="M9 15v.01"/>
            <path d="M9 18v.01"/>
        </svg>
    ),
    members: (
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
            <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
        </svg>
    ),
    divisions: (
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <polygon points="12 2 2 7 12 12 22 7 12 2"/>
            <polyline points="2 17 12 22 22 17"/>
            <polyline points="2 12 12 17 22 12"/>
        </svg>
    )
};

function OrgCard({
    org,
    isActive = false,
    showRole = true,
    compact = false,
    onClick,
    onManage
}) {
    const [imgError, setImgError] = useState(false);

    // Safety check for undefined org
    if (!org) {
        return null;
    }

    const handleClick = (e) => {
        if (onClick) {
            onClick(org);
        }
    };

    const handleManageClick = (e) => {
        e.stopPropagation();
        if (onManage) {
            onManage(org);
        }
    };

    const getRoleBadge = () => {
        const role = org.membership?.role || org.role || 'member';
        if (!role) return null;

        switch (role.toLowerCase()) {
            case 'owner':
                return <span className="entity-badge entity-badge--owner">Owner</span>;
            case 'admin':
                return <span className="entity-badge entity-badge--admin">Admin</span>;
            default:
                return <span className="entity-badge entity-badge--member">Member</span>;
        }
    };

    return (
        <div
            className={`org-components entity-card ${isActive ? 'entity-card--active' : ''} ${compact ? 'entity-card--compact' : ''}`}
            onClick={handleClick}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && handleClick(e)}
        >
            {/* Header */}
            <div className="entity-card__header">
                <div className="entity-card__identity">
                    <div className="entity-avatar entity-avatar--md entity-avatar--org">
                        {org.logo_url && !imgError ? (
                            <img src={org.logo_url} alt={org.name} onError={() => setImgError(true)} />
                        ) : (
                            org.name?.[0]?.toUpperCase() || 'O'
                        )}
                    </div>
                    <div className="entity-card__title-block">
                        <h3 className="entity-card__name">{org.name}</h3>
                        {org.created_at && (
                            <span className="entity-card__subtitle">
                                Created {new Date(org.created_at).toLocaleDateString()}
                            </span>
                        )}
                    </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {isActive && (
                        <span className="entity-badge entity-badge--active">Active</span>
                    )}
                    {showRole && getRoleBadge()}
                </div>
            </div>

            {/* Content */}
            <div className="entity-card__content">
                <p className="entity-card__description">
                    {org.description || 'No description provided'}
                </p>
            </div>

            {/* Stats */}
            <div className="entity-card__stats">
                <div className="entity-stat">
                    <span className="entity-stat__value">{org.member_count || 0}</span>
                    <span className="entity-stat__label">Members</span>
                </div>
                <div className="entity-stat">
                    <span className="entity-stat__value">{org.division_count || 0}</span>
                    <span className="entity-stat__label">Divisions</span>
                </div>
                {org.team_count !== undefined && (
                    <div className="entity-stat">
                        <span className="entity-stat__value">{org.team_count || 0}</span>
                        <span className="entity-stat__label">Teams</span>
                    </div>
                )}
            </div>

            {/* Footer */}
            {onManage && (
                <div className="entity-card__footer">
                    <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                        {org.plan || 'Free'} plan
                    </span>
                    <div className="entity-card__actions">
                        <Button
                            size="sm"
                            variant="secondary"
                            onClick={handleManageClick}
                        >
                            Manage
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}

// Skeleton loader for OrgCard
export function OrgCardSkeleton() {
    return (
        <div className="org-components skeleton-card">
            <div className="entity-card__header">
                <div className="entity-card__identity">
                    <div className="skeleton-avatar" />
                    <div className="entity-card__title-block" style={{ flex: 1 }}>
                        <div className="skeleton-text skeleton-text--title" />
                        <div className="skeleton-text skeleton-text--short" style={{ marginTop: '8px' }} />
                    </div>
                </div>
            </div>
            <div className="entity-card__content">
                <div className="skeleton-text" style={{ width: '100%' }} />
                <div className="skeleton-text" style={{ width: '75%', marginTop: '8px' }} />
            </div>
            <div className="entity-card__stats">
                <div className="entity-stat">
                    <div className="skeleton-text" style={{ width: '40px', height: '24px' }} />
                    <div className="skeleton-text" style={{ width: '60px', marginTop: '4px' }} />
                </div>
                <div className="entity-stat">
                    <div className="skeleton-text" style={{ width: '40px', height: '24px' }} />
                    <div className="skeleton-text" style={{ width: '60px', marginTop: '4px' }} />
                </div>
            </div>
        </div>
    );
}

export default OrgCard;
