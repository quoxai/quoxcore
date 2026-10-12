/**
 * OrgDashboardLayout — /orgs/:orgId page layout.
 *
 * Three-column grid: left sidebar (quick actions + details + hierarchy),
 * main column (header + stats + content panels), right sidebar
 * (assistant + chat, fixed viewport height).
 *
 * Division + Department routes each have their own layouts
 * (DivisionDashboardLayout, DepartmentDashboardLayout) that mirror
 * this structure with a narrower scope lens.
 */

import { useNavigate } from 'react-router-dom';
import { EntityModal, ConfirmModal, InviteMemberModal, LogoUploadModal } from '.';
import Button from '../ui/Button';
import { useAuth } from '../../contexts/AuthContext';

import ScopeHeader from '../scope/ScopeHeader';
import OrgStatsStrip from './OrgStatsStrip';
import OrgHierarchyPanel from './OrgHierarchyPanel';
import OrgAssistantPanel from './OrgAssistantPanel';
import OrgMetaPanel from './OrgMetaPanel';
import OrgDivisionsPanel from './OrgDivisionsPanel';
import OrgMembersGrid from './OrgMembersGrid';
import OrgTeamsPanel from './OrgTeamsPanel';
import OrgQuickActionsPanel from './OrgQuickActionsPanel';
import OrgActivityPanel from './OrgActivityPanel';
import OrgEnterprisePlaceholder from './OrgEnterprisePlaceholder';
import OrgRolesPanel from './OrgRolesPanel';
import OrgSecurityPanel from './OrgSecurityPanel';
import OrgSsoPanel from './OrgSsoPanel';
import OrgDomainsPanel from './OrgDomainsPanel';
import OrgWebhooksPanel from './OrgWebhooksPanel';
import OrgScimTokensPanel from './OrgScimTokensPanel';
import OrgBulkInvitePanel from './OrgBulkInvitePanel';
import OrgSecretsPanel from './OrgSecretsPanel';
import OrgAgentMatrixPanel from './OrgAgentMatrixPanel';
import OrgGuestInvitePanel from './OrgGuestInvitePanel';
import OrgBudgetsPanel from './OrgBudgetsPanel';
import { usePlan } from '../../hooks/usePlan';
import './org-dashboard.css';

