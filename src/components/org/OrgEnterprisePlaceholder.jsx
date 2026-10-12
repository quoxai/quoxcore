/**
 * OrgEnterprisePlaceholder — inert enterprise-coming cards.
 *
 * These sit on the org page to visualize the roadmap without faking
 * any functionality. Each card is a named panel showing what will
 * land with the Enterprise teams stream. No handlers, no mock data.
 */

const LockIcon = () => (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.75">
        <rect x="3" y="11" width="18" height="11" rx="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
);

const ICONS = {
    roles: (
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M20 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M4 21v-2a4 4 0 0 1 4-4h4" />
            <circle cx="10" cy="7" r="4" />
            <path d="M17 11l2 2 4-4" />
        </svg>
    ),
    sso: (
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            <polyline points="9 11 12 14 15 11" />
        </svg>
    ),
    audit: (
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="9" y1="13" x2="15" y2="13" />
            <line x1="9" y1="17" x2="13" y2="17" />
        </svg>
    ),
    budget: (
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6">
            <line x1="12" y1="1" x2="12" y2="23" />
            <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
        </svg>
    ),
};

const CARDS = [
    {
        key: 'roles',
        title: 'Roles & Permissions',
        desc: 'Fine-grained RBAC per scope. Assign custom roles to division leads, department admins, and team members.',
        accent: '#a78bfa',
        icon: ICONS.roles,
    },
    {
        key: 'sso',
        title: 'SSO & Identity',
        desc: 'SAML / OIDC federation, SCIM provisioning, and org-level MFA policy enforcement.',
        accent: '#38bdf8',
        icon: ICONS.sso,
    },
    {
        key: 'audit',
        title: 'Audit Trail',
        desc: 'Every scope change, member action, and agent execution surfaced in one filterable timeline.',
        accent: '#22c55e',
        icon: ICONS.audit,
    },
    {
        key: 'budget',
        title: 'Budget & Cost',
        desc: 'Per-division spend caps, token budget allocation, and cost telemetry per agent.',
        accent: '#f59e0b',
        icon: ICONS.budget,
    },
];

export default function OrgEnterprisePlaceholder() {
    return (
        <div className="qx-card org-enterprise-placeholder">
            <div className="org-enterprise-placeholder__head">
                <div className="org-enterprise-placeholder__title-group">
                    <h3 className="org-enterprise-placeholder__title">Coming with Enterprise</h3>
                    <span className="org-enterprise-placeholder__tag">
                        <LockIcon />
                        <span>Teams tier</span>
                    </span>
                </div>
                <span className="org-enterprise-placeholder__sub">Preview of management surfaces</span>
            </div>
            <div className="org-enterprise-placeholder__grid">
                {CARDS.map(c => (
                    <div
                        key={c.key}
                        className="org-enterprise-placeholder__card"
                        style={{ '--ep-accent': c.accent }}
                    >
                        <div className="org-enterprise-placeholder__card-icon">{c.icon}</div>
                        <div className="org-enterprise-placeholder__card-body">
                            <div className="org-enterprise-placeholder__card-title">{c.title}</div>
                            <p className="org-enterprise-placeholder__card-desc">{c.desc}</p>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
