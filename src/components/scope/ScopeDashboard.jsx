/**
 * ScopeDashboard — Unified dashboard layout for org / division / department pages.
 *
 * Composes: ScopeHeader, ScopeOrgChart, and ScopeSidebar (with embedded chat).
 * One component, three wrappers.
 */

import { useNavigate } from 'react-router-dom';
import { EntityModal, ConfirmModal } from '../org';
import InviteMemberModal from '../org/InviteMemberModal';
import LogoUploadModal from '../org/LogoUploadModal';
import Button from '../ui/Button';
import { useAuth } from '../../contexts/AuthContext';

import ScopeHeader from './ScopeHeader';
import ScopeHUD from './ScopeHUD';
import ScopeOrgChart from './ScopeOrgChart';
import ScopeSidebar from './ScopeSidebar';
import './ScopeDashboard.css';

const CHILD_ENTITY_TYPE_MAP = {
    org: 'division',
    division: 'department',
    department: 'team',
};

export default function ScopeDashboard({ data }) {
    const navigate = useNavigate();
    const { authFetch } = useAuth();

    const {
        entity, entityType, entityId, orgId, parentEntity, loading,
        accentColour, childLabel, scopeTree, entityScopeId, scopeAssistant, departmentCount, scopeStats,
        children, childrenLoading, teams, teamsLoading,
        members, pendingInvites, membersLoading,
        name, setName, description, setDescription,
        logoUrl, setLogoUrl, logoImgError, setLogoImgError,
        hasChanges, saving, isAdmin, user,
        showCreateChild, setShowCreateChild,
        showCreateTeam, setShowCreateTeam,
        showDeleteConfirm, setShowDeleteConfirm,
        showInviteModal, setShowInviteModal,
        showLogoModal, setShowLogoModal,
        creatingChild, creatingTeam, deleting,
        handleSave, handleDelete, handleCreateChild, handleCreateTeam,
        handleRemoveLogo, handleRoleChange, handleRemoveMember,
        handleNavigateToParent,
    } = data;

    const childEntityType = CHILD_ENTITY_TYPE_MAP[entityType];

    const handleBack = () => {
        if (entityType === 'org') navigate('/orgs');
        else if (entityType === 'division') navigate(parentEntity ? `/orgs/${parentEntity.id}` : '/divisions');
        else if (entityType === 'department') navigate(parentEntity ? `/divisions/${parentEntity.id}` : '/divisions');
    };

    // ---------- Loading ----------
    if (loading) {
        return (
            <div className="scope-dashboard view-page">
                <div className="scope-dashboard__loading">
                    <div className="scope-dashboard__loading-spinner" />
                    <span>Loading...</span>
                </div>
            </div>
        );
    }

    // ---------- Not found ----------
    if (!entity) {
        return (
            <div className="scope-dashboard view-page">
                <div className="scope-dashboard__not-found">
                    <h2>Not Found</h2>
                    <p>The {entityType} you're looking for doesn't exist or you don't have access.</p>
                    <Button variant="primary" onClick={handleBack}>Go Back</Button>
                </div>
            </div>
        );
    }

    return (
        <div className="scope-dashboard view-page org-components" style={{ '--scope-accent': accentColour }}>
            {/* Header Banner */}
            <ScopeHeader
                entityType={entityType}
                name={name}
                description={description}
                logoUrl={logoUrl}
                logoImgError={logoImgError}
                isAdmin={isAdmin}
                accentColour={accentColour}
                parentEntity={parentEntity}
                entity={entity}
                memberCount={members.length}
                childCount={children.length}
                departmentCount={departmentCount}
                teamCount={teams.length}
                childLabel={childLabel.plural}
                entityLabel={entityType === 'org' ? 'Organisation' : entityType === 'division' ? 'Division' : 'Department'}
                onInviteMember={isAdmin ? () => setShowInviteModal(true) : undefined}
                onViewInbox
                onDelete={isAdmin ? () => setShowDeleteConfirm(true) : undefined}
                onAddChild={isAdmin && entityType !== 'department' ? () => setShowCreateChild(true) : undefined}
                onBack={handleBack}
                onLogoUpload={entityType === 'org' ? () => setShowLogoModal(true) : undefined}
                onLogoImgError={() => setLogoImgError(true)}
                onNameChange={isAdmin ? setName : undefined}
                onDescriptionChange={isAdmin ? setDescription : undefined}
                hasChanges={hasChanges}
                saving={saving}
                onSave={handleSave}
                entityScopeId={entityScopeId}
            />

            {/* Stats HUD */}
            <ScopeHUD
                entityType={entityType}
                stats={scopeStats}
                accentColour={accentColour}
            />

            {/* Main Grid */}
            <div className="scope-dashboard__grid">
                {/* Left Column — Main Content (Org Chart only) */}
                <div className="scope-dashboard__main">
                    {scopeTree && (
                        <ScopeOrgChart
                            scopeTree={scopeTree}
                            teams={teams}
                            members={members}
                            activeEntityId={entityId}
                            accentColour={accentColour}
                            logoUrl={logoUrl}
                            onNodeClick={(type, refId) => {
                                const routeMap = { org: 'orgs', organization: 'orgs', division: 'divisions', department: 'departments', team: 'teams' };
                                navigate(`/${routeMap[type] || type + 's'}/${refId}`);
                            }}
                        />
                    )}
                </div>

                {/* Right Column — Sidebar */}
                <ScopeSidebar
                    entityType={entityType}
                    entity={entity}
                    name={name}
                    entityId={entityId}
                    entityName={name}
                    entityScopeId={entityScopeId}
                    scopeAssistant={scopeAssistant}
                    accentColour={accentColour}
                    members={members}
                    teams={teams}
                    childEntities={children}
                    parentEntity={parentEntity}
                    onNavigateToParent={parentEntity ? handleNavigateToParent : undefined}
                    onConfigureAssistant={scopeAssistant ? () => navigate('/assistants', {
                        state: {
                            assistantId: scopeAssistant.id,
                            configureAssistant: true,
                        }
                    }) : undefined}
                />
            </div>

            {/* ---- Modals ---- */}

            {/* Create child entity */}
            {entityType !== 'department' && (
                <EntityModal
                    isOpen={showCreateChild}
                    onClose={() => setShowCreateChild(false)}
                    onSubmit={handleCreateChild}
                    title={`Create ${childLabel.singular}`}
                    submitLabel={`Create ${childLabel.singular}`}
                    entityType={childEntityType}
                    parentName={name}
                    loading={creatingChild}
                />
            )}

            {/* Create team */}
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

            {/* Delete confirmation */}
            <ConfirmModal
                isOpen={showDeleteConfirm}
                onClose={() => !deleting && setShowDeleteConfirm(false)}
                onConfirm={handleDelete}
                title={`Delete ${entityType === 'org' ? 'Organisation' : entityType === 'division' ? 'Division' : 'Department'}`}
                message={`Are you sure you want to delete "${name}"? This action cannot be undone and will remove all child entities, teams, and data.`}
                confirmLabel={`Delete ${entityType === 'org' ? 'Organisation' : entityType === 'division' ? 'Division' : 'Department'}`}
                danger
                loading={deleting}
            />

            {/* Invite member */}
            <InviteMemberModal
                isOpen={showInviteModal}
                onClose={() => setShowInviteModal(false)}
                orgId={orgId || entity?.org_id || entityId}
                orgName={entity?.org_name || name}
                onSuccess={() => console.log('Invite sent successfully')}
            />

            {/* Logo upload (org only) */}
            {entityType === 'org' && (
                <LogoUploadModal
                    isOpen={showLogoModal}
                    onClose={() => setShowLogoModal(false)}
                    orgId={entityId}
                    authFetch={authFetch}
                    onUploaded={(url) => {
                        setLogoUrl(url);
                        setLogoImgError(false);
                    }}
                />
            )}
        </div>
    );
}
