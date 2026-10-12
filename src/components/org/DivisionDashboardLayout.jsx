/**
 * DivisionDashboardLayout — /divisions/:divisionId page layout.
 *
 * Mirrors OrgDashboardLayout structure at division scope:
 *   - Same 3-column shell (.org-dashboard + .org-dashboard__grid)
 *   - Reuses all the stacked glass panels (assistant, hierarchy,
 *     meta, quick actions, members, teams, activity, enterprise)
 *   - Replaces the Divisions panel with DivisionDepartmentsPanel
 *     (children at division scope are departments)
 *   - Stats strip is scope-aware: drops the "Divisions" tile
 *
 * Department + team views follow the same pattern (next phase).
 */

import { useNavigate } from 'react-router-dom';
import { EntityModal, ConfirmModal, InviteMemberModal } from '.';
import Button from '../ui/Button';
import { useAuth } from '../../contexts/AuthContext';

import ScopeHeader from '../scope/ScopeHeader';
import OrgStatsStrip from './OrgStatsStrip';
import OrgHierarchyPanel from './OrgHierarchyPanel';
import OrgAssistantPanel from './OrgAssistantPanel';
import OrgMetaPanel from './OrgMetaPanel';
import DivisionDepartmentsPanel from './DivisionDepartmentsPanel';
import OrgMembersGrid from './OrgMembersGrid';
import OrgTeamsPanel from './OrgTeamsPanel';
import OrgQuickActionsPanel from './OrgQuickActionsPanel';
import OrgActivityPanel from './OrgActivityPanel';
import OrgEnterprisePlaceholder from './OrgEnterprisePlaceholder';
import './org-dashboard.css';

