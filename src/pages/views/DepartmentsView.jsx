/**
 * DepartmentsView - Departments List for Active Organisation
 *
 * Displays all departments in the current org with DepartmentCard grid,
 * division filter dropdown, and create button. Matches OrgsView/DivisionsView standard.
 */

import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useAuth } from '../../contexts/AuthContext';
import { loadUserEntities } from '../../services/entityRegistry';
import { indexScopeAssistantsByScopeId, buildScopeChatNavigationState } from '../../services/scopeAssistantRouting';
import { PageSection, PageGrid } from '../../components/layout';
import Button from '../../components/ui/Button';
import {
    DepartmentCard,
    DepartmentCardSkeleton,
    EntityModal,
    OrgBanner
} from '../../components/org';
import './views.css';

// Icons
const DeptIcon = () => (
    <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="2" y="3" width="20" height="18" rx="2"/>
        <path d="M8 7h8"/>
        <path d="M8 11h8"/>
        <path d="M8 15h5"/>
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

function DepartmentsView() {
    const navigate = useNavigate();
    const { halState, setPageActions } = useOutletContext() || {};
    const { user, authFetch } = useAuth();
    const { currentOrg, isOrgAdmin, getDivisions, getDepartments } = useWorkspace();

    const [departments, setDepartments] = useState([]);
    const [divisions, setDivisions] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [selectedDivisionId, setSelectedDivisionId] = useState(null);
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [creating, setCreating] = useState(false);
    const [scopeAssistantsByScopeId, setScopeAssistantsByScopeId] = useState({});

    useEffect(() => {
        setPageActions?.(isOrgAdmin && divisions.length > 0 ? (
            <Button
                variant="primary"
                onClick={() => setShowCreateModal(true)}
            >
                <PlusIcon />
                <span style={{ marginLeft: '8px' }}>Create Department</span>
            </Button>
        ) : null);
        return () => setPageActions?.(null);
    }, [setPageActions, isOrgAdmin, divisions.length, selectedDivisionId]);

    useEffect(() => {
        const loadData = async () => {
            if (!currentOrg) {
                setLoading(false);
                return;
            }

            setLoading(true);
            setError(null);
            try {
                // Parallel fetch: divisions (for filter) and all departments (flat)
                const [divs, depts] = await Promise.all([
                    getDivisions ? getDivisions(currentOrg.id) : [],
                    getDepartments ? getDepartments(currentOrg.id) : []
                ]);
                setDivisions(divs || []);
                setDepartments(depts || []);
            } catch (err) {
                console.error('Failed to load departments:', err);
                setError('Failed to load departments. Please try again.');
                setDepartments([]);
            } finally {
                setLoading(false);
            }
        };

        loadData();
    }, [currentOrg, getDivisions, getDepartments]);

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

    // Client-side filter by selected division
    const filteredDepartments = useMemo(() => {
        if (!selectedDivisionId) return departments;
        return departments.filter(d => d.division_id === selectedDivisionId);
    }, [departments, selectedDivisionId]);

    const handleManage = (dept) => {
        navigate(`/departments/${dept.id}`);
    };

    const handleChatWithDepartment = (dept) => {
        const assistantId = scopeAssistantsByScopeId[dept?.scope?.id || dept?.scope_id || null]?.id || null;
        navigate('/', {
            state: buildScopeChatNavigationState({
                assistantId,
                scopeType: 'department',
                scopeId: dept?.id,
                scopeName: dept?.name,
                scopeObjectId: dept?.scope?.id || dept?.scope_id || null,
            })
        });
    };

    const handleCreateDepartment = async (data) => {
        const divId = selectedDivisionId || divisions[0]?.id;
        if (!divId) return;

        setCreating(true);
        try {
            const slug = data.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
            const response = await authFetch(
                `/api/orgs/${currentOrg.id}/divisions/${divId}/departments`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: data.name, slug, description: data.description })
                }
            );

            if (response.ok) {
                const result = await response.json();
                const div = divisions.find(d => d.id === divId);
                const newDept = {
                    ...result.department,
                    division_name: div?.name,
                    division_id: divId
                };
                setDepartments(prev => [...prev, newDept]);
                setShowCreateModal(false);
                if (newDept?.id) {
                    navigate(`/departments/${newDept.id}`);
                }
            } else {
                const err = await response.json();
                throw new Error(err.message || 'Failed to create department');
            }
        } catch (err) {
            console.error('Failed to create department:', err);
            alert('Failed to create department. Please try again.');
        } finally {
            setCreating(false);
        }
    };

    // No org selected state
    if (!currentOrg) {
        return (
            <div className="departments-view view-page">
                <div className="entity-empty-state" style={{ marginTop: '60px' }}>
                    <div className="entity-empty-state__icon">
                        <DeptIcon />
                    </div>
                    <div className="entity-empty-state__title">No Organisation Selected</div>
                    <div className="entity-empty-state__description">
                        Select an organisation to view its departments.
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
            <div className="departments-view view-page">
                <PageSection>
                    <PageGrid columns={2}>
                        <DepartmentCardSkeleton />
                        <DepartmentCardSkeleton />
                        <DepartmentCardSkeleton />
                        <DepartmentCardSkeleton />
                    </PageGrid>
                </PageSection>
            </div>
        );
    }

    // Error state
    if (error) {
        return (
            <div className="departments-view view-page">
                <div className="entity-empty-state" style={{ marginTop: '60px' }}>
                    <div className="entity-empty-state__icon" style={{ color: 'var(--color-danger)' }}>
                        <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <circle cx="12" cy="12" r="10"/>
                            <line x1="12" y1="8" x2="12" y2="12"/>
                            <line x1="12" y1="16" x2="12.01" y2="16"/>
                        </svg>
                    </div>
                    <div className="entity-empty-state__title">Error Loading Departments</div>
                    <div className="entity-empty-state__description">{error}</div>
                    <Button variant="primary" onClick={() => window.location.reload()}>
                        Try Again
                    </Button>
                </div>
            </div>
        );
    }

    // Calculate stats from filtered departments
    const totalTeams = filteredDepartments.reduce((sum, d) => sum + (d.team_count || 0), 0);
    const uniqueDivisions = selectedDivisionId ? 1 : new Set(departments.map(d => d.division_id)).size;

    // Empty state
    if (departments.length === 0) {
        return (
            <div className="departments-view view-page">
                <div className="entity-empty-state" style={{ marginTop: '60px' }}>
                    <div className="entity-empty-state__icon">
                        <DeptIcon />
                    </div>
                    <div className="entity-empty-state__title">No Departments Yet</div>
                    <div className="entity-empty-state__description">
                        Departments help organize divisions into focused units.
                        {divisions.length > 0
                            ? ' Create your first department to get started.'
                            : ' Create a division first, then add departments.'
                        }
                    </div>
                    {divisions.length > 0 && isOrgAdmin ? (
                        <Button
                            variant="primary"
                            onClick={() => setShowCreateModal(true)}
                            style={{ marginTop: '8px' }}
                        >
                            <PlusIcon />
                            <span style={{ marginLeft: '8px' }}>Create Department</span>
                        </Button>
                    ) : (
                        <Button variant="primary" onClick={() => navigate('/divisions')}>
                            <BuildingIcon />
                            <span style={{ marginLeft: '8px' }}>Go to Divisions</span>
                        </Button>
                    )}
                </div>

                <EntityModal
                    isOpen={showCreateModal}
                    onClose={() => setShowCreateModal(false)}
                    onSubmit={handleCreateDepartment}
                    title="Create Department"
                    submitLabel="Create Department"
                    entityType="department"
                    parentName={divisions[0]?.name || currentOrg.name}
                    loading={creating}
                />
            </div>
        );
    }

    // Resolve selected division name for section title
    const selectedDivName = selectedDivisionId
        ? divisions.find(d => d.id === selectedDivisionId)?.name
        : null;

    // Main view with departments
    return (
        <div className="departments-view view-page org-components">
            <OrgBanner org={currentOrg} />

            {/* Stats Overview */}
            <PageSection>
                <div className="stats-grid" style={{ marginBottom: '8px' }}>
                    <div className="stat-card-v2">
                        <div className="stat-card-v2__value">{filteredDepartments.length}</div>
                        <div className="stat-card-v2__label">Departments</div>
                    </div>
                    <div className="stat-card-v2">
                        <div className="stat-card-v2__value">{uniqueDivisions}</div>
                        <div className="stat-card-v2__label">{uniqueDivisions === 1 ? 'Division' : 'Divisions'}</div>
                    </div>
                    <div className="stat-card-v2">
                        <div className="stat-card-v2__value">{totalTeams}</div>
                        <div className="stat-card-v2__label">Total Teams</div>
                    </div>
                    <div className="stat-card-v2">
                        <div className="stat-card-v2__value">{filteredDepartments.length}</div>
                        <div className="stat-card-v2__label">AI Assistants</div>
                    </div>
                </div>
            </PageSection>

            {/* Division Filter */}
            {divisions.length > 1 && (
                <div className="entity-view__filters">
                    <div className="entity-view__filter-group">
                        <label>Division:</label>
                        <select
                            value={selectedDivisionId || ''}
                            onChange={(e) => setSelectedDivisionId(e.target.value || null)}
                        >
                            <option value="">All Divisions</option>
                            {divisions.map(div => (
                                <option key={div.id} value={div.id}>{div.name}</option>
                            ))}
                        </select>
                    </div>
                </div>
            )}

            {/* Departments Grid */}
            <PageSection title={selectedDivName ? `${selectedDivName} Departments` : 'All Departments'}>
                {filteredDepartments.length > 0 ? (
                    <PageGrid columns={2}>
                        {filteredDepartments.map(dept => (
                            <DepartmentCard
                                key={dept.id}
                                department={dept}
                                divisionName={dept.division_name}
                                onClick={handleManage}
                                onChat={handleChatWithDepartment}
                                onManage={handleManage}
                            />
                        ))}
                    </PageGrid>
                ) : (
                    <div className="entity-empty-state" style={{ marginTop: '20px' }}>
                        <div className="entity-empty-state__title">No departments in this division</div>
                        <div className="entity-empty-state__description">
                            Select a different division or create a new department.
                        </div>
                    </div>
                )}
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
                    <strong style={{ color: 'var(--text-primary)' }}>Tip:</strong> Each department has
                    its own AI assistant. Click "Chat" to start a scoped conversation, or "Manage" to
                    view the full department dashboard with org chart and members.
                </span>
            </div>

            <EntityModal
                isOpen={showCreateModal}
                onClose={() => setShowCreateModal(false)}
                onSubmit={handleCreateDepartment}
                title="Create Department"
                submitLabel="Create Department"
                entityType="department"
                parentName={selectedDivName || divisions[0]?.name || currentOrg.name}
                loading={creating}
            />
        </div>
    );
}

export default DepartmentsView;
