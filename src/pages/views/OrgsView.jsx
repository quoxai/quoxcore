/**
 * OrgsView - Organizations List
 *
 * Displays all organizations the user belongs to with enhanced card design.
 * Supports creating new organizations and navigating to management.
 */

import { useState, useEffect } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useAuth } from '../../contexts/AuthContext';
import { PageSection, PageGrid } from '../../components/layout';
import Button from '../../components/ui/Button';
import {
    OrgCard,
    OrgCardSkeleton,
    EntityModal
} from '../../components/org';
import './views.css';

// Icons
const BuildingIcon = () => (
    <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M3 21h18"/>
        <path d="M5 21V7l8-4v18"/>
        <path d="M19 21V11l-6-4"/>
        <path d="M9 9v.01"/>
        <path d="M9 12v.01"/>
        <path d="M9 15v.01"/>
        <path d="M9 18v.01"/>
    </svg>
);

const PlusIcon = () => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="12" y1="5" x2="12" y2="19"/>
        <line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
);

const StatIcon = {
    orgs: (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.75">
            <path d="M3 21h18"/><path d="M5 21V7l8-4v18"/><path d="M19 21V11l-6-4"/>
        </svg>
    ),
    members: (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.75">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
            <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
        </svg>
    ),
    divisions: (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.75">
            <polygon points="12 2 2 7 12 12 22 7 12 2"/>
            <polyline points="2 17 12 22 22 17"/>
            <polyline points="2 12 12 17 22 12"/>
        </svg>
    ),
    teams: (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.75">
            <circle cx="12" cy="7" r="4"/>
            <path d="M6 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/>
        </svg>
    ),
    avg: (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.75">
            <path d="M3 18l6-6 4 4 8-8"/>
        </svg>
    )
};

