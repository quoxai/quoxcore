/**
 * ComingSoonSection - Placeholder for Upcoming Features
 *
 * Displays a styled placeholder for features that are planned
 * but not yet implemented (Teams, Inbox, HITL, etc.).
 */

import './org-components.css';

const FEATURE_ICONS = {
    teams: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
            <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
        </svg>
    ),
    inbox: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/>
            <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>
        </svg>
    ),
    approvals: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M9 11l3 3L22 4"/>
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
        </svg>
    ),
    hitl: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="12" cy="12" r="10"/>
            <path d="M12 16v-4"/>
            <path d="M12 8h.01"/>
        </svg>
    ),
    workflows: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <line x1="6" y1="3" x2="6" y2="15"/>
            <circle cx="18" cy="6" r="3"/>
            <circle cx="6" cy="18" r="3"/>
            <path d="M18 9a9 9 0 0 1-9 9"/>
        </svg>
    ),
    default: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="12" cy="12" r="10"/>
            <polyline points="12 6 12 12 16 14"/>
        </svg>
    )
};

const PHASE_LABELS = {
    A: 'Phase A',
    B: 'Phase B',
    C: 'Phase C',
    D: 'Phase D'
};

function ComingSoonSection({
    title = 'Coming Soon',
    description,
    feature = 'default',  // 'teams' | 'inbox' | 'approvals' | 'hitl' | 'workflows' | 'default'
    phase,                // 'A' | 'B' | 'C' | 'D'
    learnMoreUrl,
    compact = false
}) {
    const icon = FEATURE_ICONS[feature] || FEATURE_ICONS.default;
    const phaseLabel = phase ? PHASE_LABELS[phase] : null;

    const defaultDescriptions = {
        teams: 'Create and manage teams within divisions. Assign members, set permissions, and enable team-level AI assistants.',
        inbox: 'A unified inbox for human-in-the-loop approvals, notifications, and AI-generated tasks requiring review.',
        approvals: 'Review and approve AI-suggested actions before they execute. Set up approval workflows and policies.',
        hitl: 'Human-in-the-loop workflows for critical operations. Get notified via Slack, email, or Telegram.',
        workflows: 'Visual workflow builder to create automated processes with human checkpoints and AI assistance.'
    };

    if (compact) {
        return (
            <div className="org-components" style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '16px',
                background: 'rgba(255, 255, 255, 0.02)',
                border: '1px dashed rgba(255, 255, 255, 0.1)',
                borderRadius: '8px'
            }}>
                <div style={{ width: '24px', height: '24px', opacity: 0.4 }}>
                    {icon}
                </div>
                <span style={{ flex: 1, color: 'var(--text-secondary)', fontSize: '14px' }}>
                    {title}
                </span>
                {phaseLabel && (
                    <span style={{
                        padding: '2px 8px',
                        background: 'rgba(255, 214, 10, 0.1)',
                        border: '1px solid rgba(255, 214, 10, 0.2)',
                        borderRadius: '100px',
                        fontSize: '10px',
                        fontWeight: 600,
                        color: '#ffd60a',
                        textTransform: 'uppercase'
                    }}>
                        {phaseLabel}
                    </span>
                )}
            </div>
        );
    }

    return (
        <div className="org-components coming-soon">
            <div className="coming-soon__icon">
                {icon}
            </div>
            <h4 className="coming-soon__title">{title}</h4>
            <p className="coming-soon__description">
                {description || defaultDescriptions[feature] || 'This feature is currently in development.'}
            </p>
            {phaseLabel && (
                <span className="coming-soon__badge">{phaseLabel}</span>
            )}
            {learnMoreUrl && (
                <a
                    href={learnMoreUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                        display: 'inline-block',
                        marginTop: '12px',
                        fontSize: '13px',
                        color: 'var(--accent-primary)',
                        textDecoration: 'none'
                    }}
                >
                    Learn more
                </a>
            )}
        </div>
    );
}

// Section header with coming soon badge
export function ComingSoonHeader({
    title,
    phase
}) {
    return (
        <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            marginBottom: '16px'
        }}>
            <h3 style={{
                margin: 0,
                fontSize: '16px',
                fontWeight: 600,
                color: 'var(--text-secondary)'
            }}>
                {title}
            </h3>
            <span style={{
                padding: '2px 10px',
                background: 'rgba(255, 214, 10, 0.1)',
                border: '1px solid rgba(255, 214, 10, 0.2)',
                borderRadius: '100px',
                fontSize: '10px',
                fontWeight: 600,
                color: '#ffd60a',
                textTransform: 'uppercase',
                letterSpacing: '0.5px'
            }}>
                Coming {phase ? `in Phase ${phase}` : 'Soon'}
            </span>
        </div>
    );
}

export default ComingSoonSection;
