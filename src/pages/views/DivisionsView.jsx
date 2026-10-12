/**
 * DivisionsView - Divisions List for Active Organisation
 *
 * Displays all divisions in the currently active organisation with
 * enhanced cards, stats, and navigation to division management.
 */

import { useState, useEffect } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useAuth } from '../../contexts/AuthContext';
import { loadUserEntities } from '../../services/entityRegistry';
import { indexScopeAssistantsByScopeId, buildScopeChatNavigationState } from '../../services/scopeAssistantRouting';
import { PageSection, PageGrid } from '../../components/layout';
import Button from '../../components/ui/Button';
import {
    DivisionCard,
    DivisionCardSkeleton,
    EntityModal,
    OrgBanner
} from '../../components/org';
import './views.css';

// Icons
const LayersIcon = () => (
    <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.5">
        <polygon points="12 2 2 7 12 12 22 7 12 2"/>
        <polyline points="2 17 12 22 22 17"/>
        <polyline points="2 12 12 17 22 12"/>
    </svg>
);

const PlusIcon = () => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="12" y1="5" x2="12" y2="19"/>
        <line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
);

const BuildingIcon = () => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M3 21h18"/>
        <path d="M5 21V7l8-4v18"/>
        <path d="M19 21V11l-6-4"/>
    </svg>
);