function OrgsView() {
    const navigate = useNavigate();
    const { halState, setPageActions } = useOutletContext() || {};
    const { user, authFetch } = useAuth();
    const { orgs, currentOrg, selectOrg, createOrg, updateOrgLocal, loading: workspaceLoading } = useWorkspace();
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [creating, setCreating] = useState(false);

    useEffect(() => {
        setPageActions?.(
            <Button variant="primary" onClick={() => setShowCreateModal(true)}>
                <PlusIcon />
                <span>Create Organisation</span>
            </Button>
        );
        return () => setPageActions?.(null);
    }, [setPageActions]);

    const handleSelectOrg = async (org) => {
        await selectOrg(org);
    };

    const handleManageOrg = (org) => {
        navigate(`/orgs/${org.id}`);
    };

    const handleCreateOrg = async (data) => {
        setCreating(true);
        try {
            if (createOrg) {
                const { logoFile, ...orgData } = data;
                let newOrg = await createOrg(orgData);

                // Upload logo if provided
                if (logoFile && newOrg?.id) {
                    try {
                        const formData = new FormData();
                        formData.append('logo', logoFile);
                        // Use authFetch to include CSRF token (raw fetch was blocked by CSRF middleware)
                        const logoResponse = await authFetch(`/api/uploads/org/${newOrg.id}/logo`, {
                            method: 'POST',
                            body: formData
                        });

                        if (logoResponse.ok) {
                            const logoData = await logoResponse.json();
                            // Update the org with the new logo URL
                            if (logoData.logo_url) {
                                newOrg = { ...newOrg, logo_url: logoData.logo_url };
                                // Update in workspace context (local state)
                                updateOrgLocal(newOrg.id, { logo_url: logoData.logo_url });
                            }
                        }
                    } catch (err) {
                        console.error('Failed to upload logo:', err);
                        // Continue anyway - org was created
                    }
                }

                setShowCreateModal(false);
                // Navigate to the new org's management page
                if (newOrg?.id) {
                    navigate(`/orgs/${newOrg.id}`);
                }
            }
        } finally {
            setCreating(false);
        }
    };

    // Loading state
    if (workspaceLoading) {
        return (
            <div className="orgs-view view-page">
                <PageSection>
                    <PageGrid columns={3}>
                        <OrgCardSkeleton />
                        <OrgCardSkeleton />
                        <OrgCardSkeleton />
                    </PageGrid>
                </PageSection>
            </div>
        );
    }

    // Empty state
    if (orgs.length === 0) {
        return (
            <div className="orgs-view view-page">
                <div className="entity-empty-state" style={{ marginTop: '60px' }}>
                    <div className="entity-empty-state__icon">
                        <BuildingIcon />
                    </div>
                    <div className="entity-empty-state__title">No Organisations</div>
                    <div className="entity-empty-state__description">
                        Create your first organisation to get started with QuoxCORE.
                        Each organisation gets its own AI assistant that learns your context.
                    </div>
                    <Button
                        variant="primary"
                        onClick={() => setShowCreateModal(true)}
                        style={{ marginTop: '8px' }}
                    >
                        <PlusIcon />
                        <span>Create Organisation</span>
                    </Button>
                </div>

                <EntityModal
                    isOpen={showCreateModal}
                    onClose={() => setShowCreateModal(false)}
                    onSubmit={handleCreateOrg}
                    title="Create Organisation"
                    submitLabel="Create Organisation"
                    entityType="org"
                    loading={creating}
                />
            </div>
        );
    }

    // Aggregate stats
    const totalMembers   = orgs.reduce((s, o) => s + (o.member_count   || 0), 0);
    const totalDivisions = orgs.reduce((s, o) => s + (o.division_count || 0), 0);
    const totalTeams     = orgs.reduce((s, o) => s + (o.team_count     || 0), 0);
    const avgSize = orgs.length > 0 ? Math.round(totalMembers / orgs.length) : 0;

    return (
        <div className="orgs-view view-page">
            {/* Condensed stats strip — dashboard pattern, single glass surface */}
            <div className="quick-stats-strip">
                <div className="quick-stat-tile">
                    <span className="quick-stat-tile__icon" style={{ color: '#38bdf8' }}>{StatIcon.orgs}</span>
                    <span className="quick-stat-tile__value" style={{ color: '#38bdf8' }}>{orgs.length}</span>
                    <span className="quick-stat-tile__label">Orgs</span>
                </div>
                <div className="quick-stat-tile">
                    <span className="quick-stat-tile__icon" style={{ color: '#4ade80' }}>{StatIcon.members}</span>
                    <span className="quick-stat-tile__value" style={{ color: '#4ade80' }}>{totalMembers}</span>
                    <span className="quick-stat-tile__label">Members</span>
                </div>
                <div className="quick-stat-tile">
                    <span className="quick-stat-tile__icon" style={{ color: '#a78bfa' }}>{StatIcon.divisions}</span>
                    <span className="quick-stat-tile__value" style={{ color: '#a78bfa' }}>{totalDivisions}</span>
                    <span className="quick-stat-tile__label">Divisions</span>
                </div>
                <div className="quick-stat-tile">
                    <span className="quick-stat-tile__icon" style={{ color: '#fbbf24' }}>{StatIcon.teams}</span>
                    <span className="quick-stat-tile__value" style={{ color: '#fbbf24' }}>{totalTeams}</span>
                    <span className="quick-stat-tile__label">Teams</span>
                </div>
                <div className="quick-stat-tile">
                    <span className="quick-stat-tile__icon" style={{ color: 'rgba(255,255,255,0.75)' }}>{StatIcon.avg}</span>
                    <span className="quick-stat-tile__value">{avgSize}</span>
                    <span className="quick-stat-tile__label">Avg/Org</span>
                </div>
            </div>

            {/* Organisation Cards */}
            <PageGrid columns={3}>
                {orgs.filter(org => org && org.id).map(org => (
                    <OrgCard
                        key={org.id}
                        org={org}
                        isActive={currentOrg?.id === org.id}
                        onClick={handleSelectOrg}
                        onManage={handleManageOrg}
                    />
                ))}
            </PageGrid>

            {/* Quick tip */}
            <div className="qx-banner" role="note">
                <svg
                    className="qx-banner__icon"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.75"
                >
                    <circle cx="12" cy="12" r="10"/>
                    <line x1="12" y1="16" x2="12" y2="12"/>
                    <line x1="12" y1="8" x2="12.01" y2="8"/>
                </svg>
                <span>
                    <span className="qx-banner__title">Tip:</span>
                    Click an organisation to set it as active, or click "Manage" to configure
                    divisions, members, and settings.
                </span>
            </div>

            <EntityModal
                isOpen={showCreateModal}
                onClose={() => setShowCreateModal(false)}
                onSubmit={handleCreateOrg}
                title="Create Organisation"
                submitLabel="Create Organisation"
                entityType="org"
                loading={creating}
            />

        </div>
    );
}

export default OrgsView;
