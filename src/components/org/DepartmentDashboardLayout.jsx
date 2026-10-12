/**
 * DepartmentDashboardLayout — /departments/:departmentId page layout.
 *
 * Leaf-level organisational scope. Teams are the primary content
 * (no further sub-scopes below department). Otherwise structurally
 * identical to Division/Org layouts.
 */

import { useNavigate } from 'react-router-dom';
import { EntityModal, ConfirmModal, InviteMemberModal } from '.';
import Button from '../ui/Button';

import ScopeHeader from '../scope/ScopeHeader';
import OrgStatsStrip from './OrgStatsStrip';
import OrgHierarchyPanel from './OrgHierarchyPanel';
import OrgAssistantPanel from './OrgAssistantPanel';
import OrgMetaPanel from './OrgMetaPanel';
import OrgMembersGrid from './OrgMembersGrid';
import DepartmentTeamsPanel from './DepartmentTeamsPanel';
import OrgQuickActionsPanel from './OrgQuickActionsPanel';
import OrgActivityPanel from './OrgActivityPanel';
import OrgEnterprisePlaceholder from './OrgEnterprisePlaceholder';
import './org-dashboard.css';

export default function DepartmentDashboardLayout({ data }) {
    const navigate = useNavigate();

    const {
        entity, entityType, entityId, orgId, parentEntity, loading,
        accentColour, entityScopeId, scopeAssistant, scopeStats,
        scopeTree,
        teams, members, pendingInvites, reloadMembers,
        name, setName, description, setDescription,
        logoImgError, setLogoImgError,
        hasChanges, saving, isAdmin,
        showCreateTeam, setShowCreateTeam,
        showDeleteConfirm, setShowDeleteConfirm,
        showInviteModal, setShowInviteModal,
        creatingTeam, deleting,
        handleSave, handleDelete, handleCreateTeam,
    } = data;

    if (loading) {
        return (
            <div className="org-dashboard">
                <div className="org-dashboard__loading">
                    <div className="org-dashboard__loading-spinner" />
                    <span>Loading department…</span>
                </div>
            </div>
        );
    }

    if (!entity) {
        return (
            <div className="org-dashboard">
                <div className="org-dashboard__not-found">
                    <h2>Department Not Found</h2>
                    <p>The department you're looking for doesn't exist or you don't have access.</p>
                    <Button variant="primary" onClick={() => navigate('/departments')}>Back to Departments</Button>
                </div>
            </div>
        );
    }

    const handleBack = () => {
        if (parentEntity) navigate(`/divisions/${parentEntity.id}`);
        else navigate('/departments');
    };

    return (
        <div className="org-dashboard" style={{ '--scope-accent': accentColour }}>
            <div className="org-dashboard__grid">
                {/* Left sidebar */}
                <aside className="org-dashboard__aside org-dashboard__aside--left">
                    <OrgQuickActionsPanel
                        isAdmin={isAdmin}
                        entityScopeId={entityScopeId}
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
                        teamCount={teams.length}
                        entityLabel="Department"
                        onInviteMember={isAdmin ? () => setShowInviteModal(true) : undefined}
                        onViewInbox
                        onDelete={isAdmin ? () => setShowDeleteConfirm(true) : undefined}
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
                    <DepartmentTeamsPanel
                        teams={teams}
                        isAdmin={isAdmin}
                        onCreateTeam={isAdmin ? () => setShowCreateTeam(true) : undefined}
                    />
                    <OrgMembersGrid
                        members={members}
                        pendingInvites={pendingInvites}
                        isAdmin={isAdmin}
                        onInviteMember={isAdmin ? () => setShowInviteModal(true) : undefined}
                        orgId={orgId || entity?.org_id || entityId}
                        onCustomRoleAssigned={reloadMembers}
                    />
                    <OrgActivityPanel />
                    <OrgEnterprisePlaceholder />
                </div>

                {/* Right sidebar — department assistant only */}
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
                        childEntities={[]}
                    />
                </aside>
            </div>

            {/* ---- Modals ---- */}

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
                title="Delete Department"
                message={`Are you sure you want to delete "${name}"? This action cannot be undone and will remove all teams in this department.`}
                confirmLabel="Delete Department"
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
