/**
 * OrgQuickActionsPanel — sidebar action list for org admins.
 *
 * One-row-per-action list. Icons + labels + keyboard affordance.
 * All handlers arrive from useScopeData or navigate.
 */

import { useNavigate } from 'react-router-dom';

const Icon = {
    division: (
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6">
            <polygon points="12 2 2 7 12 12 22 7 12 2" />
            <polyline points="2 17 12 22 22 17" />
            <polyline points="2 12 12 17 22 12" />
        </svg>
    ),
    invite: (
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
            <circle cx="8.5" cy="7" r="4" />
            <line x1="20" y1="8" x2="20" y2="14" />
            <line x1="23" y1="11" x2="17" y2="11" />
        </svg>
    ),
    logo: (
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
            <circle cx="12" cy="13" r="4" />
        </svg>
    ),
    inbox: (
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6">
            <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
            <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
        </svg>
    ),
    chevron: (
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.75">
            <polyline points="9 18 15 12 9 6" />
        </svg>
    ),
};

export default function OrgQuickActionsPanel({
    isAdmin = false,
    entityScopeId,
    onCreateDivision,
    onInviteMember,
    onUploadLogo,
}) {
    const navigate = useNavigate();

    if (!isAdmin) return null;

    const actions = [
        onCreateDivision && {
            key: 'division',
            label: 'Create Division',
            hint: 'Add an organisational unit',
            icon: Icon.division,
            onClick: onCreateDivision,
            accent: '#a78bfa',
        },
        onInviteMember && {
            key: 'invite',
            label: 'Invite Member',
            hint: 'Send an email invitation',
            icon: Icon.invite,
            onClick: onInviteMember,
            accent: '#22c55e',
        },
        onUploadLogo && {
            key: 'logo',
            label: 'Upload Logo',
            hint: 'Replace organisation logo',
            icon: Icon.logo,
            onClick: onUploadLogo,
            accent: '#f59e0b',
        },
        {
            key: 'inbox',
            label: 'View Inbox',
            hint: 'Scoped to this organisation',
            icon: Icon.inbox,
            onClick: () => navigate(entityScopeId ? `/inbox?scope=${entityScopeId}` : '/inbox'),
            accent: '#38bdf8',
        },
    ].filter(Boolean);

    return (
        <div className="qx-card org-quick-actions">
            <div className="org-quick-actions__head">
                <h4 className="org-quick-actions__title">Quick Actions</h4>
            </div>
            <div className="org-quick-actions__list">
                {actions.map(action => (
                    <button
                        key={action.key}
                        type="button"
                        className="org-quick-actions__item"
                        onClick={action.onClick}
                        style={{ '--action-accent': action.accent }}
                    >
                        <span className="org-quick-actions__item-icon">{action.icon}</span>
                        <span className="org-quick-actions__item-body">
                            <span className="org-quick-actions__item-label">{action.label}</span>
                            <span className="org-quick-actions__item-hint">{action.hint}</span>
                        </span>
                        <span className="org-quick-actions__item-chev">{Icon.chevron}</span>
                    </button>
                ))}
            </div>
        </div>
    );
}
