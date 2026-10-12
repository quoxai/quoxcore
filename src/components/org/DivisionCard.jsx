/**
 * DivisionCard - Enhanced Division Card Component
 *
 * Displays division information with optional inline mode for lists.
 * Supports full card view and compact inline row view.
 */

import Button from '../ui/Button';
import './org-components.css';

const LayersIcon = () => (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <polygon points="12 2 2 7 12 12 22 7 12 2"/>
        <polyline points="2 17 12 22 22 17"/>
        <polyline points="2 12 12 17 22 12"/>
    </svg>
);

function DivisionCard({
    division,
    orgName,
    inline = false,
    onClick,
    onChat,
    onManage
}) {
    const handleClick = () => {
        if (onClick) onClick(division);
    };

    const handleChatClick = (e) => {
        e.stopPropagation();
        if (onChat) onChat(division);
    };

    const handleManageClick = (e) => {
        e.stopPropagation();
        if (onManage) onManage(division);
    };

    // Inline variant - compact row style
    if (inline) {
        return (
            <div
                className="org-components division-card-v2--inline entity-card"
                onClick={handleClick}
                role={onClick ? 'button' : undefined}
                tabIndex={onClick ? 0 : undefined}
            >
                <div className="entity-avatar entity-avatar--sm entity-avatar--division">
                    <LayersIcon />
                </div>
                <div className="entity-card__content">
                    <h4 className="entity-card__name">{division.name}</h4>
                    <p className="entity-card__description">
                        {division.description || 'No description'}
                    </p>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginLeft: 'auto' }}>
                    <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                        {division.member_count || 0} members
                    </span>
                    {onManage && (
                        <Button size="sm" variant="ghost" onClick={handleManageClick}>
                            Manage
                        </Button>
                    )}
                </div>
            </div>
        );
    }

    // Full card variant
    return (
        <div
            className="org-components entity-card"
            onClick={handleClick}
            role={onClick ? 'button' : undefined}
            tabIndex={onClick ? 0 : undefined}
            onKeyDown={(e) => onClick && e.key === 'Enter' && handleClick()}
        >
            {/* Header */}
            <div className="entity-card__header">
                <div className="entity-card__identity">
                    <div className="entity-avatar entity-avatar--md entity-avatar--division">
                        <LayersIcon />
                    </div>
                    <div className="entity-card__title-block">
                        <h3 className="entity-card__name">{division.name}</h3>
                        <span className="entity-card__subtitle">
                            {orgName || division.org_name || 'Organisation'}
                        </span>
                    </div>
                </div>
            </div>

            {/* Content */}
            <div className="entity-card__content">
                <p className="entity-card__description">
                    {division.description || 'No description provided'}
                </p>
            </div>

            {/* Stats */}
            <div className="entity-card__stats">
                <div className="entity-stat">
                    <span className="entity-stat__value">{division.member_count || 0}</span>
                    <span className="entity-stat__label">Members</span>
                </div>
                <div className="entity-stat">
                    <span className="entity-stat__value">{division.team_count || 0}</span>
                    <span className="entity-stat__label">Teams</span>
                </div>
                <div className="entity-stat">
                    <span className="entity-stat__value">{division.department_count || 0}</span>
                    <span className="entity-stat__label">Depts</span>
                </div>
            </div>

            {/* Footer Actions */}
            {(onChat || onManage) && (
                <div className="entity-card__footer">
                    <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                        Division Assistant available
                    </span>
                    <div className="entity-card__actions">
                        {onChat && (
                            <Button size="sm" variant="secondary" onClick={handleChatClick}>
                                Chat
                            </Button>
                        )}
                        {onManage && (
                            <Button size="sm" variant="ghost" onClick={handleManageClick}>
                                Manage
                            </Button>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

// Skeleton loader for DivisionCard
export function DivisionCardSkeleton({ inline = false }) {
    if (inline) {
        return (
            <div className="org-components division-card-v2--inline skeleton-card">
                <div className="skeleton-avatar" style={{ width: '32px', height: '32px' }} />
                <div className="entity-card__content" style={{ flex: 1 }}>
                    <div className="skeleton-text" style={{ width: '50%', height: '16px' }} />
                    <div className="skeleton-text" style={{ width: '75%', marginTop: '6px' }} />
                </div>
            </div>
        );
    }

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
                <div className="skeleton-text" style={{ width: '60%', marginTop: '8px' }} />
            </div>
            <div className="entity-card__stats">
                <div className="entity-stat">
                    <div className="skeleton-text" style={{ width: '30px', height: '20px' }} />
                    <div className="skeleton-text" style={{ width: '50px', marginTop: '4px' }} />
                </div>
                <div className="entity-stat">
                    <div className="skeleton-text" style={{ width: '30px', height: '20px' }} />
                    <div className="skeleton-text" style={{ width: '50px', marginTop: '4px' }} />
                </div>
            </div>
        </div>
    );
}

export default DivisionCard;
