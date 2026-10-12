/**
 * DepartmentCard - Department Card Component
 *
 * Displays department information with optional inline mode for lists.
 * Follows DivisionCard pattern exactly.
 */

import Button from '../ui/Button';
import './org-components.css';

const HashIcon = () => (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <line x1="4" y1="9" x2="20" y2="9" />
        <line x1="4" y1="15" x2="20" y2="15" />
        <line x1="10" y1="3" x2="8" y2="21" />
        <line x1="16" y1="3" x2="14" y2="21" />
    </svg>
);

function DepartmentCard({
    department,
    divisionName,
    inline = false,
    onClick,
    onChat,
    onManage,
}) {
    if (!department) return null;

    const handleClick = () => {
        if (onClick) onClick(department);
    };

    const handleChatClick = (e) => {
        e.stopPropagation();
        if (onChat) onChat(department);
    };

    const handleManageClick = (e) => {
        e.stopPropagation();
        if (onManage) onManage(department);
    };

    // Inline variant - compact row style
    if (inline) {
        return (
            <div
                className="org-components department-card--inline entity-card"
                onClick={handleClick}
                role={onClick ? 'button' : undefined}
                tabIndex={onClick ? 0 : undefined}
                onKeyDown={(e) => onClick && e.key === 'Enter' && handleClick()}
            >
                <div className="entity-avatar entity-avatar--sm entity-avatar--department">
                    <HashIcon />
                </div>
                <div className="entity-card__content">
                    <h4 className="entity-card__name">{department.name}</h4>
                    <p className="entity-card__description">
                        {department.description || 'No description'}
                    </p>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginLeft: 'auto' }}>
                    <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                        {department.team_count || 0} teams
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
                    <div className="entity-avatar entity-avatar--md entity-avatar--department">
                        <HashIcon />
                    </div>
                    <div className="entity-card__title-block">
                        <h3 className="entity-card__name">{department.name}</h3>
                        <span className="entity-card__subtitle">
                            {divisionName || department.division_name || 'Division'}
                        </span>
                    </div>
                </div>
            </div>

            {/* Content */}
            <div className="entity-card__content">
                <p className="entity-card__description">
                    {department.description || 'No description provided'}
                </p>
            </div>

            {/* Stats */}
            <div className="entity-card__stats">
                <div className="entity-stat">
                    <span className="entity-stat__value">{department.team_count || 0}</span>
                    <span className="entity-stat__label">Teams</span>
                </div>
                <div className="entity-stat">
                    <span className="entity-stat__value">{department.member_count || 0}</span>
                    <span className="entity-stat__label">Members</span>
                </div>
            </div>

            {/* Footer Actions */}
            {(onChat || onManage) && (
                <div className="entity-card__footer">
                    <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                        Department Assistant available
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

// Skeleton loader
export function DepartmentCardSkeleton({ inline = false }) {
    if (inline) {
        return (
            <div className="org-components department-card--inline skeleton-card">
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

export default DepartmentCard;
