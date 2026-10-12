/**
 * ScopeAssistantCard - Universal Assistant Card
 *
 * Displays an AI assistant card for any scope level:
 * - Organization assistant
 * - Division assistant
 * - Team assistant (Phase C)
 */

import Button from '../ui/Button';
import './org-components.css';

const AssistantIcon = () => (
    <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3" y="11" width="18" height="10" rx="2"/>
        <circle cx="12" cy="5" r="2"/>
        <path d="M12 7v4"/>
        <circle cx="8" cy="16" r="1"/>
        <circle cx="16" cy="16" r="1"/>
    </svg>
);

const ChatIcon = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    </svg>
);

const SettingsIcon = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="12" cy="12" r="3"/>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </svg>
);

// Scope type descriptions
const SCOPE_DESCRIPTIONS = {
    org: 'A dedicated AI assistant with full knowledge of this organisation\'s context, projects, and preferences.',
    division: 'A focused assistant specializing in this division\'s domain, processes, and team knowledge.',
    department: 'A specialist assistant focused on this department\'s responsibilities, workflows, and team coordination.',
    team: 'A collaborative assistant that understands this team\'s workflows, members, and current projects.'
};

const SCOPE_LABELS = {
    org: 'Organisation',
    division: 'Division',
    department: 'Department',
    team: 'Team'
};

function ScopeAssistantCard({
    name,
    scope = 'org',  // 'org' | 'division' | 'team'
    description,
    onChat,
    onConfigure,
    status = 'active',  // 'active' | 'inactive' | 'configuring'
    messageCount,
    lastActive
}) {
    const scopeLabel = SCOPE_LABELS[scope] || 'Scope';
    const defaultDescription = SCOPE_DESCRIPTIONS[scope] || 'AI assistant for this scope.';

    return (
        <div className="org-components assistant-card">
            <div className="assistant-card__avatar">
                <AssistantIcon />
            </div>

            <div className="assistant-card__info">
                <h4 className="assistant-card__name">
                    {name || `${scopeLabel} Assistant`}
                </h4>
                <p className="assistant-card__description">
                    {description || defaultDescription}
                </p>
                <div className="assistant-card__scope">
                    {scopeLabel} Level
                    {status === 'active' && messageCount !== undefined && (
                        <span style={{ marginLeft: '12px', opacity: 0.7 }}>
                            {messageCount} conversations
                        </span>
                    )}
                </div>
            </div>

            <div className="assistant-card__action" style={{ display: 'flex', gap: '8px' }}>
                {onConfigure && (
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={onConfigure}
                        title="Configure assistant"
                    >
                        <SettingsIcon />
                    </Button>
                )}
                {onChat && (
                    <Button
                        size="sm"
                        variant="secondary"
                        onClick={onChat}
                    >
                        <ChatIcon />
                        <span style={{ marginLeft: '6px' }}>Chat</span>
                    </Button>
                )}
            </div>
        </div>
    );
}

// Compact version for inline use
export function ScopeAssistantBadge({
    name,
    scope = 'org',
    onClick
}) {
    return (
        <button
            className="org-components"
            onClick={onClick}
            style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
                padding: '6px 12px',
                background: 'rgba(191, 90, 242, 0.1)',
                border: '1px solid rgba(191, 90, 242, 0.2)',
                borderRadius: '8px',
                cursor: 'pointer',
                transition: 'all 0.15s ease'
            }}
        >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#bf5af2" strokeWidth="1.5">
                <rect x="3" y="11" width="18" height="10" rx="2"/>
                <circle cx="12" cy="5" r="2"/>
                <path d="M12 7v4"/>
            </svg>
            <span style={{ fontSize: '13px', color: '#bf5af2', fontWeight: 500 }}>
                {name || `${SCOPE_LABELS[scope]} Assistant`}
            </span>
        </button>
    );
}

export default ScopeAssistantCard;