export default function OrgDashboardLayout({ data }) {
    const navigate = useNavigate();
    const { authFetch } = useAuth();
    const { plan, planRank } = usePlan(data?.entityId);
    const isEnterprise = plan === 'enterprise';
    const isTeamOrAbove = planRank >= 2;   // team + enterprise

    const {
        entity, entityType, entityId, orgId, loading,
        accentColour, childLabel, entityScopeId, scopeAssistant, departmentCount, scopeStats,
        scopeTree,
        children, teams, members, pendingInvites,
        name, setName, description, setDescription,
        logoUrl, setLogoUrl, logoImgError, setLogoImgError,
        hasChanges, saving, isAdmin,
        showCreateChild, setShowCreateChild,
        showCreateTeam, setShowCreateTeam,
        showDeleteConfirm, setShowDeleteConfirm,
        showInviteModal, setShowInviteModal,
        showLogoModal, setShowLogoModal,
        creatingChild, creatingTeam, deleting,
        handleSave, handleDelete, handleCreateChild, handleCreateTeam,
        reloadMembers,
    } = data;

    // ---------- Loading ----------
    if (loading) {
        return (
            <div className="org-dashboard">
                <div className="org-dashboard__loading">
                    <div className="org-dashboard__loading-spinner" />
                    <span>Loading organisation…</span>
                </div>
            </div>
        );
    }

    // ---------- Not found ----------
    if (!entity) {
        return (
            <div className="org-dashboard">
                <div className="org-dashboard__not-found">
                    <h2>Organisation Not Found</h2>
                    <p>The organisation you're looking for doesn't exist or you don't have access.</p>
                    <Button variant="primary" onClick={() => navigate('/orgs')}>Back to Organisations</Button>
                </div>
            </div>
        );
    }

    return (
        <div className="org-dashboard" style={{ '--scope-accent': accentColour }}>
            <div className="org-dashboard__grid">
                {/* Left sidebar — quick actions (top) + details + hierarchy */}
                <aside className="org-dashboard__aside org-dashboard__aside--left">
                    <OrgQuickActionsPanel
                        isAdmin={isAdmin}
                        entityScopeId={entityScopeId}
                        onCreateDivision={isAdmin ? () => setShowCreateChild(true) : undefined}
                        onInviteMember={isAdmin ? () => setShowInviteModal(true) : undefined}
                        onUploadLogo={isAdmin ? () => setShowLogoModal(true) : undefined}
                    />
                    <OrgMetaPanel entity={entity} entityScopeId={entityScopeId} />
                    <OrgHierarchyPanel
                        scopeTree={scopeTree}
                        activeEntityId={entityId}
                    />
                </aside>

                {/* Main column — header + stats + content */}
                <div className="org-dashboard__main">
                    <ScopeHeader
                        entityType={entityType}
                        name={name}
                        description={description}
                        logoUrl={logoUrl}
                        logoImgError={logoImgError}
                        isAdmin={isAdmin}
                        accentColour={accentColour}
                        entity={entity}
                        memberCount={members.length}
                        childCount={children.length}
                        departmentCount={departmentCount}
                        teamCount={teams.length}
                        childLabel={childLabel.plural}
                        entityLabel="Organisation"
                        onInviteMember={isAdmin ? () => setShowInviteModal(true) : undefined}
                        onViewInbox
                        onDelete={isAdmin ? () => setShowDeleteConfirm(true) : undefined}
                        onAddChild={isAdmin ? () => setShowCreateChild(true) : undefined}
                        onLogoUpload={() => setShowLogoModal(true)}
                        onLogoImgError={() => setLogoImgError(true)}
                        onNameChange={isAdmin ? setName : undefined}
                        onDescriptionChange={isAdmin ? setDescription : undefined}
                        hasChanges={hasChanges}
                        saving={saving}
                        onSave={handleSave}
                        entityScopeId={entityScopeId}
                    />
                    <OrgStatsStrip stats={scopeStats} />
                    <OrgDivisionsPanel
                        divisions={children}
                        isAdmin={isAdmin}
                        onCreateDivision={isAdmin ? () => setShowCreateChild(true) : undefined}
                    />
                    <OrgMembersGrid
                        members={members}
                        pendingInvites={pendingInvites}
                        isAdmin={isAdmin}
                        onInviteMember={isAdmin ? () => setShowInviteModal(true) : undefined}
                        orgId={entityId}
                        onCustomRoleAssigned={reloadMembers}
                    />
                    <OrgTeamsPanel
                        teams={teams}
                        isAdmin={isAdmin}
                        onCreateTeam={isAdmin ? () => setShowCreateTeam(true) : undefined}
                    />
                    <OrgActivityPanel />
                    {/* P8.B.3 — Monthly budget config (visible to admin on any plan) */}
                    {isAdmin && <OrgBudgetsPanel orgId={entityId} isAdmin={isAdmin} />}
                    {isEnterprise ? (
                        <>
                            <OrgRolesPanel orgId={entityId} isAdmin={isAdmin} />
                            <OrgAgentMatrixPanel orgId={entityId} isAdmin={isAdmin} />
                            <OrgSecurityPanel orgId={entityId} isAdmin={isAdmin} />
                            <OrgSsoPanel orgId={entityId} isAdmin={isAdmin} />
                            <OrgDomainsPanel orgId={entityId} isAdmin={isAdmin} />
                            <OrgGuestInvitePanel orgId={entityId} isAdmin={isAdmin} />
                            <OrgBulkInvitePanel orgId={entityId} isAdmin={isAdmin} />
                            <OrgSecretsPanel orgId={entityId} isAdmin={isAdmin} />
                            <OrgWebhooksPanel orgId={entityId} isAdmin={isAdmin} />
                            <OrgScimTokensPanel orgId={entityId} isAdmin={isAdmin} />
                        </>
                    ) : isTeamOrAbove ? (
                        <>
                            <OrgDomainsPanel orgId={entityId} isAdmin={isAdmin} />
                            <OrgBulkInvitePanel orgId={entityId} isAdmin={isAdmin} />
                            <OrgSecretsPanel orgId={entityId} isAdmin={isAdmin} />
                            <OrgEnterprisePlaceholder />
                        </>
                    ) : (
                        <OrgEnterprisePlaceholder />
                    )}
                </div>

                {/* Right sidebar — assistant-only, fixed viewport height */}
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

            {/* ---- Modals (unchanged — wired to existing handlers) ---- */}

            <EntityModal
                isOpen={showCreateChild}
                onClose={() => setShowCreateChild(false)}
                onSubmit={handleCreateChild}
                title={`Create ${childLabel.singular}`}
                submitLabel={`Create ${childLabel.singular}`}
                entityType="division"
                parentName={name}
                loading={creatingChild}
            />

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
                title="Delete Organisation"
                message={`Are you sure you want to delete "${name}"? This action cannot be undone and will remove all divisions, departments, teams, and data.`}
                confirmLabel="Delete Organisation"
                danger
                loading={deleting}
            />

            <InviteMemberModal
                isOpen={showInviteModal}
                onClose={() => setShowInviteModal(false)}
                orgId={orgId || entityId}
                orgName={name}
                onSuccess={() => {}}
            />

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
        </div>
    );
}