function DivisionsView() {
    const navigate = useNavigate();
    const { halState, setPageActions } = useOutletContext() || {};
    const { authFetch } = useAuth();
    const { currentOrg, isOrgAdmin, getDivisions, createDivision } = useWorkspace();

    const [divisions, setDivisions] = useState([]);
    const [loading, setLoading] = useState(true);
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [creating, setCreating] = useState(false);
    const [scopeAssistantsByScopeId, setScopeAssistantsByScopeId] = useState({});

    useEffect(() => {
        setPageActions?.(isOrgAdmin ? (
            <Button variant="primary" onClick={() => setShowCreateModal(true)}>
                <PlusIcon />
                <span style={{ marginLeft: '8px' }}>Create Division</span>
            </Button>
        ) : null);
        return () => setPageActions?.(null);
    }, [setPageActions, isOrgAdmin]);

    useEffect(() => {
        const loadDivisions = async () => {
            if (!currentOrg) {
                setLoading(false);
                return;
            }

            setLoading(true);
            try {
                if (getDivisions) {
                    const divs = await getDivisions(currentOrg.id);
                    // Add org name to each division
                    setDivisions((divs || []).map(d => ({
                        ...d,
                        org_name: currentOrg.name
                    })));
                } else {
                    setDivisions([]);
                }
            } catch (err) {
                console.error('Failed to load divisions:', err);
                setDivisions([]);
            } finally {
                setLoading(false);
            }
        };

        loadDivisions();
    }, [currentOrg, getDivisions]);

    useEffect(() => {
        if (!currentOrg?.id || !authFetch) {
            setScopeAssistantsByScopeId({});
            return;
        }

        let cancelled = false;
        loadUserEntities(currentOrg.id, authFetch)
            .then((assistants) => {
                if (cancelled) return;
                setScopeAssistantsByScopeId(indexScopeAssistantsByScopeId(assistants));
            })
            .catch(() => {
                if (!cancelled) setScopeAssistantsByScopeId({});
            });

        return () => {
            cancelled = true;
        };
    }, [currentOrg?.id, authFetch]);

    const handleChatWithDivision = (division) => {
        const assistantId = scopeAssistantsByScopeId[division?.scope?.id || division?.scope_id || null]?.id || null;
        navigate('/', {
            state: buildScopeChatNavigationState({
                assistantId,
                scopeType: 'division',
                scopeId: division?.id,
                scopeName: division?.name,
                scopeObjectId: division?.scope?.id || division?.scope_id || null,
            })
        });
    };

    const handleManageDivision = (division) => {
        navigate(`/divisions/${division.id}`);
    };

    const handleCreateDivision = async (data) => {
        setCreating(true);
        try {
            if (createDivision && currentOrg) {
                const newDivision = await createDivision(currentOrg.id, data);
                setDivisions(prev => [...prev, { ...newDivision, org_name: currentOrg.name }]);
                setShowCreateModal(false);
                if (newDivision?.id) {
                    navigate(`/divisions/${newDivision.id}`);
                }
            }
        } finally {
            setCreating(false);
        }
    };

    // No org selected state
    if (!currentOrg) {
        return (
            <div className="divisions-view view-page">
                <div className="entity-empty-state" style={{ marginTop: '60px' }}>
                    <div className="entity-empty-state__icon">
                        <LayersIcon />
                    </div>
                    <div className="entity-empty-state__title">No Organisation Selected</div>
                    <div className="entity-empty-state__description">
                        Select an organisation to view its divisions.
                        Each division gets its own AI assistant that specializes in that area.
                    </div>
                    <Button variant="primary" onClick={() => navigate('/orgs')}>
                        <BuildingIcon />
                        <span style={{ marginLeft: '8px' }}>Select Organisation</span>
                    </Button>
                </div>
            </div>
        );
    }

    // Loading state
    if (loading) {
        return (
            <div className="divisions-view view-page">
                <PageSection>
                    <PageGrid columns={2}>
                        <DivisionCardSkeleton />
                        <DivisionCardSkeleton />
                        <DivisionCardSkeleton />
                        <DivisionCardSkeleton />
                    </PageGrid>
                </PageSection>
            </div>
        );
    }

    // Calculate stats
    const totalMembers = divisions.reduce((sum, d) => sum + (d.member_count || 0), 0);
    const totalTeams = divisions.reduce((sum, d) => sum + (d.team_count || 0), 0);

    // Empty state
    if (divisions.length === 0) {
        return (
            <div className="divisions-view view-page">
                <div className="entity-empty-state" style={{ marginTop: '60px' }}>
                    <div className="entity-empty-state__icon">
                        <LayersIcon />
                    </div>
                    <div className="entity-empty-state__title">No Divisions</div>
                    <div className="entity-empty-state__description">
                        Divisions help organize your teams and provide focused AI assistants for each area.
                        Create your first division to get started.
                    </div>
                    {isOrgAdmin && (
                        <Button
                            variant="primary"
                            onClick={() => setShowCreateModal(true)}
                            style={{ marginTop: '8px' }}
                        >
                            <PlusIcon />
                            <span style={{ marginLeft: '8px' }}>Create Division</span>
                        </Button>
                    )}
                </div>

                <EntityModal
                    isOpen={showCreateModal}
                    onClose={() => setShowCreateModal(false)}
                    onSubmit={handleCreateDivision}
                    title="Create Division"
                    submitLabel="Create Division"
                    entityType="division"
                    parentName={currentOrg.name}
                    loading={creating}
                />
            </div>
        );
    }

    // Main view with divisions
    return (
        <div className="divisions-view view-page org-components">
            <OrgBanner org={currentOrg} />

            {/* Stats Overview */}
            <PageSection>
                <div className="stats-grid" style={{ marginBottom: '8px' }}>
                    <div className="stat-card-v2">
                        <div className="stat-card-v2__value">{divisions.length}</div>
                        <div className="stat-card-v2__label">Divisions</div>
                    </div>
                    <div className="stat-card-v2">
                        <div className="stat-card-v2__value">{totalMembers}</div>
                        <div className="stat-card-v2__label">Total Members</div>
                    </div>
                    <div className="stat-card-v2">
                        <div className="stat-card-v2__value">{totalTeams}</div>
                        <div className="stat-card-v2__label">Total Teams</div>
                    </div>
                    <div className="stat-card-v2">
                        <div className="stat-card-v2__value">
                            {divisions.reduce((sum, d) => sum + (d.department_count || 0), 0)}
                        </div>
                        <div className="stat-card-v2__label">Departments</div>
                    </div>
                </div>
            </PageSection>

            {/* Divisions Grid */}
            <PageSection title="All Divisions">
                <PageGrid columns={2}>
                    {divisions.map(division => (
                        <DivisionCard
                            key={division.id}
                            division={division}
                            orgName={currentOrg.name}
                            onClick={handleManageDivision}
                            onChat={handleChatWithDivision}
                            onManage={handleManageDivision}
                        />
                    ))}
                </PageGrid>
            </PageSection>

            {/* Quick tip */}
            <div style={{
                marginTop: '32px',
                padding: '16px 20px',
                background: 'rgba(255, 255, 255, 0.02)',
                borderRadius: '8px',
                display: 'flex',
                alignItems: 'center',
                gap: '12px'
            }}>
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="rgba(50, 173, 230, 0.7)" strokeWidth="1.5">
                    <circle cx="12" cy="12" r="10"/>
                    <line x1="12" y1="16" x2="12" y2="12"/>
                    <line x1="12" y1="8" x2="12.01" y2="8"/>
                </svg>
                <span style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>
                    <strong style={{ color: 'var(--text-primary)' }}>Tip:</strong> Each division has
                    its own AI assistant that specializes in that area. Click "Chat" to start a
                    conversation with any division's assistant.
                </span>
            </div>

            <EntityModal
                isOpen={showCreateModal}
                onClose={() => setShowCreateModal(false)}
                onSubmit={handleCreateDivision}
                title="Create Division"
                submitLabel="Create Division"
                entityType="division"
                parentName={currentOrg.name}
                loading={creating}
            />

        </div>
    );
}

export default DivisionsView;
