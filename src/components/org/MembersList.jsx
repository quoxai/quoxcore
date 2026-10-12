/**
 * MembersList - Role Management Component
 *
 * Displays and manages members with role editing capabilities.
 * Used in organization and division management views.
 */

import { useState } from 'react';
import Button from '../ui/Button';
import './org-components.css';

const ROLES = [
    { value: 'owner', label: 'Owner' },
    { value: 'admin', label: 'Admin' },
    { value: 'member', label: 'Member' },
    { value: 'viewer', label: 'Viewer' }
];

function MemberRow({
    member,
    canEdit = false,
    canRemove = false,
    onRoleChange,
    onRemove,
    currentUserId
}) {
    const [isEditing, setIsEditing] = useState(false);
    const isCurrentUser = member.id === currentUserId || member.user_id === currentUserId;
    const memberRole = member.role?.toLowerCase() || 'member';

    const handleRoleChange = (e) => {
        if (onRoleChange) {
            onRoleChange(member.id || member.user_id, e.target.value);
        }
        setIsEditing(false);
    };

    const getInitials = () => {
        if (member.name && member.name.trim()) {
            const parts = member.name.trim().split(' ').filter(n => n.length > 0);
            if (parts.length > 0) {
                return parts.map(n => n[0]).join('').toUpperCase().slice(0, 2);
            }
        }
        if (member.email && member.email.includes('@')) {
            return member.email.split('@')[0][0]?.toUpperCase() || '?';
        }
        if (member.email) {
            return member.email[0]?.toUpperCase() || '?';
        }
        return '?';
    };

    return (
        <div className="member-row">
            <div className="member-row__avatar">
                {member.avatar_url ? (
                    <img src={member.avatar_url} alt={member.name || member.email} />
                ) : (
                    getInitials()
                )}
            </div>

            <div className="member-row__info">
                <div className="member-row__name">
                    {member.name || (member.email?.includes('@') ? member.email.split('@')[0] : member.email) || 'Unknown'}
                    {isCurrentUser && (
                        <span style={{
                            marginLeft: '8px',
                            fontSize: '11px',
                            color: 'var(--text-muted)',
                            fontWeight: 400
                        }}>
                            (you)
                        </span>
                    )}
                </div>
                <div className="member-row__email">{member.email}</div>
            </div>

            <div className="member-row__role">
                {canEdit && !isCurrentUser ? (
                    <select
                        className="role-select"
                        value={memberRole}
                        onChange={handleRoleChange}
                    >
                        {ROLES.map(role => (
                            <option key={role.value} value={role.value}>
                                {role.label}
                            </option>
                        ))}
                    </select>
                ) : (
                    <span className={`entity-badge entity-badge--${memberRole}`}>
                        {memberRole.charAt(0).toUpperCase() + memberRole.slice(1)}
                    </span>
                )}
            </div>

            {canRemove && !isCurrentUser && (
                <div className="member-row__actions">
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onRemove(member.id || member.user_id)}
                        title="Remove member"
                        style={{ color: 'var(--text-muted)' }}
                    >
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <line x1="18" y1="6" x2="6" y2="18"/>
                            <line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                    </Button>
                </div>
            )}
        </div>
    );
}

function PendingInviteRow({ invite }) {
    if (!invite?.email) return null;

    const getInitial = () => {
        if (invite.email.includes('@')) {
            return invite.email.split('@')[0][0]?.toUpperCase() || '?';
        }
        return invite.email[0]?.toUpperCase() || '?';
    };

    return (
        <div className="member-row member-row--pending">
            <div className="member-row__avatar" style={{ opacity: 0.5 }}>
                {getInitial()}
            </div>
            <div className="member-row__info">
                <div className="member-row__name" style={{ opacity: 0.7 }}>
                    {invite.email}
                </div>
                <div className="member-row__email" style={{ fontSize: '11px' }}>
                    Invited as {invite.role || 'member'}
                </div>
            </div>
            <div className="member-row__role">
                <span className="entity-badge entity-badge--pending"
                    style={{
                        background: 'rgba(251, 191, 36, 0.12)',
                        color: '#fbbf24',
                        border: '1px solid rgba(251, 191, 36, 0.2)',
                        fontSize: '11px',
                        padding: '2px 8px',
                        borderRadius: '12px',
                    }}
                >
                    Pending
                </span>
            </div>
        </div>
    );
}

