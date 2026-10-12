/**
 * OrgAssistantPanel — default org-scope assistant + embedded chat.
 *
 * Sidebar-native: a single glass .qx-card containing the assistant
 * identity block at top and the chat panel underneath. The scope
 * assistant is auto-created on POST /orgs — see
 * services/auth/routes/orgs.js:~142. If it's missing (legacy org
 * before the auto-create landed) we show an empty state.
 */

import { useNavigate } from 'react-router-dom';
import ScopeChatPanel from '../scope/ScopeChatPanel';
import Button from '../ui/Button';

const AssistantIcon = () => (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3" y="11" width="18" height="10" rx="2" />
        <circle cx="12" cy="5" r="2" />
        <path d="M12 7v4" />
        <circle cx="8" cy="16" r="1" fill="currentColor" />
        <circle cx="16" cy="16" r="1" fill="currentColor" />
    </svg>
);

const SettingsIcon = () => (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="12" cy="12" r="3" />
        <path d="M12 1v6m0 10v6M4.22 4.22l4.24 4.24m7.07 7.07l4.24 4.24M1 12h6m10 0h6M4.22 19.78l4.24-4.24m7.07-7.07l4.24-4.24" />
    </svg>
);

export default function OrgAssistantPanel({
    entityType = 'org',
    entityId,
    entityName,
    entityScopeId,
    scopeAssistant,
    accentColour,
    members,
    teams,
    childEntities,
}) {
    const navigate = useNavigate();

    if (!scopeAssistant) {
        return (
            <div className="qx-card org-assistant-panel org-assistant-panel--empty">
                <div className="org-assistant-panel__header">
                    <div className="org-assistant-panel__avatar" style={{ color: accentColour }}>
                        <AssistantIcon />
                    </div>
                    <div className="org-assistant-panel__identity">
                        <h4 className="org-assistant-panel__name">{entityName} Assistant</h4>
                        <span className="org-assistant-panel__scope-label">Not yet created</span>
                    </div>
                </div>
                <p className="org-assistant-panel__empty-msg">
                    Every organisation auto-creates its own scope assistant. This org was
                    created before that feature shipped — recreate it or ask an admin to
                    generate one.
                </p>
            </div>
        );
    }

    const handleConfigure = () => {
        navigate('/assistants', {
            state: {
                assistantId: scopeAssistant.id,
                configureAssistant: true,
            },
        });
    };

    return (
        <div className="qx-card org-assistant-panel">
            <div className="org-assistant-panel__header">
                <div className="org-assistant-panel__avatar" style={{ color: accentColour }}>
                    <AssistantIcon />
                </div>
                <div className="org-assistant-panel__identity">
                    <h4 className="org-assistant-panel__name">{scopeAssistant.name}</h4>
                    <span className="org-assistant-panel__scope-label">Organisation assistant</span>
                </div>
                <Button
                    size="sm"
                    variant="ghost"
                    onClick={handleConfigure}
                    title="Configure assistant"
                    aria-label="Configure assistant"
                >
                    <SettingsIcon />
                </Button>
            </div>

            <div className="org-assistant-panel__chat">
                <ScopeChatPanel
                    entityType={entityType}
                    entityId={entityId}
                    entityName={entityName}
                    scopeId={entityScopeId}
                    scopeAssistant={scopeAssistant}
                    members={members}
                    teams={teams}
                    childEntities={childEntities}
                    accentColour={accentColour}
                />
            </div>
        </div>
    );
}
