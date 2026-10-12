/**
 * OrgMembersGrid — directory of members for an organisation.
 *
 * Adapted from glass-concept OrgMemberDirectory:
 *  - Search box, filter pills, responsive card grid
 *  - Filter by role (derived from members[].role)
 *
 * Read-only this round. Role change + remove surfaces deferred to
 * Phase 7 (enterprise placeholders).
 */

import { useMemo, useState } from 'react';
import Button from '../ui/Button';
import CustomRoleAssignDialog from './CustomRoleAssignDialog';

const ROLE_COLOURS = {
    owner:   '#fbbf24',
    admin:   '#a78bfa',
    builder: '#3b82f6',
    runner:  '#06b6d4',
    viewer:  'rgba(255,255,255,0.7)',
    member:  'rgba(255,255,255,0.85)',
    auditor: '#22d3ee',
};

const ROLE_ORDER = ['owner', 'admin', 'builder', 'runner', 'member', 'viewer', 'auditor'];

function initials(name, email) {
    const source = name || email || '?';
    const parts = source.trim().split(/\s+/);
    if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
    return source.slice(0, 2).toUpperCase();
}

const SearchIcon = () => (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.75">
        <circle cx="11" cy="11" r="7" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
);

const InviteIcon = () => (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.75">
        <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="8.5" cy="7" r="4" />
        <line x1="20" y1="8" x2="20" y2="14" />
        <line x1="23" y1="11" x2="17" y2="11" />
    </svg>
);

export default function OrgMembersGrid({
    members = [],
    pendingInvites = [],
    isAdmin = false,
    onInviteMember,
    orgId,
    onCustomRoleAssigned,
}) {
    const [query, setQuery] = useState('');
    const [roleFilter, setRoleFilter] = useState('all');
    // ET-FINISH Phase 2: which member's custom-role overlay is being edited.
    const [editingMember, setEditingMember] = useState(null);

    const availableRoles = useMemo(() => {
        const set = new Set();
        members.forEach(m => set.add((m.role || 'member').toLowerCase()));
        return ROLE_ORDER.filter(r => set.has(r));
    }, [members]);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        return members.filter(m => {
            if (roleFilter !== 'all' && (m.role || 'member').toLowerCase() !== roleFilter) return false;
            if (!q) return true;
            return (m.name || '').toLowerCase().includes(q) || (m.email || '').toLowerCase().includes(q);
        });
    }, [members, query, roleFilter]);

    return (
        <div className="qx-card org-members-grid">
            <div className="org-members-grid__head">
                <div className="org-members-grid__title-group">
                    <h3 className="org-members-grid__title">Members</h3>
                    <span className="org-members-grid__meta">
                        {members.length}
                        {pendingInvites.length > 0 && (
                            <span className="org-members-grid__meta-sub">
                                {' '}· {pendingInvites.length} pending
                            </span>
                        )}
                    </span>
                </div>
                <div className="org-members-grid__head-actions">
                    <div className="org-members-grid__search">
                        <span className="org-members-grid__search-icon"><SearchIcon /></span>
                        <input
                            type="search"
                            value={query}
                            onChange={e => setQuery(e.target.value)}
                            placeholder="Search name or email…"
                            className="org-members-grid__search-input"
                        />
                    </div>
                    {isAdmin && onInviteMember && (
                        <Button size="sm" variant="secondary" onClick={onInviteMember}>
                            <InviteIcon />
                            <span>Invite</span>
                        </Button>
                    )}
                </div>
            </div>

            {availableRoles.length > 1 && (
                <div className="org-members-grid__pills">
                    <button
                        type="button"
                        className={`org-members-grid__pill${roleFilter === 'all' ? ' org-members-grid__pill--active' : ''}`}
                        onClick={() => setRoleFilter('all')}
                    >
                        All
                        <span className="org-members-grid__pill-count">{members.length}</span>
                    </button>
                    {availableRoles.map(role => {
                        const count = members.filter(m => (m.role || 'member').toLowerCase() === role).length;
                        const active = roleFilter === role;
                        return (
                            <button
                                key={role}
                                type="button"
                                className={`org-members-grid__pill${active ? ' org-members-grid__pill--active' : ''}`}
                                onClick={() => setRoleFilter(role)}
                                style={active ? { '--pill-accent': ROLE_COLOURS[role] || '#a78bfa' } : undefined}
                            >
                                {role}
                                <span className="org-members-grid__pill-count">{count}</span>
                            </button>
                        );
                    })}
                </div>
            )}

            {filtered.length === 0 ? (
                <div className="org-members-grid__empty">
                    {members.length === 0
                        ? 'No members yet. Invite people to get started.'
                        : 'No members match this filter.'}
                </div>
            ) : (
                <div className="org-members-grid__grid">
                    {filtered.map(m => {
                        const role = (m.role || 'member').toLowerCase();
                        const accent = ROLE_COLOURS[role] || ROLE_COLOURS.member;
                        return (
                            <div key={m.id} className="org-members-grid__card" style={{ '--member-accent': accent }}>
                                <div className="org-members-grid__avatar">
                                    {m.avatar_url ? (
                                        <img src={m.avatar_url} alt={m.name} />
                                    ) : (
                                        <span>{initials(m.name, m.email)}</span>
                                    )}
                                </div>
                                <div className="org-members-grid__info">
                                    <div className="org-members-grid__name" title={m.name}>{m.name}</div>
                                    <div className="org-members-grid__email" title={m.email}>{m.email}</div>
                                </div>
                                <span className="org-members-grid__role" style={{ color: accent }}>
                                    {role}
                                    {isAdmin && orgId && (
                                        <button
                                            type="button"
                                            className="org-members-grid__role-edit"
                                            onClick={() => setEditingMember(m)}
                                            aria-label={`Edit custom role for ${m.name || m.email}`}
                                        >
                                            edit
                                        </button>
                                    )}
                                </span>
                                {m.custom_role_id && m.custom_role_name && (
                                    <span className="org-members-grid__custom-role" title="Custom role overlay">
                                        + {m.custom_role_name}
                                    </span>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            {editingMember && orgId && (
                <CustomRoleAssignDialog
                    orgId={orgId}
                    member={editingMember}
                    onClose={() => setEditingMember(null)}
                    onAssigned={(payload) => {
                        if (onCustomRoleAssigned) onCustomRoleAssigned(payload);
                    }}
                />
            )}
        </div>
    );
}