export default function DivisionDashboardLayout({ data }) {
    const navigate = useNavigate();

    const {
        entity, entityType, entityId, orgId, parentEntity, loading,
        accentColour, childLabel, entityScopeId, scopeAssistant, scopeStats,
        scopeTree,
        children, teams, members, pendingInvites, reloadMembers,
        name, setName, description, setDescription,
        logoImgError, setLogoImgError,
        hasChanges, saving, isAdmin,
        showCreateChild, setShowCreateChild,
        showCreateTeam, setShowCreateTeam,
        showDeleteConfirm, setShowDeleteConfirm,
        showInviteModal, setShowInviteModal,
        creatingChild, creatingTeam, deleting,
        handleSave, handleDelete, handleCreateChild, handleCreateTeam,
        handleNavigateToParent,
    } = data;

    // ---------- Loading ----------
    if (loading) {
        return (
            <div className="org-dashboard">
                <div className="org-dashboard__loading">
                    <div className="org-dashboard__loading-spinner" />
                    <span>Loading division…</span>
                </div>
            </div>
        );
    }

    // ---------- Not found ----------
    if (!entity) {
        return (
            <div className="org-dashboard">
                <div className="org-dashboard__not-found">
                    <h2>Division Not Found</h2>
                    <p>The division you're looking for doesn't exist or you don't have access.</p>
                    <Button variant="primary" onClick={() => navigate('/divisions')}>Back to Divisions</Button>
                </div>
            </div>
        );
    }

    const handleBack = () => {
        if (parentEntity) navigate(`/orgs/${parentEntity.id}`);
        else navigate('/divisions');
    };

    return (
        <div className="org-dashboard" style={{ '--scope-accent': accentColour }}>
            <div className="org-dashboard__grid">
                {/* Left sidebar — quick actions + details + hierarchy */}
                <aside className="org-dashboard__aside org-dashboard__aside--left">
                    <OrgQuickActionsPanel
                        isAdmin={isAdmin}
                        entityScopeId={entityScopeId}
                        onCreateDivision={isAdmin ? () => setShowCreateChild(true) : undefined}
                        onInviteMember={isAdmin ? () => setShowInviteModal(true) : undefined}
                    />
                    <OrgMetaPanel entity={entity} entityScopeId={entityScopeId} />
                    <OrgHierarchyPanel
                        scopeTree={scopeTree}
                        activeEntityId={entityId}
                    />
                </aside>

                {/* Main column */}
                <div className="org-dashboard__main">
                    <ScopeHeader
                        entityType={entityType}
                        name={name}
                        description={description}
                        logoImgError={logoImgError}
                        isAdmin={isAdmin}
                        accentColour={accentColour}
                        parentEntity={parentEntity}
                        entity={entity}
                        memberCount={members.length}
                        childCount={children.length}
                        teamCount={teams.length}
                        childLabel={childLabel?.plural || 'Departments'}
                        entityLabel="Division"
                        onInviteMember={isAdmin ? () => setShowInviteModal(true) : undefined}
                        onViewInbox
                        onDelete={isAdmin ? () => setShowDeleteConfirm(true) : undefined}
                        onAddChild={isAdmin ? () => setShowCreateChild(true) : undefined}
                        onBack={handleBack}
                        onLogoImgError={() => setLogoImgError(true)}
                        onNameChange={isAdmin ? setName : undefined}
                        onDescriptionChange={isAdmin ? setDescription : undefined}
                        hasChanges={hasChanges}
                        saving={saving}
                        onSave={handleSave}
                        entityScopeId={entityScopeId}
                    />
                    <OrgStatsStrip stats={scopeStats} entityType={entityType} />
                    <DivisionDepartmentsPanel
                        departments={children}
                        isAdmin={isAdmin}
                        onCreateDepartment={isAdmin ? () => setShowCreateChild(true) : undefined}
                    />
                    <OrgMembersGrid
                        members={members}
                        pendingInvites={pendingInvites}
                        isAdmin={isAdmin}
                        onInviteMember={isAdmin ? () => setShowInviteModal(true) : undefined}
                        orgId={orgId || entity?.org_id || entityId}
                        onCustomRoleAssigned={reloadMembers}
                    />
                    <OrgTeamsPanel
                        teams={teams}
                        isAdmin={isAdmin}
                        onCreateTeam={isAdmin ? () => setShowCreateTeam(true) : undefined}
                    />
                    <OrgActivityPanel />
                    <OrgEnterprisePlaceholder />
                </div>

                {/* Right sidebar — division assistant only */}
                <aside className="org-dashboard__aside org-dashboard__aside--right">
                    <OrgAssistantPanel
                        entityType={entityType}
                        entityId={entityId}
                        entityName={name}
                        entityScopeId={entityScopeId}
                        scopeAssistant={scopeAssistant}
                        accentColour={accentColour}
                        members={members}
                        teams={teams}
                        childEntities={children}
                    />
                </aside>
            </div>

            {/* ---- Modals ---- */}
            {entityType === 'division' && (
                <EntityModal
                    isOpen={showCreateChild}
                    onClose={() => setShowCreateChild(false)}
                    onSubmit={handleCreateChild}
                    title="Create Department"
                    submitLabel="Create Department"
                    entityType="department"
                    parentName={name}
                    loading={creatingChild}
                />
            )}

            <EntityModal
                isOpen={showCreateTeam}
                onClose={() => setShowCreateTeam(false)}
                onSubmit={handleCreateTeam}
                title="Create Team"
                submitLabel="Create Team"
                entityType="team"
                parentName={name}
                loading={creatingTeam}
            />

            <ConfirmModal
                isOpen={showDeleteConfirm}
                onClose={() => !deleting && setShowDeleteConfirm(false)}
                onConfirm={handleDelete}
                title="Delete Division"
                message={`Are you sure you want to delete "${name}"? This action cannot be undone and will remove all departments, teams, and data.`}
                confirmLabel="Delete Division"
                danger
                loading={deleting}
            />

            <InviteMemberModal
                isOpen={showInviteModal}
                onClose={() => setShowInviteModal(false)}
                orgId={orgId || entity?.org_id || entityId}
                orgName={entity?.org_name || name}
                onSuccess={() => {}}
            />
        </div>
    );
}
