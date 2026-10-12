/**
 * VaultSidebar — Filter sidebar for vault credentials page
 *
 * Left panel with:
 * - Type filter tree (grouped by category)
 * - Status filter
 * - Folder filter (placeholder for Phase 7)
 * - View toggle (grid/table)
 */

import { useMemo } from 'react';
import { INTEGRATION_TYPES, INTEGRATION_CATEGORIES, getIntegrationsByCategory } from '../../config/integrationTypes';
import './vault.css';

// Icons
const GridIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
        <rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" />
    </svg>
);

const TableIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" />
        <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
);

const ChevronIcon = ({ open }) => (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
        style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s ease' }}>
        <polyline points="9 18 15 12 9 6" />
    </svg>
);

const FolderIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
);

export default function VaultSidebar({
    credentials = [],
    activeType = 'all',
    activeStatus = 'all',
    activeFolder = 'all',
    viewMode = 'grid',
    onTypeChange,
    onStatusChange,
    onFolderChange,
    onViewChange,
}) {
    // Build type counts from credentials
    const typeCounts = useMemo(() => {
        const counts = {};
        for (const cred of credentials) {
            const t = cred.integration_type;
            counts[t] = (counts[t] || 0) + 1;
        }
        return counts;
    }, [credentials]);

    // Build status counts
    const statusCounts = useMemo(() => {
        let healthy = 0, failed = 0, untested = 0;
        for (const cred of credentials) {
            if (cred.test_status === 'success') healthy++;
            else if (cred.test_status === 'failed') failed++;
            else untested++;
        }
        return { healthy, failed, untested, all: credentials.length };
    }, [credentials]);

    // Group types by category
    const categoryGroups = useMemo(() => {
        const groups = [];
        const byCategory = getIntegrationsByCategory();
        for (const [catId, catData] of Object.entries(byCategory)) {
            const cat = INTEGRATION_CATEGORIES[catId];
            if (!cat) continue;
            const typeList = catData.integrations || [];
            const withCounts = typeList.filter(t => typeCounts[t.id]);
            if (withCounts.length === 0) continue;
            groups.push({
                id: catId,
                label: cat.name,
                types: withCounts.map(t => ({
                    id: t.id,
                    name: t.name,
                    count: typeCounts[t.id] || 0,
                    color: t.color
                }))
            });
        }
        return groups;
    }, [typeCounts]);

    // Folder list from credentials (placeholder — real folders come in Phase 7)
    const folders = useMemo(() => {
        const set = new Set();
        for (const cred of credentials) {
            if (cred.folder_id) set.add(cred.folder_id);
        }
        return Array.from(set);
    }, [credentials]);

    return (
        <aside className="vault-sidebar">
            {/* View Toggle */}
            <div className="vault-sidebar__section">
                <div className="vault-sidebar__view-toggle">
                    <button
                        className={`vault-sidebar__view-btn ${viewMode === 'grid' ? 'vault-sidebar__view-btn--active' : ''}`}
                        onClick={() => onViewChange('grid')}
                        title="Grid view"
                    >
                        <GridIcon />
                    </button>
                    <button
                        className={`vault-sidebar__view-btn ${viewMode === 'table' ? 'vault-sidebar__view-btn--active' : ''}`}
                        onClick={() => onViewChange('table')}
                        title="Table view"
                    >
                        <TableIcon />
                    </button>
                </div>
            </div>

            {/* Status Filter */}
            <div className="vault-sidebar__section">
                <h4 className="vault-sidebar__section-title">Status</h4>
                <div className="vault-sidebar__filter-list">
                    {[
                        { id: 'all', label: 'All', count: statusCounts.all },
                        { id: 'healthy', label: 'Healthy', count: statusCounts.healthy, dot: 'success' },
                        { id: 'failed', label: 'Failed', count: statusCounts.failed, dot: 'failed' },
                        { id: 'untested', label: 'Untested', count: statusCounts.untested, dot: 'untested' },
                    ].map(item => (
                        <button
                            key={item.id}
                            className={`vault-sidebar__filter-item ${activeStatus === item.id ? 'vault-sidebar__filter-item--active' : ''}`}
                            onClick={() => onStatusChange(item.id)}
                        >
                            {item.dot && <span className={`vault-sidebar__dot vault-sidebar__dot--${item.dot}`} />}
                            <span className="vault-sidebar__filter-label">{item.label}</span>
                            <span className="vault-sidebar__filter-count">{item.count}</span>
                        </button>
                    ))}
                </div>
            </div>

            {/* Type Filter */}
            <div className="vault-sidebar__section">
                <h4 className="vault-sidebar__section-title">Type</h4>
                <div className="vault-sidebar__filter-list">
                    <button
                        className={`vault-sidebar__filter-item ${activeType === 'all' ? 'vault-sidebar__filter-item--active' : ''}`}
                        onClick={() => onTypeChange('all')}
                    >
                        <span className="vault-sidebar__filter-label">All Types</span>
                        <span className="vault-sidebar__filter-count">{credentials.length}</span>
                    </button>
                    {categoryGroups.map(cat => (
                        <div key={cat.id} className="vault-sidebar__category">
                            <span className="vault-sidebar__category-label">{cat.label}</span>
                            {cat.types.map(t => (
                                <button
                                    key={t.id}
                                    className={`vault-sidebar__filter-item vault-sidebar__filter-item--indent ${activeType === t.id ? 'vault-sidebar__filter-item--active' : ''}`}
                                    onClick={() => onTypeChange(t.id)}
                                >
                                    <span
                                        className="vault-sidebar__type-dot"
                                        style={{ background: t.color }}
                                    />
                                    <span className="vault-sidebar__filter-label">{t.name}</span>
                                    <span className="vault-sidebar__filter-count">{t.count}</span>
                                </button>
                            ))}
                        </div>
                    ))}
                </div>
            </div>

            {/* Folders (placeholder — Phase 7) */}
            {folders.length > 0 && (
                <div className="vault-sidebar__section">
                    <h4 className="vault-sidebar__section-title">Folders</h4>
                    <div className="vault-sidebar__filter-list">
                        <button
                            className={`vault-sidebar__filter-item ${activeFolder === 'all' ? 'vault-sidebar__filter-item--active' : ''}`}
                            onClick={() => onFolderChange('all')}
                        >
                            <FolderIcon />
                            <span className="vault-sidebar__filter-label">All</span>
                        </button>
                        {folders.map(fId => (
                            <button
                                key={fId}
                                className={`vault-sidebar__filter-item ${activeFolder === fId ? 'vault-sidebar__filter-item--active' : ''}`}
                                onClick={() => onFolderChange(fId)}
                            >
                                <FolderIcon />
                                <span className="vault-sidebar__filter-label">{fId}</span>
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </aside>
    );
}
