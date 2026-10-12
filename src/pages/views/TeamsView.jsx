/**
 * TeamsView - Teams List for Active Organisation
 *
 * Displays all teams in the currently active organisation with
 * division/department cascade filter dropdowns, grid cards, stats,
 * and navigation to team management.
 */

import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useAuth } from '../../contexts/AuthContext';
import { PageSection, PageGrid } from '../../components/layout';
import Button from '../../components/ui/Button';
import {
    OrgBanner
} from '../../components/org';
import TeamCard, { TeamCardSkeleton } from '../../components/org/TeamCard';
import './views.css';

// Icons
const TeamIcon = () => (
    <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
        <circle cx="9" cy="7" r="4"/>
        <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
        <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
    </svg>
);

const BuildingIcon = () => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M3 21h18"/>
        <path d="M5 21V7l8-4v18"/>
        <path d="M19 21V11l-6-4"/>
    </svg>
);

const QuestionIcon = () => (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="12" cy="12" r="10"/>
        <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
        <line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
);

function TeamsView() {
    const navigate = useNavigate();
    const { halState, setPageActions } = useOutletContext() || {};
    const { user, authFetch } = useAuth();
    const { currentOrg, isOrgAdmin, getTeams, getDivisions, getDepartments } = useWorkspace();

    const [teams, setTeams] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    // Filter state
    const [divisions, setDivisions] = useState([]);
    const [departments, setDepartments] = useState([]);
    const [selectedDivisionId, setSelectedDivisionId] = useState(null);
    const [selectedDepartmentId, setSelectedDepartmentId] = useState(null);

    useEffect(() => {
        setPageActions?.(
            <span
                title="Teams are created automatically when you create an organisation, division, or department."
                style={{ display: 'inline-flex', cursor: 'help', color: 'var(--text-secondary)' }}
            >
                <QuestionIcon />
            </span>
        );
        return () => setPageActions?.(null);
    }, [setPageActions]);

    // Load teams
    useEffect(() => {
        const loadTeams = async () => {
            if (!currentOrg) {
                setLoading(false);
                return;
            }

            setLoading(true);
            setError(null);
            try {
                // Fetch both all teams (with stats) and my-teams (with my_role)
                const [teamsRes, myTeamsRes] = await Promise.all([
                    authFetch(`/api/orgs/${currentOrg.id}/teams?includeStats=true`),
                    authFetch(`/api/orgs/${currentOrg.id}/my-teams`)
                ]);

                if (!teamsRes.ok) {
                    throw new Error('Failed to load teams');
                }

                const teamsData = await teamsRes.json();
                const myTeamsData = myTeamsRes.ok ? await myTeamsRes.json() : { teams: [] };

                // Create map of my_role by team id
                const myRoleMap = new Map(
                    (myTeamsData.teams || []).map(t => [t.id, t.my_role])
                );

                // Enrich teams with my_role
                setTeams((teamsData.teams || []).map(t => ({
                    ...t,
                    org_name: currentOrg.name,
                    my_role: myRoleMap.get(t.id) || null
                })));
            } catch (err) {
                console.error('Failed to load teams:', err);
                setError('Failed to load teams. Please try again.');
                setTeams([]);
            } finally {
                setLoading(false);
            }
        };

        loadTeams();
    }, [currentOrg, authFetch]);

    // Load divisions for filter dropdown
    useEffect(() => {
        const loadDivisions = async () => {
            if (!currentOrg || !getDivisions) return;
            try {
                const divs = await getDivisions(currentOrg.id);
                setDivisions(divs || []);
            } catch (err) {
                console.error('Failed to load divisions for filter:', err);
            }
        };
        loadDivisions();
    }, [currentOrg, getDivisions]);

    // Cascade: load departments when division selected
    useEffect(() => {
        const loadDepts = async () => {
            if (!currentOrg || !selectedDivisionId || !getDepartments) {
                setDepartments([]);
                setSelectedDepartmentId(null);
                return;
            }
            try {
                const depts = await getDepartments(currentOrg.id, selectedDivisionId);
                setDepartments(depts || []);
            } catch (err) {
                console.error('Failed to load departments for filter:', err);
                setDepartments([]);
            }
        };
        loadDepts();
    }, [currentOrg, selectedDivisionId, getDepartments]);

    // Client-side team filtering via scope_path
    const filteredTeams = useMemo(() => {
        if (!selectedDivisionId && !selectedDepartmentId) return teams;
        return teams.filter(team => {
            if (!team.scope_path) return false;
            if (selectedDepartmentId) {
                return team.scope_path.includes(`/department/${selectedDepartmentId}`);
            }
            if (selectedDivisionId) {
                return team.scope_path.includes(`/division/${selectedDivisionId}`);
            }
            return true;
        });
    }, [teams, selectedDivisionId, selectedDepartmentId]);

    const handleChatWithTeam = (team) => {
        navigate('/', { state: { scope: 'team', scopeId: team.id, scopeName: team.name } });
    };

    const handleManageTeam = (team) => {
        navigate(`/teams/${team.id}`);
    };

    // No org selected state
    if (!currentOrg) {
        return (
            <div className="teams-view view-page">
                <div className="entity-empty-state" style={{ marginTop: '60px' }}>
                    <div className="entity-empty-state__icon">
                        <TeamIcon />
                    </div>
                    <div className="entity-empty-state__title">No Organisation Selected</div>
                    <div className="entity-empty-state__description">
                        Select an organisation to view its teams.
                        Each team gets its own collaborative AI assistant.
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
            <div className="teams-view view-page">
                <PageSection>
                    <PageGrid columns={2}>
                        <TeamCardSkeleton />
                        <TeamCardSkeleton />
                        <TeamCardSkeleton />
                        <TeamCardSkeleton />
                    </PageGrid>
                </PageSection>
            </div>
        );
    }

    // Error state
    if (error) {
        return (
            <div className="teams-view view-page">
                <div className="entity-empty-state" style={{ marginTop: '60px' }}>
                    <div className="entity-empty-state__icon" style={{ color: 'var(--color-danger)' }}>
                        <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <circle cx="12" cy="12" r="10"/>
                            <line x1="12" y1="8" x2="12" y2="12"/>
                            <line x1="12" y1="16" x2="12.01" y2="16"/>
                        </svg>
                    </div>
                    <div className="entity-empty-state__title">Error Loading Teams</div>
                    <div className="entity-empty-state__description">{error}</div>
                    <Button variant="primary" onClick={() => window.location.reload()}>
                        Try Again
                    </Button>
                </div>
            </div>
        );
    }

    // Calculate stats from filtered teams
    const totalMembers = filteredTeams.reduce((sum, t) => sum + (t.member_count || 0), 0);
    const myTeams = filteredTeams.filter(t => t.my_role);

    // Resolve section title from filters
    const sectionTitle = selectedDepartmentId
        ? `${departments.find(d => d.id === selectedDepartmentId)?.name || 'Department'} Teams`
        : selectedDivisionId
            ? `${divisions.find(d => d.id === selectedDivisionId)?.name || 'Division'} Teams`
            : 'All Teams';

    // Empty state
    if (teams.length === 0) {
        return (
            <div className="teams-view view-page">
                <div className="entity-empty-state" style={{ marginTop: '60px' }}>
                    <div className="entity-empty-state__icon">
                        <TeamIcon />
                    </div>
                    <div className="entity-empty-state__title">No Teams Yet</div>
                    <div className="entity-empty-state__description">
                        Teams are created automatically when you create an organisation, division, or department.
                        Each team gets its own collaborative AI assistant.
                    </div>
                    <Button variant="primary" onClick={() => navigate('/orgs')} style={{ marginTop: '8px' }}>
                        <BuildingIcon />
                        <span style={{ marginLeft: '8px' }}>Go to Organisations</span>
                    </Button>
                </div>
            </div>
        );
    }

    // Main view with teams
    return (
        <div className="teams-view view-page org-components">
            <OrgBanner org={currentOrg} />

            {/* Stats Overview */}
            <PageSection>
                <div className="stats-grid" style={{ marginBottom: '8px' }}>
                    <div className="stat-card-v2">
                        <div className="stat-card-v2__value">{filteredTeams.length}</div>
                        <div className="stat-card-v2__label">Teams</div>
                    </div>
                    <div className="stat-card-v2">
                        <div className="stat-card-v2__value">{totalMembers}</div>
                        <div className="stat-card-v2__label">Total Members</div>
                    </div>
                    <div className="stat-card-v2">
                        <div className="stat-card-v2__value">{myTeams.length}</div>
                        <div className="stat-card-v2__label">Your Teams</div>
                    </div>
                    <div className="stat-card-v2">
                        <div className="stat-card-v2__value">{filteredTeams.length}</div>
                        <div className="stat-card-v2__label">AI Assistants</div>
                    </div>
                </div>
            </PageSection>

            {/* Filter Bar */}
            {divisions.length > 0 && (
                <div className="entity-view__filters">
                    <div className="entity-view__filter-group">
                        <label>Division:</label>
                        <select
                            value={selectedDivisionId || ''}
                            onChange={(e) => {
                                setSelectedDivisionId(e.target.value || null);
                                setSelectedDepartmentId(null);
                            }}
                        >
                            <option value="">All Divisions</option>
                            {divisions.map(div => (
                                <option key={div.id} value={div.id}>{div.name}</option>
                            ))}
                        </select>
                    </div>
                    <div className="entity-view__filter-group">
                        <label>Department:</label>
                        <select
                            value={selectedDepartmentId || ''}
                            onChange={(e) => setSelectedDepartmentId(e.target.value || null)}
                            disabled={!selectedDivisionId}
                        >
                            <option value="">All Departments</option>
                            {departments.map(dept => (
                                <option key={dept.id} value={dept.id}>{dept.name}</option>
                            ))}
                        </select>
                    </div>
                </div>
            )}

            {/* Teams Grid */}
            <PageSection title={sectionTitle}>
                {filteredTeams.length > 0 ? (
                    <PageGrid columns={2}>
                        {filteredTeams.map(team => (
                            <TeamCard
                                key={team.id}
                                team={team}
                                orgName={currentOrg.name}
                                onClick={handleManageTeam}
                                onChat={handleChatWithTeam}
                                onManage={handleManageTeam}
                            />
                        ))}
                    </PageGrid>
                ) : (
                    <div className="entity-empty-state" style={{ marginTop: '20px' }}>
                        <div className="entity-empty-state__title">No teams match this filter</div>
                        <div className="entity-empty-state__description">
                            Try selecting a different division or department, or clear the filters.
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
                    <strong style={{ color: 'var(--text-primary)' }}>Tip:</strong> Each team has
                    its own AI assistant that specializes in that team's domain. Click "Chat" to start a
                    conversation with any team's assistant.
                </span>
            </div>

        </div>
    );
}

export default TeamsView;
