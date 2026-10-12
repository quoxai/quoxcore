/**
 * Workspace Overview Page
 * Dashboard view showing key metrics and recent activity
 */

import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';

export default function WorkspaceOverview() {
    const { authFetch } = useAuth();
    const { currentOrg, currentScope, myTeams } = useWorkspace();
    const [stats, setStats] = useState(null);
    const [recentActivity, setRecentActivity] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (currentOrg?.id) {
            loadDashboardData();
        }
    }, [currentOrg?.id, currentScope?.id]);

    const loadDashboardData = async () => {
        setLoading(true);
        try {
            // Load stats in parallel
            const [toolsRes, workflowsRes, assistantsRes] = await Promise.all([
                authFetch(`/api/orgs/${currentOrg.id}/tools?limit=1`),
                authFetch(`/api/orgs/${currentOrg.id}/workflows?limit=1`),
                authFetch(`/api/orgs/${currentOrg.id}/assistants?limit=1`)
            ]);

            const toolsData = toolsRes.ok ? await toolsRes.json() : { total: 0 };
            const workflowsData = workflowsRes.ok ? await workflowsRes.json() : { total: 0 };
            const assistantsData = assistantsRes.ok ? await assistantsRes.json() : { total: 0 };

            setStats({
                tools: toolsData.total || 0,
                workflows: workflowsData.total || 0,
                assistants: assistantsData.total || 0,
                teams: myTeams.length
            });
        } catch (err) {
            console.error('Failed to load dashboard data:', err);
        } finally {
            setLoading(false);
        }
    };

    if (!currentOrg) {
        return (
            <div className="workspace-overview">
                <div className="page-header">
                    <h1>Welcome to QuoxCORE Workspace</h1>
                    <p>Get started by selecting or creating an organization</p>
                </div>

                <div className="workspace-card" style={{ textAlign: 'center', padding: '48px' }}>
                    <div style={{ fontSize: '48px', marginBottom: '16px', opacity: 0.5 }}>[]</div>
                    <h3 style={{ margin: '0 0 8px', color: '#999' }}>No Organization Selected</h3>
                    <p style={{ color: '#666', marginBottom: '24px' }}>
                        Organizations help you manage teams, tools, and workflows.
                        Create your first organization or select one from the dropdown above.
                    </p>
                    <button
                        className="btn btn-primary"
                        onClick={() => {
                            // Trigger org creation modal
                            const event = new CustomEvent('createOrg');
                            window.dispatchEvent(event);
                        }}
                    >
                        + Create Organization
                    </button>
                </div>

                <div className="workspace-card" style={{ marginTop: '24px' }}>
                    <h3>What you can do with Organizations</h3>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px', marginTop: '16px' }}>
                        <div style={{ padding: '16px', background: '#1a1a1a', borderRadius: '8px' }}>
                            <div style={{ color: '#4ecdc4', fontFamily: 'monospace', marginBottom: '8px' }}>&lt;&gt;</div>
                            <strong>Manage Tools</strong>
                            <p style={{ color: '#666', fontSize: '13px', margin: '8px 0 0' }}>
                                Register and configure MCP tools, APIs, and scripts
                            </p>
                        </div>
                        <div style={{ padding: '16px', background: '#1a1a1a', borderRadius: '8px' }}>
                            <div style={{ color: '#4ecdc4', fontFamily: 'monospace', marginBottom: '8px' }}>&gt;&gt;</div>
                            <strong>Build Workflows</strong>
                            <p style={{ color: '#666', fontSize: '13px', margin: '8px 0 0' }}>
                                Create multi-step automations and orchestrations
                            </p>
                        </div>
                        <div style={{ padding: '16px', background: '#1a1a1a', borderRadius: '8px' }}>
                            <div style={{ color: '#4ecdc4', fontFamily: 'monospace', marginBottom: '8px' }}>##</div>
                            <strong>Organize Teams</strong>
                            <p style={{ color: '#666', fontSize: '13px', margin: '8px 0 0' }}>
                                Create teams, invite members, and set permissions
                            </p>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="workspace-overview">
            <div className="page-header">
                <h1>Workspace Overview</h1>
                <p>Welcome to {currentOrg.name}</p>
            </div>

            {loading ? (
                <div style={{ textAlign: 'center', padding: '48px' }}>
                    <div className="loading-spinner" />
                </div>
            ) : (
                <>
                    <div className="stats-grid">
                        <Link to="/workspace/tools" className="stat-card">
                            <div className="stat-value">{stats?.tools || 0}</div>
                            <div className="stat-label">Tools</div>
                        </Link>
                        <Link to="/workspace/workflows" className="stat-card">
                            <div className="stat-value">{stats?.workflows || 0}</div>
                            <div className="stat-label">Workflows</div>
                        </Link>
                        <Link to="/workspace/assistants" className="stat-card">
                            <div className="stat-value">{stats?.assistants || 0}</div>
                            <div className="stat-label">Assistants</div>
                        </Link>
                        <Link to="/workspace/teams" className="stat-card">
                            <div className="stat-value">{stats?.teams || 0}</div>
                            <div className="stat-label">My Teams</div>
                        </Link>
                    </div>

                    <div className="workspace-card">
                        <h3>Quick Actions</h3>
                        <div style={{ display: 'flex', gap: '12px', marginTop: '16px' }}>
                            <Link to="/workspace/tools" className="btn btn-secondary">
                                Browse Tools
                            </Link>
                            <Link to="/workspace/assistants" className="btn btn-secondary">
                                Browse Assistants
                            </Link>
                            <Link to="/workspace/directory" className="btn btn-secondary">
                                Search Directory
                            </Link>
                        </div>
                    </div>

                    {currentScope && (
                        <div className="workspace-card" style={{ marginTop: '16px' }}>
                            <h3>Current Scope</h3>
                            <p style={{ color: '#888', marginTop: '8px' }}>
                                Viewing: <strong style={{ color: '#4ecdc4' }}>{currentScope.name_cache}</strong>
                                <span style={{ color: '#666' }}> ({currentScope.scope_type})</span>
                            </p>
                            <p style={{ color: '#666', fontSize: '13px', marginTop: '4px' }}>
                                Path: {currentScope.path}
                            </p>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
