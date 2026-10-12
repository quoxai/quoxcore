/**
 * ScopeSidebar — Right sidebar for the scope dashboard.
 *
 * Contains: scope assistant chat, inbox link, parent navigation,
 * and collapsible danger zone.
 */

import { PageSection } from '../layout';
import ScopeChatPanel from './ScopeChatPanel';
import { ScopeAssistantCard } from '../org';
import './ScopeDashboard.css';

export default function ScopeSidebar({
    entityType,
    entity,
    name,
    // Chat props
    entityId,
    entityName,
    entityScopeId,
    scopeAssistant,
    accentColour,
    members = [],
    teams = [],
    childEntities = [],
    // Parent navigation
    parentEntity,
    onNavigateToParent,
    onConfigureAssistant,
}) {

    return (
        <div className="scope-sidebar">
            <PageSection title="Assistant">
                <ScopeAssistantCard
                    name={scopeAssistant?.name || `${entityName || name} Assistant`}
                    scope={entityType}
                    description={scopeAssistant?.description}
                    onConfigure={scopeAssistant ? onConfigureAssistant : undefined}
                />
            </PageSection>

            {/* Scope Assistant Chat */}
            <PageSection title={`${entityName || name} Assistant Chat`}>
                <ScopeChatPanel
                    entityType={entityType}
                    entityId={entityId}
                    entityName={entityName || name}
                    scopeId={entityScopeId}
                    scopeAssistant={scopeAssistant}
                    members={members}
                    teams={teams}
                    childEntities={childEntities}
                    accentColour={accentColour}
                />
            </PageSection>

            {/* Parent Navigation */}
            {parentEntity && onNavigateToParent && (
                <PageSection title={entityType === 'division' ? 'Organisation' : 'Division'}>
                    <button
                        className="scope-sidebar__parent-link"
                        onClick={onNavigateToParent}
                    >
                        <div className={`entity-avatar entity-avatar--sm entity-avatar--${entityType === 'division' ? 'org' : 'division'}`}>
                            {parentEntity.name?.[0]?.toUpperCase() || '?'}
                        </div>
                        <div className="scope-sidebar__parent-info">
                            <div className="scope-sidebar__parent-name">{parentEntity.name}</div>
                            <div className="scope-sidebar__parent-type">
                                {entityType === 'division' ? 'Parent organisation' : 'Parent division'}
                            </div>
                        </div>
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="var(--text-muted)" strokeWidth="2">
                            <polyline points="9 18 15 12 9 6" />
                        </svg>
                    </button>
                </PageSection>
            )}

        </div>
    );
}