function MembersList({
    members = [],
    pendingInvites = [],
    loading = false,
    canEdit = false,
    canRemove = false,
    canInvite = false,
    currentUserId,
    onRoleChange,
    onRemove,
    onInvite,
    emptyMessage = 'No members yet'
}) {
    if (loading) {
        return (
            <div className="org-components members-list">
                {[1, 2, 3].map(i => (
                    <div key={i} className="member-row skeleton-card">
                        <div className="skeleton" style={{ width: 36, height: 36, borderRadius: '50%' }} />
                        <div className="member-row__info" style={{ flex: 1 }}>
                            <div className="skeleton-text" style={{ width: '40%' }} />
                            <div className="skeleton-text skeleton-text--short" style={{ marginTop: 4 }} />
                        </div>
                    </div>
                ))}
            </div>
        );
    }

    if (members.length === 0) {
        return (
            <div className="org-components entity-empty-state" style={{ padding: '32px 16px' }}>
                <div className="entity-empty-state__icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                        <circle cx="9" cy="7" r="4"/>
                        <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                        <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                    </svg>
                </div>
                <div className="entity-empty-state__title">{emptyMessage}</div>
                {canInvite && onInvite && (
                    <Button
                        size="sm"
                        variant="primary"
                        onClick={onInvite}
                        style={{ marginTop: '16px' }}
                    >
                        Invite Members
                    </Button>
                )}
            </div>
        );
    }

    // Sort members: owners first, then admins, then alphabetically
    const sortedMembers = [...members].sort((a, b) => {
        const roleOrder = { owner: 0, admin: 1, member: 2, viewer: 3 };
        const aRole = roleOrder[a.role?.toLowerCase()] ?? 2;
        const bRole = roleOrder[b.role?.toLowerCase()] ?? 2;
        if (aRole !== bRole) return aRole - bRole;
        const aName = a.name || a.email || '';
        const bName = b.name || b.email || '';
        return aName.localeCompare(bName);
    });

    return (
        <div className="org-components members-list">
            {sortedMembers.map(member => (
                <MemberRow
                    key={member.id || member.user_id}
                    member={member}
                    canEdit={canEdit}
                    canRemove={canRemove}
                    currentUserId={currentUserId}
                    onRoleChange={onRoleChange}
                    onRemove={onRemove}
                />
            ))}

            {pendingInvites.length > 0 && (
                <>
                    <div style={{
                        fontSize: '11px',
                        fontWeight: 600,
                        textTransform: 'uppercase',
                        letterSpacing: '0.5px',
                        color: 'var(--text-muted, #71717a)',
                        padding: '8px 0 4px',
                        marginTop: '4px',
                    }}>
                        Pending Invites ({pendingInvites.length})
                    </div>
                    {pendingInvites.map(invite => (
                        <PendingInviteRow key={invite.id || invite.email} invite={invite} />
                    ))}
                </>
            )}

            {canInvite && onInvite && (
                <button
                    onClick={onInvite}
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '12px',
                        width: '100%',
                        padding: '12px',
                        background: 'transparent',
                        border: '1px dashed rgba(255, 255, 255, 0.1)',
                        borderRadius: '8px',
                        color: 'var(--text-muted)',
                        cursor: 'pointer',
                        fontSize: '14px',
                        transition: 'all 0.15s ease'
                    }}
                    onMouseEnter={(e) => {
                        e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.2)';
                        e.currentTarget.style.color = 'var(--text-secondary)';
                    }}
                    onMouseLeave={(e) => {
                        e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)';
                        e.currentTarget.style.color = 'var(--text-muted)';
                    }}
                >
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <circle cx="12" cy="12" r="10"/>
                        <line x1="12" y1="8" x2="12" y2="16"/>
                        <line x1="8" y1="12" x2="16" y2="12"/>
                    </svg>
                    Invite member
                </button>
            )}
        </div>
    );
}

export default MembersList;
