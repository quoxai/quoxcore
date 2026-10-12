/**
 * Tools Page
 * List and manage tools
 */

import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';

const TOOL_TYPES = {
    mcp: { label: 'MCP', color: '#4ecdc4' },
    function: { label: 'Function', color: '#f39c12' },
    api: { label: 'API', color: '#9b59b6' },
    script: { label: 'Script', color: '#3498db' },
    workflow: { label: 'Workflow', color: '#e74c3c' }
};

export default function ToolsPage() {
    const { authFetch } = useAuth();
    const { currentOrg, currentScope } = useWorkspace();

    const [tools, setTools] = useState([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState({ status: '', type: '', search: '' });

    useEffect(() => {
        if (currentOrg?.id) {
            loadTools();
        }
    }, [currentOrg?.id, currentScope?.id, filter]);

    const loadTools = async () => {
        setLoading(true);
        try {
            const params = new URLSearchParams();
            if (filter.status) params.set('status', filter.status);
            if (filter.type) params.set('type', filter.type);
            if (filter.search) params.set('search', filter.search);
            if (currentScope?.id) params.set('scope_id', currentScope.id);

            const res = await authFetch(`/api/orgs/${currentOrg.id}/tools?${params}`);
            if (res.ok) {
                const data = await res.json();
                setTools(data.items || []);
            }
        } catch (err) {
            console.error('Failed to load tools:', err);
        } finally {
            setLoading(false);
        }
    };

    if (!currentOrg) {
        return (
            <div className="empty-state">
                <div className="empty-state-icon">&lt;&gt;</div>
                <h3>Select an Organization</h3>
                <p>Choose an organization to view tools.</p>
            </div>
        );
    }

    return (
        <div className="tools-page">
            <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                    <h1>Tools</h1>
                    <p>Manage and browse available tools</p>
                </div>
                <button className="btn btn-primary">
                    + Create Tool
                </button>
            </div>

            <div className="workspace-card" style={{ marginBottom: '24px' }}>
                <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
                    <div className="search-input" style={{ flex: 1, maxWidth: '300px' }}>
                        <span className="search-input-icon">[/]</span>
                        <input
                            type="text"
                            placeholder="Search tools..."
                            value={filter.search}
                            onChange={(e) => setFilter(f => ({ ...f, search: e.target.value }))}
                        />
                    </div>

                    <select
                        value={filter.type}
                        onChange={(e) => setFilter(f => ({ ...f, type: e.target.value }))}
                        style={{
                            background: '#1a1a1a',
                            border: '1px solid #333',
                            borderRadius: '6px',
                            padding: '8px 12px',
                            color: '#e0e0e0'
                        }}
                    >
                        <option value="">All Types</option>
                        {Object.entries(TOOL_TYPES).map(([key, val]) => (
                            <option key={key} value={key}>{val.label}</option>
                        ))}
                    </select>

                    <select
                        value={filter.status}
                        onChange={(e) => setFilter(f => ({ ...f, status: e.target.value }))}
                        style={{
                            background: '#1a1a1a',
                            border: '1px solid #333',
                            borderRadius: '6px',
                            padding: '8px 12px',
                            color: '#e0e0e0'
                        }}
                    >
                        <option value="">All Status</option>
                        <option value="draft">Draft</option>
                        <option value="active">Active</option>
                        <option value="deprecated">Deprecated</option>
                    </select>
                </div>
            </div>

            {loading ? (
                <div style={{ textAlign: 'center', padding: '48px' }}>
                    <div className="loading-spinner" />
                </div>
            ) : tools.length === 0 ? (
                <div className="empty-state">
                    <div className="empty-state-icon">&lt;&gt;</div>
                    <h3>No Tools Found</h3>
                    <p>Create your first tool to get started.</p>
                    <button className="empty-state-action">
                        + Create Tool
                    </button>
                </div>
            ) : (
                <div className="workspace-card">
                    <table className="workspace-table">
                        <thead>
                            <tr>
                                <th>Name</th>
                                <th>Type</th>
                                <th>Status</th>
                                <th>Risk</th>
                                <th>Version</th>
                                <th></th>
                            </tr>
                        </thead>
                        <tbody>
                            {tools.map(tool => (
                                <tr key={tool.id}>
                                    <td>
                                        <Link
                                            to={`/workspace/tools/${tool.id}`}
                                            style={{ color: '#4ecdc4', textDecoration: 'none' }}
                                        >
                                            {tool.name}
                                        </Link>
                                        {tool.description && (
                                            <div style={{ color: '#666', fontSize: '12px', marginTop: '2px' }}>
                                                {tool.description.slice(0, 60)}{tool.description.length > 60 ? '...' : ''}
                                            </div>
                                        )}
                                    </td>
                                    <td>
                                        <span style={{
                                            fontSize: '12px',
                                            padding: '2px 8px',
                                            borderRadius: '4px',
                                            background: `${TOOL_TYPES[tool.tool_type]?.color}22`,
                                            color: TOOL_TYPES[tool.tool_type]?.color
                                        }}>
                                            {TOOL_TYPES[tool.tool_type]?.label || tool.tool_type}
                                        </span>
                                    </td>
                                    <td>
                                        <span style={{
                                            fontSize: '12px',
                                            padding: '2px 8px',
                                            borderRadius: '4px',
                                            background: tool.status === 'active' ? '#1a3d2e' : '#2a2a2a',
                                            color: tool.status === 'active' ? '#4ecdc4' : '#888'
                                        }}>
                                            {tool.status}
                                        </span>
                                    </td>
                                    <td style={{ color: '#888', fontSize: '13px' }}>
                                        {tool.risk_level}
                                    </td>
                                    <td style={{ color: '#666', fontSize: '13px' }}>
                                        v{tool.version}
                                    </td>
                                    <td>
                                        <Link
                                            to={`/workspace/tools/${tool.id}`}
                                            className="btn btn-ghost"
                                            style={{ padding: '4px 8px' }}
                                        >
                                            Edit
                                        </Link>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
