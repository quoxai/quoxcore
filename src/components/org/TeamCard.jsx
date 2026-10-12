/**
 * TeamCard - Team Card Component
 *
 * Displays team information with members count and role badge.
 * Supports full card view and compact inline row view.
 */

import Button from '../ui/Button';
import './org-components.css';

const TeamIcon = () => (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
        <circle cx="9" cy="7" r="4"/>
        <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
        <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
    </svg>
);

function TeamCard({
    team,
    orgName,
    inline = false,
    onClick,
    onChat,
    onManage
}) {
    if (!team) return null;

    const handleClick = () => {
        if (onClick) onClick(team);
    };

    const handleChatClick = (e) => {
        e.stopPropagation();
        if (onChat) onChat(team);
    };

    const handleManageClick = (e) => {
        e.stopPropagation();
        if (onManage) onManage(team);
    };

    const getRoleBadge = () => {
        const role = team.my_role || 'member';
        switch (role.toLowerCase()) {
            case 'admin':
                return <span className="entity-badge entity-badge--admin">Admin</span>;
            case 'viewer':
                return <span className="entity-badge entity-badge--viewer">Viewer</span>;
            default:
                return <span className="entity-badge entity-badge--member">Member</span>;
        }
    };

    // Inline variant - compact row style
    if (inline) {
        return (
            <div
                className="org-components team-card--inline entity-card"
                onClick={handleClick}
                role={onClick ? 'button' : undefined}
                tabIndex={onClick ? 0 : undefined}
                onKeyDown={(e) => onClick && e.key === 'Enter' && handleClick()}
            >
                <div className="entity-avatar entity-avatar--sm entity-avatar--team">
                    <TeamIcon />
                </div>
                <div className="entity-card__content">
                    <h4 className="entity-card__name">{team.name}</h4>
                    <p className="entity-card__description">
                        {team.description || 'No description'}
                    </p>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginLeft: 'auto' }}>
                    <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                        {team.member_count || 0} members
                    </span>
                    {team.my_role && getRoleBadge()}
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
                    <div className="entity-avatar entity-avatar--md entity-avatar--team">
                        <TeamIcon />
                    </div>
                    <div className="entity-card__title-block">
                        <h3 className="entity-card__name">{team.name}</h3>
                        <span className="entity-card__subtitle">
                            {orgName || team.org_name || 'Team'}
                        </span>
                    </div>
                </div>
                {team.my_role && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        {getRoleBadge()}
                    </div>
                )}
            </div>

            {/* Content */}
            <div className="entity-card__content">
                <p className="entity-card__description">
                    {team.description || 'No description provided'}
                </p>
            </div>

            {/* Stats */}
            <div className="entity-card__stats">
                <div className="entity-stat">
                    <span className="entity-stat__value">{team.member_count || 0}</span>
                    <span className="entity-stat__label">Members</span>
                </div>
                <div className="entity-stat">
                    <span className="entity-stat__value">{team.project_count || 0}</span>
                    <span className="entity-stat__label">Projects</span>
                </div>
                <div className="entity-stat">
                    <span className="entity-stat__value">{team.workflow_count || 0}</span>
                    <span className="entity-stat__label">Workflows</span>
                </div>
            </div>

            {/* Footer Actions */}
            {(onChat || onManage) && (
                <div className="entity-card__footer">
                    <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                        Team Assistant available
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

// Skeleton loader for TeamCard
export function TeamCardSkeleton({ inline = false }) {
    if (inline) {
        return (
            <div className="org-components team-card--inline skeleton-card">
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

export default TeamCard;
