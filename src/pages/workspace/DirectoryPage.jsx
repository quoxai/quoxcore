/**
 * Directory Page
 * Universal search and browse for all workspace assets
 */

import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';

const ASSET_TYPES = [
    { id: 'all', label: 'All', icon: '*' },
    { id: 'tool', label: 'Tools', icon: '<>' },
    { id: 'workflow', label: 'Workflows', icon: '>>' },
    { id: 'assistant', label: 'Assistants', icon: '@' }
];

export default function DirectoryPage() {
    const { authFetch } = useAuth();
    const { currentOrg, currentScope } = useWorkspace();

    const [searchQuery, setSearchQuery] = useState('');
    const [assetType, setAssetType] = useState('all');
    const [results, setResults] = useState([]);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (currentOrg?.id) {
            searchAssets();
        }
    }, [currentOrg?.id, assetType, searchQuery]);

    const searchAssets = async () => {
        if (!currentOrg?.id) return;

        setLoading(true);
        try {
            const endpoints = assetType === 'all'
                ? ['tools', 'workflows', 'assistants']
                : [assetType === 'tool' ? 'tools' : assetType === 'workflow' ? 'workflows' : 'assistants'];

            const promises = endpoints.map(async (endpoint) => {
                const params = new URLSearchParams();
                if (searchQuery) params.set('search', searchQuery);
                if (currentScope?.id) params.set('scope_id', currentScope.id);
                params.set('limit', '20');

                const res = await authFetch(`/api/orgs/${currentOrg.id}/${endpoint}?${params}`);
                if (res.ok) {
                    const data = await res.json();
                    return (data.items || data.tools || data.workflows || data.assistants || []).map(item => ({
                        ...item,
                        _type: endpoint.slice(0, -1) // Remove trailing 's'
                    }));
                }
                return [];
            });

            const allResults = await Promise.all(promises);
            setResults(allResults.flat());
        } catch (err) {
            console.error('Search failed:', err);
        } finally {
            setLoading(false);
        }
    };

    const getAssetLink = (item) => {
        return `/workspace/${item._type}s/${item.id}`;
    };

    const getAssetIcon = (type) => {
        const icons = { tool: '<>', workflow: '>>', assistant: '@' };
        return icons[type] || '?';
    };

    if (!currentOrg) {
        return (
            <div className="empty-state">
                <div className="empty-state-icon">{}</div>
                <h3>Select an Organization</h3>
                <p>Choose an organization to browse the directory.</p>
            </div>
        );
    }

    return (
        <div className="directory-page">
            <div className="page-header">
                <h1>Directory</h1>
                <p>Search and browse all workspace assets</p>
            </div>

            <div className="workspace-card" style={{ marginBottom: '24px' }}>
                <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
                    <div className="search-input" style={{ flex: 1 }}>
                        <span className="search-input-icon">[/]</span>
                        <input
                            type="text"
                            placeholder="Search assets..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                        />
                    </div>

                    <div style={{ display: 'flex', gap: '4px' }}>
                        {ASSET_TYPES.map(type => (
                            <button
                                key={type.id}
                                className={`btn ${assetType === type.id ? 'btn-primary' : 'btn-ghost'}`}
                                onClick={() => setAssetType(type.id)}
                            >
                                <span style={{ fontFamily: 'monospace' }}>{type.icon}</span>
                                {type.label}
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            {loading ? (
                <div style={{ textAlign: 'center', padding: '48px' }}>
                    <div className="loading-spinner" />
                </div>
            ) : results.length === 0 ? (
                <div className="empty-state">
                    <div className="empty-state-icon">(?)</div>
                    <h3>No Results</h3>
                    <p>Try adjusting your search or filters.</p>
                </div>
            ) : (
                <div className="workspace-card">
                    <table className="workspace-table">
                        <thead>
                            <tr>
                                <th>Type</th>
                                <th>Name</th>
                                <th>Description</th>
                                <th>Status</th>
                                <th></th>
                            </tr>
                        </thead>
                        <tbody>
                            {results.map(item => (
                                <tr key={`${item._type}-${item.id}`}>
                                    <td>
                                        <span style={{
                                            fontFamily: 'monospace',
                                            color: '#666',
                                            background: '#222',
                                            padding: '2px 8px',
                                            borderRadius: '4px'
                                        }}>
                                            {getAssetIcon(item._type)}
                                        </span>
                                    </td>
                                    <td>
                                        <Link
                                            to={getAssetLink(item)}
                                            style={{ color: '#4ecdc4', textDecoration: 'none' }}
                                        >
                                            {item.name}
                                        </Link>
                                    </td>
                                    <td style={{ color: '#888', maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                        {item.description || '-'}
                                    </td>
                                    <td>
                                        <span style={{
                                            fontSize: '12px',
                                            padding: '2px 8px',
                                            borderRadius: '4px',
                                            background: item.status === 'active' ? '#1a3d2e' : '#2a2a2a',
                                            color: item.status === 'active' ? '#4ecdc4' : '#888'
                                        }}>
                                            {item.status}
                                        </span>
                                    </td>
                                    <td>
                                        <Link
                                            to={getAssetLink(item)}
                                            className="btn btn-ghost"
                                            style={{ padding: '4px 8px' }}
                                        >
                                            View
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
