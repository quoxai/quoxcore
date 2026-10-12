/**
 * ToolsView - Tool Library Management
 *
 * Agent-Centric Architecture:
 * - Tools are assigned to AGENTS, not users/orgs directly
 * - Assistants delegate to agents with specific toolsets
 * - No agent should have access to ALL tools
 *
 * Tabs:
 * - Catalog: Browse and search the global tool library
 * - Installed: Manage tools installed in the org
 * - Agents: Manage agents and their tool assignments
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useOutletContext, useSearchParams, useNavigate, useLocation, Link } from 'react-router-dom';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useAuth } from '../../contexts/AuthContext';
import { PageSection, PageGrid, PageCard } from '../../components/layout';
import RegisterToolModal from '../../components/tools/AddToolModal';
import ToolCard from '../../components/tools/ToolCard';
import DeployPowerWizard from '../../components/powers/DeployPowerWizard';
import {
    isDeployable as isCatalogToolDeployable,
    isCatalogEntryActionable,
    catalogInertReason,
} from '../../lib/catalogExecutorTypes';
import { listCategories } from '../../services/toolCategoriesClient';
import {
    listInstalledTools,
    installToolToScope,
    uninstallToolFromScope,
} from '../../services/toolInstallScopeClient';
import AgentToolMatrix from '../../components/library/AgentToolMatrix';
import ToolAuditTable from '../../components/library/ToolAuditTable';
import { QuartermasterSidebar } from '../../components/quartermaster/QuartermasterSidebar';
import './views.css';

// Default fallback for when a category id is not found in the API-loaded map
const _CAT_FALLBACK = { icon: '🔧', name: 'Tool', color: '#6b7280' };

// ============================================================================
// CATEGORY SIDEBAR — parent → subcategory tree
// ============================================================================

/**
 * Prettify a hyphenated subcategory slug into a display label.
 * General rule: split on hyphen, capitalise each word.
 * Overrides for acronyms and pluralisation.
 */
const SUBCATEGORY_OVERRIDES = {
    'mcp-server': 'MCP Servers',
    'mcp': 'MCP (curated)',
    'public-api': 'Public APIs',
    'ml-database': 'ML Databases',
    'vector-db': 'Vector DBs',
    'ai-utility': 'AI Utility',
    'ai-coding': 'AI Coding',
    'browser-automation': 'Browser Automation',
    'web-scraping': 'Web Scraping',
    'osint': 'OSINT',
    'sdk': 'SDK',
    'vcs': 'VCS',
    'self-hosted': 'Self-Hosted',
};

export function prettyLabel(subcategory) {
    if (!subcategory) return 'Other';
    const lower = subcategory.toLowerCase();
    if (SUBCATEGORY_OVERRIDES[lower]) return SUBCATEGORY_OVERRIDES[lower];
    // General: split hyphen, capitalise, apply acronym overrides per word
    const ACRONYMS = new Set(['mcp', 'ml', 'ai', 'db', 'api', 'sdk', 'vcs', 'osint']);
    return lower
        .split('-')
        .map(w => ACRONYMS.has(w) ? w.toUpperCase() : (w.charAt(0).toUpperCase() + w.slice(1)))
        .join(' ');
}

// Canonical parent order
const PARENT_ORDER = ['Connectors', 'Development', 'Finance', 'Security', 'Self-Hosted', 'AI', 'Productivity'];

/**
 * Build grouped structure: [ { parent, count, subcategories: [{id, label, count}] } ]
 * from the full tool list.
 */
function buildParentTree(tools) {
    const parentMap = {};
    tools.forEach(t => {
        const p = t.parent_category || 'Other';
        const s = t.subcategory || 'other';
        if (!parentMap[p]) parentMap[p] = {};
        if (!parentMap[p][s]) parentMap[p][s] = 0;
        parentMap[p][s]++;
    });
    // Sort parents by canonical order, then alphabetically for unknowns
    const parents = Object.keys(parentMap).sort((a, b) => {
        const ai = PARENT_ORDER.indexOf(a);
        const bi = PARENT_ORDER.indexOf(b);
        if (ai !== -1 && bi !== -1) return ai - bi;
        if (ai !== -1) return -1;
        if (bi !== -1) return 1;
        return a.localeCompare(b);
    });
    return parents.map(parent => {
        const subMap = parentMap[parent];
        const subcategories = Object.entries(subMap)
            .map(([id, count]) => ({ id, label: prettyLabel(id), count }))
            .sort((a, b) => b.count - a.count);
        const count = subcategories.reduce((s, c) => s + c.count, 0);
        return { parent, count, subcategories };
    });
}

// Parent category icons
const PARENT_ICONS = {
    Connectors: '🔌',
    Development: '💻',
    Finance: '💰',
    Security: '🛡️',
    'Self-Hosted': '🏠',
    AI: '🤖',
    Productivity: '📋',
};

function CategorySidebar({
    tools,
    selectedParentCategory,
    selectedSubcategories,
    expandedParents,
    onParentClick,
    onSubcategoryToggle,
    onToggleExpand,
    showAllCategories,
    onToggleShowAll,
    // Legacy flat-list props
    panelCategories,
    selectedCategory,
    onLegacySelect,
    panelTotalCount,
    showFilterBar,
}) {
    const tree = buildParentTree(tools);

    return (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 8px 16px' }}>
            {/* All Tools row */}
            <button
                className={`tool-cat-row${!selectedParentCategory && !selectedCategory && selectedSubcategories.size === 0 ? ' tool-cat-row--active' : ''}`}
                onClick={() => { onParentClick(null); onLegacySelect(null); }}
            >
                <span className="tool-cat-row__icon">📦</span>
                <span className="tool-cat-row__label">All Tools</span>
                <span className="tool-cat-row__count">{panelTotalCount}</span>
            </button>

            {/* Parent → subcategory tree */}
            {showFilterBar && !showAllCategories && tree.map(({ parent, count, subcategories }) => {
                const isExpanded = expandedParents.has(parent);
                const isParentActive = selectedParentCategory === parent && selectedSubcategories.size === 0;
                const hasSubSelected = selectedSubcategories.size > 0 && subcategories.some(s => selectedSubcategories.has(s.id));
                return (
                    <div key={parent} className="tool-cat-group">
                        <div className="tool-cat-parent">
                            <button
                                className={`tool-cat-row tool-cat-row--parent${isParentActive || hasSubSelected ? ' tool-cat-row--active' : ''}`}
                                onClick={() => onParentClick(parent)}
                                title={`Filter by ${parent}`}
                            >
                                <span className="tool-cat-row__icon">{PARENT_ICONS[parent] || '📁'}</span>
                                <span className="tool-cat-row__label">{parent}</span>
                                <span className="tool-cat-row__count">{count}</span>
                            </button>
                            <button
                                className="tool-cat-expand-btn"
                                aria-label={isExpanded ? `Collapse ${parent}` : `Expand ${parent}`}
                                onClick={() => onToggleExpand(parent)}
                            >
                                {isExpanded ? '▾' : '▸'}
                            </button>
                        </div>
                        {isExpanded && (
                            <div className="tool-cat-subcategories">
                                {subcategories.map(sub => {
                                    const checked = selectedSubcategories.has(sub.id);
                                    return (
                                        <label key={sub.id} className="tool-cat-subrow">
                                            <input
                                                type="checkbox"
                                                className="tool-cat-subrow__check"
                                                checked={checked}
                                                onChange={() => onSubcategoryToggle(sub.id)}
                                            />
                                            <span className="tool-cat-subrow__label">{sub.label}</span>
                                            <span className="tool-cat-row__count">{sub.count}</span>
                                        </label>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                );
            })}

            {!showFilterBar && (
                <div style={{ padding: '12px 12px', fontSize: 12, opacity: 0.5 }}>
                    No category filter for this tab.
                </div>
            )}
        </div>
    );
}

// Risk level colors
const RISK_COLORS = {
    low: 'var(--color-success, #22c55e)',
    medium: 'var(--color-warning, #eab308)',
    high: 'var(--color-danger, #f97316)',
    critical: 'var(--color-error, #ef4444)'
};

// Sandbox profile icons
const SANDBOX_ICONS = {
    restricted: '[ ]',
    standard: '[~]',
    privileged: '[!]'
};

// ============================================================================
// CORE TOOL COMPONENTS
// ============================================================================

function CoreToolCard({ tool, agents, onView, categoryById = {} }) {
    const catMeta = categoryById[tool.category] || _CAT_FALLBACK;

    return (
        <div className="workflow-card core-tool-card">
            <div className="workflow-card__category" style={{ backgroundColor: catMeta.color }}>
                <span className="category-emoji">{catMeta.icon}</span>
            </div>
            <div className="workflow-card__content">
                <h4 className="workflow-card__name">
                    <code style={{ fontSize: '0.85em', opacity: 0.9 }}>{tool.name}</code>
                </h4>
                <p className="workflow-card__description">{tool.description}</p>
                <div className="workflow-card__meta">
                    <span className="core-badge" style={{ background: 'rgba(59, 130, 246, 0.15)', color: '#60a5fa', border: '1px solid rgba(59, 130, 246, 0.3)', borderRadius: '4px', padding: '2px 6px', fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                        CORE
                    </span>
                    {agents && agents.length > 0 && (
                        <span className="workflow-card__integration" title={`Used by: ${agents.join(', ').toUpperCase()}`}>
                            {agents.length} agent{agents.length !== 1 ? 's' : ''}
                        </span>
                    )}
                    {tool.input_schema?.required?.length > 0 && (
                        <span className="workflow-card__integration">
                            {tool.input_schema.required.length} param{tool.input_schema.required.length !== 1 ? 's' : ''}
                        </span>
                    )}
                </div>
                <div className="workflow-card__actions">
                    <button className="workflow-card__btn" onClick={(e) => { e.stopPropagation(); onView?.(); }}>
                        View Details
                    </button>
                    <span className="tool-installed-badge" style={{ background: 'rgba(34, 197, 94, 0.1)', color: '#22c55e', fontSize: '0.75rem' }}>
                        Active
                    </span>
                </div>
            </div>
        </div>
    );
}

function PluginToolCard({ tool, agents, onView, categoryById = {} }) {
    const catMeta = categoryById[tool.category] || _CAT_FALLBACK;

    return (
        <div className="workflow-card core-tool-card">
            <div className="workflow-card__category" style={{ backgroundColor: catMeta.color }}>
                <span className="category-emoji">{catMeta.icon}</span>
            </div>
            <div className="workflow-card__content">
                <h4 className="workflow-card__name">
                    <code style={{ fontSize: '0.85em', opacity: 0.9 }}>{tool.name}</code>
                </h4>
                <p className="workflow-card__description">{tool.description}</p>
                <div className="workflow-card__meta">
                    <span className="core-badge" style={{ background: 'rgba(168, 85, 247, 0.15)', color: '#a855f7', border: '1px solid rgba(168, 85, 247, 0.3)', borderRadius: '4px', padding: '2px 6px', fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                        PLUGIN{tool.provider ? ` : ${tool.provider}` : ''}
                    </span>
                    {agents && agents.length > 0 && (
                        <span className="workflow-card__integration" title={`Used by: ${agents.join(', ').toUpperCase()}`}>
                            {agents.length} agent{agents.length !== 1 ? 's' : ''}
                        </span>
                    )}
                    {tool.input_schema?.required?.length > 0 && (
                        <span className="workflow-card__integration">
                            {tool.input_schema.required.length} param{tool.input_schema.required.length !== 1 ? 's' : ''}
                        </span>
                    )}
                </div>
                <div className="workflow-card__actions">
                    <button className="workflow-card__btn" onClick={(e) => { e.stopPropagation(); onView?.(); }}>
                        View Details
                    </button>
                    <span className="tool-installed-badge" style={{ background: 'rgba(168, 85, 247, 0.1)', color: '#a855f7', fontSize: '0.75rem' }}>
                        Entity
                    </span>
                </div>
            </div>
        </div>
    );
}

function CoreToolDetailModal({ tool, agents, onClose, categoryById = {} }) {
    if (!tool) return null;
    const catMeta = categoryById[tool.category] || _CAT_FALLBACK;
    const params = tool.input_schema?.properties || {};
    const required = new Set(tool.input_schema?.required || []);

    return (
        <div className="qx-modal-overlay" onClick={onClose}>
            <div className="qx-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '600px' }}>
                <div className="qx-modal__header">
                    <h2>{catMeta.icon} {tool.name}</h2>
                    <button className="qx-btn qx-btn--ghost qx-btn--sm" onClick={onClose}>✕</button>
                </div>

                <p className="tool-detail__desc">{tool.description}</p>

                <div className="tool-detail__section">
                    <h4 className="tool-detail__section-label">Properties</h4>
                    <div className="tool-detail__props">
                        <div className="tool-property">
                            <span className="property-label">Category</span>
                            <span style={{ color: catMeta.color }}>{catMeta.name}</span>
                        </div>
                        <div className="tool-property">
                            <span className="property-label">Source</span>
                            <span className="tool-detail__source-badge">
                                CORE
                            </span>
                        </div>
                        <div className="tool-property tool-detail__prop-full">
                            <span className="property-label">Used by Agents</span>
                            <div className="tool-detail__agents">
                                {(agents || []).map(a => (
                                    <span key={a} className="tool-detail__agent-tag">{a}</span>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>

                {Object.keys(params).length > 0 && (
                    <div className="tool-detail__section">
                        <h4 className="tool-detail__section-label">Input Parameters</h4>
                        <div className="tool-detail__params">
                            {Object.entries(params).map(([name, schema]) => (
                                <div key={name} className="tool-detail__param">
                                    <div className="tool-detail__param-head">
                                        <code className="tool-detail__param-name">{name}</code>
                                        <span className="tool-detail__param-type">{schema.type || 'string'}</span>
                                        {required.has(name) && (
                                            <span className="tool-detail__param-required">REQUIRED</span>
                                        )}
                                    </div>
                                    {schema.description && (
                                        <p className="tool-detail__param-desc">{schema.description}</p>
                                    )}
                                    {schema.enum && (
                                        <p className="tool-detail__param-enum">
                                            Options: {schema.enum.join(', ')}
                                        </p>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                <div className="qx-modal__actions">
                    <button className="qx-btn qx-btn--ghost" onClick={onClose}>Close</button>
                </div>
            </div>
        </div>
    );
}

function PluginToolDetailModal({ tool, agents, onClose, categoryById = {} }) {
    if (!tool) return null;
    const catMeta = categoryById[tool.category] || _CAT_FALLBACK;
    const params = tool.input_schema?.properties || {};
    const required = new Set(tool.input_schema?.required || []);

    return (
        <div className="qx-modal-overlay" onClick={onClose}>
            <div className="qx-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '600px' }}>
                <div className="qx-modal__header">
                    <h2>{catMeta.icon} {tool.name}</h2>
                    <button className="qx-btn qx-btn--ghost qx-btn--sm" onClick={onClose}>✕</button>
                </div>

                <p className="tool-detail__desc">{tool.description}</p>

                <div className="tool-detail__section">
                    <h4 className="tool-detail__section-label">Properties</h4>
                    <div className="tool-detail__props">
                        <div className="tool-property">
                            <span className="property-label">Category</span>
                            <span style={{ color: catMeta.color }}>{catMeta.name}</span>
                        </div>
                        <div className="tool-property">
                            <span className="property-label">Source</span>
                            <span className="tool-detail__source-badge tool-detail__source-badge--plugin">
                                PLUGIN{tool.provider ? ` : ${tool.provider}` : ''}
                            </span>
                        </div>
                        {tool.provider && (
                            <div className="tool-property">
                                <span className="property-label">Provider</span>
                                <span>{tool.provider}</span>
                            </div>
                        )}
                        <div className="tool-property tool-detail__prop-full">
                            <span className="property-label">Used by Agents</span>
                            <div className="tool-detail__agents">
                                {(agents || []).map(a => (
                                    <span key={a} className="tool-detail__agent-tag">{a}</span>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>

                {Object.keys(params).length > 0 && (
                    <div className="tool-detail__section">
                        <h4 className="tool-detail__section-label">Input Parameters</h4>
                        <div className="tool-detail__params">
                            {Object.entries(params).map(([name, schema]) => (
                                <div key={name} className="tool-detail__param">
                                    <div className="tool-detail__param-head">
                                        <code className="tool-detail__param-name tool-detail__param-name--plugin">{name}</code>
                                        <span className="tool-detail__param-type">{schema.type || 'string'}</span>
                                        {required.has(name) && (
                                            <span className="tool-detail__param-required">REQUIRED</span>
                                        )}
                                    </div>
                                    {schema.description && (
                                        <p className="tool-detail__param-desc">{schema.description}</p>
                                    )}
                                    {schema.enum && (
                                        <p className="tool-detail__param-enum">
                                            Options: {schema.enum.join(', ')}
                                        </p>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                <div className="qx-modal__actions">
                    <button className="qx-btn qx-btn--ghost" onClick={onClose}>Close</button>
                </div>
            </div>
        </div>
    );
}

// ============================================================================
// LIBRARY COMPONENTS
// ============================================================================

function ToolDetailModal({ tool, onClose, onInstall, installed, categoryById = {} }) {
    if (!tool) return null;

    const catMeta = categoryById[tool.category] || { ..._CAT_FALLBACK, name: tool.category || 'Tool' };

    return (
        <div className="qx-modal-overlay" onClick={onClose}>
            <div className="qx-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '600px' }}>
                <div className="qx-modal__header">
                    <h2>{catMeta.icon} {tool.name}</h2>
                    <button className="qx-btn qx-btn--ghost qx-btn--sm" onClick={onClose}>✕</button>
                </div>

                <p className="tool-detail__desc">{tool.description}</p>

                <div className="tool-detail__section">
                    <h4 className="tool-detail__section-label">Properties</h4>
                    <div className="tool-detail__props">
                        <div className="tool-property">
                            <span className="property-label">ID</span>
                            <code className="qx-code">{tool.id}</code>
                        </div>
                        <div className="tool-property">
                            <span className="property-label">Category</span>
                            <span>{catMeta.name}{tool.subcategory && ` / ${tool.subcategory}`}</span>
                        </div>
                        <div className="tool-property">
                            <span className="property-label">Risk Level</span>
                            <span style={{ color: RISK_COLORS[tool.risk_level], fontWeight: 600 }}>
                                {tool.risk_level}
                            </span>
                        </div>
                        <div className="tool-property">
                            <span className="property-label">Sandbox</span>
                            <span>{SANDBOX_ICONS[tool.sandbox_profile]} {tool.sandbox_profile}</span>
                        </div>
                        {tool.provider && (
                            <div className="tool-property">
                                <span className="property-label">Provider</span>
                                <span>{tool.provider}</span>
                            </div>
                        )}
                        <div className="tool-property">
                            <span className="property-label">Status</span>
                            <span className="qx-dot qx-dot--online" style={{ marginRight: 4 }} />
                            <span>{tool.status}</span>
                        </div>
                    </div>
                </div>

                {tool.reference && (
                    <div className="tool-detail__section">
                        <h4 className="tool-detail__section-label">Reference</h4>
                        <a
                            href={tool.reference}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="qx-code"
                        >
                            {tool.reference}
                        </a>
                    </div>
                )}

                <div className="qx-modal__actions">
                    <button className="qx-btn qx-btn--ghost" onClick={onClose}>Close</button>
                    {installed ? (
                        <span className="tool-installed-badge">Already Installed</span>
                    ) : (
                        <button className="qx-btn qx-btn--primary" onClick={onInstall}>
                            Install Tool
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}

// Legacy inline GitHub AddToolModal REMOVED per STUDY-REV-2/P1.A-rebuild.
// The GitHub install path will be handled by Toolsmith's GitHub sub-tab in P4.
// Placeholder: force the function to exist so the module doesn't error if any
// stale import remains (there are none in the codebase, but safe-guard it).
function _LegacyAddToolModal_REMOVED({ onClose, onAdd, existingCategories }) {
    const [url, setUrl] = useState('');
    const [loading, setLoading] = useState(false);
    const [repoInfo, setRepoInfo] = useState(null);
    const [error, setError] = useState(null);

    const [formData, setFormData] = useState({
        id: '',
        name: '',
        description: '',
        category: 'dev',
        subcategory: '',
        risk_level: 'medium',
        sandbox_profile: 'standard',
        provider: '',
        reference: ''
    });

    // Parse GitHub URL to extract owner/repo
    const parseGitHubUrl = (input) => {
        // Handle SSH format: git@github.com:owner/repo.git
        const sshMatch = input.match(/git@github\.com:([^/]+)\/([^.]+)(\.git)?/);
        if (sshMatch) {
            return { owner: sshMatch[1], repo: sshMatch[2] };
        }

        // Handle HTTPS format: https://github.com/owner/repo
        const httpsMatch = input.match(/github\.com\/([^/]+)\/([^/\s.]+)/);
        if (httpsMatch) {
            return { owner: httpsMatch[1], repo: httpsMatch[2].replace('.git', '') };
        }

        return null;
    };

    // Fetch repo info from GitHub API
    const fetchRepoInfo = async () => {
        const parsed = parseGitHubUrl(url);
        if (!parsed) {
            setError('Invalid GitHub URL. Use https://github.com/owner/repo or git@github.com:owner/repo.git');
            return;
        }

        setLoading(true);
        setError(null);

        try {
            const response = await fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}`);

            if (!response.ok) {
                if (response.status === 404) {
                    throw new Error('Repository not found. Check the URL or use SSH for private repos.');
                }
                throw new Error(`GitHub API error: ${response.status}`);
            }

            const data = await response.json();
            setRepoInfo(data);

            // Auto-fill form with repo data
            const repoName = data.name.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
            const idSlug = data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

            setFormData(prev => ({
                ...prev,
                id: `custom.${idSlug}`,
                name: repoName,
                description: data.description || '',
                provider: parsed.owner,
                reference: data.html_url
            }));

        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    const handleSubmit = (e) => {
        e.preventDefault();

        if (!formData.id || !formData.name) {
            setError('ID and Name are required');
            return;
        }

        const newTool = {
            ...formData,
            status: 'available',
            custom: true,
            addedAt: new Date().toISOString()
        };

        onAdd(newTool);
        onClose();
    };

    // Legacy modal — uses passed existingCategories (or empty fallback)
    const categories = (existingCategories || []);

    return (
        <div className="diagram-modal-overlay" onClick={onClose}>
            <div className="diagram-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '650px' }}>
                <div className="diagram-modal__header">
                    <h2>Add Tool to Library</h2>
                    <button className="diagram-modal__close" onClick={onClose}>×</button>
                </div>

                <div className="diagram-modal__content" style={{ padding: '1.5rem' }}>
                    {/* URL Input */}
                    <div className="form-section">
                        <label className="form-label">GitHub Repository URL</label>
                        <div style={{ display: 'flex', gap: '0.5rem' }}>
                            <input
                                type="text"
                                className="form-input"
                                placeholder="https://github.com/owner/repo or git@github.com:owner/repo.git"
                                value={url}
                                onChange={(e) => setUrl(e.target.value)}
                                style={{ flex: 1 }}
                            />
                            <button
                                className="btn btn--primary"
                                onClick={fetchRepoInfo}
                                disabled={loading || !url}
                            >
                                {loading ? 'Fetching...' : 'Fetch'}
                            </button>
                        </div>
                        <p className="form-hint">
                            Paste a public HTTPS URL or private SSH URL to auto-fill details
                        </p>
                    </div>

                    {error && (
                        <div className="error-banner" style={{
                            padding: '0.75rem',
                            background: 'rgba(239, 68, 68, 0.1)',
                            border: '1px solid rgba(239, 68, 68, 0.3)',
                            borderRadius: '6px',
                            color: '#ef4444',
                            marginBottom: '1rem'
                        }}>
                            {error}
                        </div>
                    )}

                    {repoInfo && (
                        <div className="repo-info" style={{
                            padding: '0.75rem',
                            background: 'rgba(34, 197, 94, 0.1)',
                            border: '1px solid rgba(34, 197, 94, 0.3)',
                            borderRadius: '6px',
                            marginBottom: '1rem',
                            fontSize: '0.85rem'
                        }}>
                            <strong>{repoInfo.full_name}</strong>
                            <span style={{ margin: '0 0.5rem', opacity: 0.5 }}>•</span>
                            <span>{repoInfo.stargazers_count} stars</span>
                            <span style={{ margin: '0 0.5rem', opacity: 0.5 }}>•</span>
                            <span>{repoInfo.language || 'Unknown'}</span>
                        </div>
                    )}

                    <form onSubmit={handleSubmit}>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                            <div className="form-section">
                                <label className="form-label">Tool ID *</label>
                                <input
                                    type="text"
                                    className="form-input"
                                    placeholder="custom.my-tool"
                                    value={formData.id}
                                    onChange={(e) => setFormData(prev => ({ ...prev, id: e.target.value }))}
                                    required
                                />
                            </div>

                            <div className="form-section">
                                <label className="form-label">Name *</label>
                                <input
                                    type="text"
                                    className="form-input"
                                    placeholder="My Custom Tool"
                                    value={formData.name}
                                    onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                                    required
                                />
                            </div>
                        </div>

                        <div className="form-section" style={{ marginTop: '1rem' }}>
                            <label className="form-label">Description</label>
                            <textarea
                                className="form-input"
                                placeholder="What does this tool do?"
                                value={formData.description}
                                onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                                rows={2}
                                style={{ resize: 'vertical' }}
                            />
                        </div>

                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginTop: '1rem' }}>
                            <div className="form-section">
                                <label className="form-label">Category</label>
                                <select
                                    className="form-input"
                                    value={formData.category}
                                    onChange={(e) => setFormData(prev => ({ ...prev, category: e.target.value }))}
                                >
                                    {categories.map(cat => (
                                        <option key={cat.id} value={cat.id}>
                                            {cat.icon} {cat.name}
                                        </option>
                                    ))}
                                </select>
                            </div>

                            <div className="form-section">
                                <label className="form-label">Subcategory</label>
                                <input
                                    type="text"
                                    className="form-input"
                                    placeholder="e.g., framework, sdk"
                                    value={formData.subcategory}
                                    onChange={(e) => setFormData(prev => ({ ...prev, subcategory: e.target.value }))}
                                />
                            </div>
                        </div>

                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem', marginTop: '1rem' }}>
                            <div className="form-section">
                                <label className="form-label">Risk Level</label>
                                <select
                                    className="form-input"
                                    value={formData.risk_level}
                                    onChange={(e) => setFormData(prev => ({ ...prev, risk_level: e.target.value }))}
                                >
                                    <option value="low">Low</option>
                                    <option value="medium">Medium</option>
                                    <option value="high">High</option>
                                </select>
                            </div>

                            <div className="form-section">
                                <label className="form-label">Sandbox Profile</label>
                                <select
                                    className="form-input"
                                    value={formData.sandbox_profile}
                                    onChange={(e) => setFormData(prev => ({ ...prev, sandbox_profile: e.target.value }))}
                                >
                                    <option value="restricted">Restricted (no network)</option>
                                    <option value="standard">Standard (egress only)</option>
                                    <option value="privileged">Privileged (full access)</option>
                                </select>
                            </div>

                            <div className="form-section">
                                <label className="form-label">Provider</label>
                                <input
                                    type="text"
                                    className="form-input"
                                    placeholder="e.g., openai"
                                    value={formData.provider}
                                    onChange={(e) => setFormData(prev => ({ ...prev, provider: e.target.value }))}
                                />
                            </div>
                        </div>

                        <div style={{ marginTop: '2rem', display: 'flex', gap: '1rem', justifyContent: 'flex-end' }}>
                            <button type="button" className="btn btn--ghost" onClick={onClose}>
                                Cancel
                            </button>
                            <button type="submit" className="btn btn--primary">
                                Add to Library
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
}


// ============================================================================
// MAIN VIEW — 4-panel fixed-height layout (STUDY-REV-2/P1.A-rebuild)
// ============================================================================

function ToolsView() {
    const { halState } = useOutletContext() || {};
    const { currentOrg } = useWorkspace();
    const { authFetch } = useAuth();
    const [searchParams, setSearchParams] = useSearchParams();
    const navigate = useNavigate();
    const location = useLocation();

    const [wizardOpen, setWizardOpen] = useState(false);

    // freshInstall banner: set when navigating back from /tools/add
    const [freshInstallCount, setFreshInstallCount] = useState(location.state?.freshInstall || null);

    // Library/Installed segmented control — ?view=library|installed
    const [view, setView] = useState(searchParams.get('view') || 'library');

    // Tab state (only active within Library view)
    const [activeTab, setActiveTab] = useState(searchParams.get('tab') || 'catalog');

    // Library state (loaded from static index)
    const [library, setLibrary] = useState(null);
    const [libraryLoading, setLibraryLoading] = useState(true);
    const [libraryError, setLibraryError] = useState(null);

    // Catalog state
    const [selectedCategory, setSelectedCategory] = useState(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedRisk, setSelectedRisk] = useState(null);

    // Parent → subcategory tree filter state — initialised from URL params for deep-link support
    const [selectedParentCategory, setSelectedParentCategory] = useState(() => {
        const p = searchParams.get('parent');
        return p || null;
    });
    const [selectedSubcategories, setSelectedSubcategories] = useState(() => {
        const sub = searchParams.get('sub');
        if (sub) {
            return new Set(sub.split(',').filter(Boolean));
        }
        return new Set();
    });
    const [expandedParents, setExpandedParents] = useState(() => {
        try {
            const stored = localStorage.getItem('tools-sidebar-expanded-parents');
            return stored ? new Set(JSON.parse(stored)) : new Set();
        } catch { return new Set(); }
    });
    const [showAllCategories, setShowAllCategories] = useState(false);

    // Modals (catalog tool detail modal — core/plugin tools still use inline modals)
    const [selectedTool, setSelectedTool] = useState(null);

    // Core tools state (fetched from collector API)
    const [coreTools, setCoreTools] = useState([]);
    const [toolAgents, setToolAgents] = useState({});
    const [coreLoading, setCoreLoading] = useState(true);
    const [selectedCoreTool, setSelectedCoreTool] = useState(null);
    const [selectedPluginTool, setSelectedPluginTool] = useState(null);

    // Local installations (in-memory only; server is source of truth via scopeInstalled / serverInstalled)
    const [installedIds, setInstalledIds] = useState(() => new Set());

    // Server-side installations from /api/orgs/:orgId/tool-library
    const [serverInstalled, setServerInstalled] = useState([]);
    const [serverInstalledLoading, setServerInstalledLoading] = useState(false);

    // P4.0.B: scope-installed tools from /api/tools/installed?scope_id=:orgId
    const [scopeInstalled, setScopeInstalled] = useState([]);
    const [scopeInstalledLoading, setScopeInstalledLoading] = useState(false);

    // D5: Executor-type filter chip — persisted to localStorage for UI state
    const [selectedExecutorType, setSelectedExecutorType] = useState(() => {
        try { return localStorage.getItem('tools-filter-executor-type') || null; } catch { return null; }
    });

    // STUDY-REV-2/P1.A-categories: API-sourced categories (replaces 3 static CATEGORY_META maps)
    const [apiCategories, setApiCategories] = useState([]);

    useEffect(() => {
        if (!currentOrg?.id) return;
        listCategories({ authFetch, orgId: currentOrg.id })
            .then(setApiCategories)
            .catch(err => console.warn('[ToolsView] Categories load failed:', err.message));
    }, [authFetch, currentOrg?.id]);

    // Build a lookup map: category id → { icon, name, color, sort_order, org_id, ... }
    const categoryById = useMemo(() => {
        const m = {};
        for (const c of apiCategories) m[c.id] = c;
        return m;
    }, [apiCategories]);

    // STUDY-REV-2/P1.A: user-registered tools (openapi/mcp) from toolDefinitionsStore
    const [userInstalledTools, setUserInstalledTools] = useState([]);
    const [showRegisterTool, setShowRegisterTool] = useState(false);

    // Catalog API tools (from auth service tool_definitions)
    const [catalogApiTools, setCatalogApiTools] = useState([]);
    const [catalogApiLoading, setCatalogApiLoading] = useState(false);

    // Installing state (track which tools are being installed)
    const [installingToolIds, setInstallingToolIds] = useState(new Set());

    // Custom tools — REMOVED (localStorage-only, violates zero-tolerance persistence rule).
    // GitHub URL install path will live in P4 Toolsmith. For allTools merge below,
    // we pass an empty array so no downstream logic breaks.
    const customTools = [];

    // Fetch core tools from collector API
    useEffect(() => {
        async function fetchCoreTools() {
            try {
                const [toolsResp, agentsResp] = await Promise.all([
                    fetch('/collector/api/v1/tools/list?agent_id=all'),
                    fetch('/collector/api/v1/tools/agents')
                ]);
                if (toolsResp.ok) {
                    const data = await toolsResp.json();
                    setCoreTools(data.tools || []);
                }
                if (agentsResp.ok) {
                    const data = await agentsResp.json();
                    setToolAgents(data.toolAgents || {});
                }
            } catch (err) {
                console.warn('Failed to fetch core tools:', err.message);
            } finally {
                setCoreLoading(false);
            }
        }
        fetchCoreTools();
    }, []);

    // STUDY-REV-2/P1.A: fetch user-registered tools (openapi/mcp) from toolDefinitionsStore
    // Pass currentOrg.id explicitly so the backend merges the right org's tools
    // (the list endpoint has no requireAuth, so it can't derive org from JWT).
    const loadUserInstalledTools = useCallback(async () => {
        if (!currentOrg?.id) {
            setUserInstalledTools([]);
            return;
        }
        try {
            const url = `/collector/api/v1/tools/list?agent_id=all&include_user=1&org_id=${encodeURIComponent(currentOrg.id)}`;
            const resp = await fetch(url);
            if (!resp.ok) return;
            const data = await resp.json();
            const userTools = (data.tools || []).filter(t => t.user_installed);
            setUserInstalledTools(userTools);
        } catch (err) {
            console.warn('[ToolsView] Failed to load user-installed tools:', err.message);
        }
    }, [currentOrg?.id]);

    useEffect(() => {
        loadUserInstalledTools();
    }, [loadUserInstalledTools]);

    // Re-fetch after navigating back from /tools/add
    useEffect(() => {
        if (location.state?.freshInstall) {
            loadUserInstalledTools();
            setActiveTab('installed');
        }
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // P4.0.B: load scope-installed tools from the new auth-side endpoint
    const loadScopeInstalled = useCallback(async () => {
        if (!currentOrg?.id) {
            setScopeInstalled([]);
            return;
        }
        setScopeInstalledLoading(true);
        try {
            const installations = await listInstalledTools({ authFetch, orgId: currentOrg.id });
            setScopeInstalled(installations);
        } catch (err) {
            console.warn('[ToolsView] Failed to load scope-installed tools:', err.message);
        } finally {
            setScopeInstalledLoading(false);
        }
    }, [currentOrg?.id, authFetch]);

    useEffect(() => {
        loadScopeInstalled();
    }, [loadScopeInstalled]);

    // Load static tool library on mount
    useEffect(() => {
        async function loadLibrary() {
            try {
                const response = await import('../../config/tool-library-index.json');
                setLibrary(response.default || response);
                setLibraryLoading(false);
            } catch (err) {
                console.error('Failed to load tool library:', err);
                setLibraryError('Failed to load tool library');
                setLibraryLoading(false);
            }
        }
        loadLibrary();
    }, []);

    // Fetch server-side installations when org is available
    // Falls back to tool catalog (definitions) if no explicit installations exist
    const loadServerInstalled = useCallback(async () => {
        if (!currentOrg?.id) return;
        setServerInstalledLoading(true);
        try {
            const response = await authFetch(`/api/orgs/${currentOrg.id}/tool-library?limit=200`);
            if (response.ok) {
                const data = await response.json();
                const items = data.items || [];
                if (items.length > 0) {
                    setServerInstalled(items);
                    return;
                }
            }
            // No explicit installations — fall back to tool catalog (built-in tools)
            const catalogRes = await authFetch('/api/catalog?limit=200&status=available');
            if (catalogRes.ok) {
                const catalogData = await catalogRes.json();
                setServerInstalled((catalogData.items || []).map(t => ({ ...t, builtin: true })));
            }
        } catch (err) {
            console.warn('Failed to load installed tools from server:', err.message);
        } finally {
            setServerInstalledLoading(false);
        }
    }, [currentOrg?.id, authFetch]);

    useEffect(() => {
        loadServerInstalled();
    }, [loadServerInstalled]);

    // Fetch catalog tools from auth service API (tool_definitions in DB)
    const loadCatalogApi = useCallback(async () => {
        setCatalogApiLoading(true);
        try {
            const response = await authFetch('/api/catalog?limit=500&status=available');
            if (response.ok) {
                const data = await response.json();
                setCatalogApiTools(data.items || []);
            }
        } catch (err) {
            console.warn('Failed to load catalog from API:', err.message);
        } finally {
            setCatalogApiLoading(false);
        }
    }, [authFetch]);

    useEffect(() => {
        loadCatalogApi();
    }, [loadCatalogApi]);

    // Build set of server-installed tool_definition IDs for "installed" badge
    const serverInstalledDefIds = useMemo(() => {
        const ids = new Set();
        for (const inst of serverInstalled) {
            if (inst.tool_definition_id) ids.add(inst.tool_definition_id);
        }
        return ids;
    }, [serverInstalled]);

    // Build map: tool_definition_id → installation record (for uninstall)
    const installationByDefId = useMemo(() => {
        const map = new Map();
        for (const inst of serverInstalled) {
            if (inst.tool_definition_id) map.set(inst.tool_definition_id, inst);
        }
        return map;
    }, [serverInstalled]);

    // Update URL when view, tab, or filter state changes
    // Uses replaceState semantics (setSearchParams replace=true) to avoid
    // polluting browser history with every checkbox toggle.
    useEffect(() => {
        const params = new URLSearchParams();
        params.set('view', view);
        params.set('tab', activeTab);
        if (selectedParentCategory) params.set('parent', selectedParentCategory);
        if (selectedSubcategories.size > 0) {
            params.set('sub', [...selectedSubcategories].join(','));
        }
        setSearchParams(params, { replace: true });
    }, [view, activeTab, selectedParentCategory, selectedSubcategories, setSearchParams]);

    // Merge static library, catalog API, custom tools, and user-imported tools
    const allTools = useMemo(() => {
        const toolMap = new Map();
        // 1. Static library tools (baseline)
        if (library?.tools) {
            library.tools.forEach(t => toolMap.set(t.id, t));
        }
        // 2. Catalog API tools (from DB — includes screencap, etc.)
        // These use tool_definition_id as their canonical ID
        catalogApiTools.forEach(t => {
            const existing = toolMap.get(t.tool_id);
            toolMap.set(t.tool_id || t.id, {
                ...(existing || {}),
                id: t.tool_id || t.id,
                tool_definition_id: t.id,
                name: t.name,
                description: t.description,
                category: t.category || 'other',
                subcategory: t.subcategory,
                risk_level: t.risk_level || 'low',
                sandbox_profile: t.sandbox_profile || 'standard',
                provider: t.provider,
                icon: t.icon,
                version: t.version,
                status: t.status,
                is_core: t.is_core,
                is_featured: t.is_featured,
                fromCatalogApi: true
            });
        });
        // 3. User-imported tools (catalog/openapi/mcp from current org's tool_definitions store).
        //    These show in the Catalog grid alongside static + DB tools so users find what they imported.
        //    Per project_global_library_per_scope_install_2026_05_06.md the long-term model is library/install split;
        //    this merge is the short-term fix until P4.0 lands.
        userInstalledTools.forEach(t => {
            const id = t.id || t.name;
            const existing = toolMap.get(id);
            toolMap.set(id, {
                ...(existing || {}),
                id,
                name: t.display_name || t.name,
                description: t.description,
                category: t.category || 'integration',
                subcategory: t.subcategory,
                risk_level: t.risk_level || 'low',
                sandbox_profile: t.sandbox_profile || 'standard',
                provider: t.provider,
                icon: t.icon,
                reference: t.reference,
                executor_type: t.executor_type,
                user_installed: true,
            });
        });
        // 4. Custom tools (user-added, override everything)
        customTools.forEach(t => toolMap.set(t.id, { ...t, custom: true }));
        return Array.from(toolMap.values());
    }, [library, catalogApiTools, userInstalledTools, customTools]);

    // Computed: categories with counts (including custom tools)
    const categories = useMemo(() => {
        const cats = {};
        allTools.forEach(t => {
            const cat = t.category;
            if (!cats[cat]) {
                const meta = categoryById[cat] || { icon: '📦', name: cat, color: '#6b7280' };
                cats[cat] = { id: cat, ...meta, count: 0 };
            }
            cats[cat].count++;
        });
        return Object.values(cats).sort((a, b) => b.count - a.count);
    }, [allTools, categoryById]);

    // Computed: filtered tools
    const filteredTools = useMemo(() => {
        let results = [...allTools];

        // New tree filter (subcategories take priority over parent, parent over legacy category)
        if (selectedSubcategories.size > 0) {
            results = results.filter(t => selectedSubcategories.has(t.subcategory));
        } else if (selectedParentCategory) {
            results = results.filter(t => t.parent_category === selectedParentCategory);
        } else if (selectedCategory) {
            // Legacy flat-list filter (escape hatch)
            results = results.filter(t => t.category === selectedCategory);
        }

        if (selectedRisk) {
            results = results.filter(t => t.risk_level === selectedRisk);
        }

        // D5: executor-type chip filter
        if (selectedExecutorType) {
            results = results.filter(t => {
                const et = t.executor_type || t.spec?.executor_type;
                if (selectedExecutorType === 'hosted') return et === 'mcp_hosted' || t.provider === 'powers';
                if (selectedExecutorType === 'endpoint') return et === 'mcp_endpoint';
                if (selectedExecutorType === 'catalog') return !t.executor_type && !t.user_installed && !t.fromCatalogApi;
                if (selectedExecutorType === 'native') return t.is_core === 1 || t.is_core === true;
                if (selectedExecutorType === 'toolsmith') return et === 'toolsmith';
                return true;
            });
        }

        if (searchQuery) {
            const q = searchQuery.toLowerCase();
            results = results.filter(t =>
                t.name.toLowerCase().includes(q) ||
                (t.description && t.description.toLowerCase().includes(q)) ||
                t.id.toLowerCase().includes(q) ||
                t.category.toLowerCase().includes(q) ||
                (t.provider && t.provider.toLowerCase().includes(q))
            );
        }

        return results;
    }, [allTools, selectedCategory, selectedParentCategory, selectedSubcategories, selectedRisk, searchQuery, selectedExecutorType]);

    // Split core tools into native (built-in) and plugin (entity-loaded)
    const nativeTools = useMemo(() => coreTools.filter(t => !t.entity), [coreTools]);
    const pluginTools = useMemo(() => coreTools.filter(t => t.entity), [coreTools]);

    // Computed: native core tools grouped by category
    const coreToolsByCategory = useMemo(() => {
        const groups = {};
        for (const tool of nativeTools) {
            const cat = tool.category || 'other';
            if (!groups[cat]) groups[cat] = [];
            groups[cat].push(tool);
        }
        // Sort categories by API sort_order (ascending)
        return Object.entries(groups).sort((a, b) => {
            const aOrder = categoryById[a[0]]?.sort_order ?? 9999;
            const bOrder = categoryById[b[0]]?.sort_order ?? 9999;
            return aOrder - bOrder;
        });
    }, [nativeTools, categoryById]);

    // Computed: plugin tools grouped by category
    const pluginToolsByCategory = useMemo(() => {
        const groups = {};
        for (const tool of pluginTools) {
            const cat = tool.category || 'other';
            if (!groups[cat]) groups[cat] = [];
            groups[cat].push(tool);
        }
        return Object.entries(groups).sort((a, b) => {
            const aOrder = categoryById[a[0]]?.sort_order ?? 9999;
            const bOrder = categoryById[b[0]]?.sort_order ?? 9999;
            return aOrder - bOrder;
        });
    }, [pluginTools, categoryById]);

    // Computed: installed tools
    const installedTools = useMemo(() => {
        return allTools.filter(t => installedIds.has(t.id));
    }, [allTools, installedIds]);

    const handleInstallTool = async (tool) => {
        if (!currentOrg?.id) return;

        // Determine the tool_definition_id for the API call
        const defId = tool.tool_definition_id || tool.id;
        if (!defId) return;

        setInstallingToolIds(prev => new Set([...prev, tool.id]));
        try {
            const response = await authFetch(`/api/orgs/${currentOrg.id}/tool-library`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tool_definition_id: defId })
            });

            if (response.ok) {
                // Also update localStorage for backwards compat
                setInstalledIds(prev => new Set([...prev, tool.id]));
                // Refresh server installations
                await loadServerInstalled();
                setSelectedTool(null);
            } else {
                const err = await response.json().catch(() => ({}));
                if (response.status === 409) {
                    // Already installed — just refresh the list
                    setInstalledIds(prev => new Set([...prev, tool.id]));
                    await loadServerInstalled();
                    setSelectedTool(null);
                } else {
                    console.error('Failed to install tool:', err.message || err.error);
                    alert(`Failed to install: ${err.message || err.error || 'Unknown error'}`);
                }
            }
        } catch (err) {
            console.error('Install tool error:', err);
            alert(`Install failed: ${err.message}`);
        } finally {
            setInstallingToolIds(prev => {
                const next = new Set(prev);
                next.delete(tool.id);
                return next;
            });
        }
    };

    const handleUninstallTool = async (tool) => {
        if (!currentOrg?.id) return;
        if (!confirm(`Uninstall ${tool.name}?`)) return;

        // Find the installation record
        const defId = tool.tool_definition_id || tool.id;
        const installation = installationByDefId.get(defId);

        if (installation) {
            try {
                const response = await authFetch(`/api/orgs/${currentOrg.id}/tool-library/${installation.id}`, {
                    method: 'DELETE'
                });
                if (!response.ok) {
                    const err = await response.json().catch(() => ({}));
                    alert(`Failed to uninstall: ${err.message || err.error || 'Unknown error'}`);
                    return;
                }
            } catch (err) {
                alert(`Uninstall failed: ${err.message}`);
                return;
            }
        }

        // Update local state
        setInstalledIds(prev => {
            const next = new Set(prev);
            next.delete(tool.id);
            return next;
        });
        await loadServerInstalled();
    };

    const clearFilters = () => {
        setSearchQuery('');
        setSelectedCategory(null);
        setSelectedRisk(null);
        setSelectedParentCategory(null);
        setSelectedSubcategories(new Set());
        setSelectedExecutorType(null);
        try { localStorage.removeItem('tools-filter-executor-type'); } catch { /* ignore */ }
    };

    // Sidebar tree handlers
    const handleParentClick = (parent) => {
        if (parent === null) {
            setSelectedParentCategory(null);
            setSelectedSubcategories(new Set());
            setSelectedCategory(null);
            return;
        }
        if (selectedParentCategory === parent && selectedSubcategories.size === 0) {
            // Toggle off
            setSelectedParentCategory(null);
        } else {
            setSelectedParentCategory(parent);
            setSelectedSubcategories(new Set());
            setSelectedCategory(null);
        }
    };

    const handleSubcategoryToggle = (subId) => {
        setSelectedSubcategories(prev => {
            const next = new Set(prev);
            if (next.has(subId)) {
                next.delete(subId);
            } else {
                next.add(subId);
            }
            return next;
        });
        // Clear parent/legacy filters when subcategory is picked
        setSelectedCategory(null);
    };

    const handleToggleExpand = (parent) => {
        setExpandedParents(prev => {
            const next = new Set(prev);
            if (next.has(parent)) {
                next.delete(parent);
            } else {
                next.add(parent);
            }
            try {
                localStorage.setItem('tools-sidebar-expanded-parents', JSON.stringify([...next]));
            } catch { /* ignore */ }
            return next;
        });
    };

    const handleLegacySelect = (catId) => {
        setSelectedCategory(catId);
        setSelectedParentCategory(null);
        setSelectedSubcategories(new Set());
    };

    // P4.0.B: Install a tool to the current org scope via the new auth endpoint
    const handleInstallToScope = async (tool) => {
        if (!currentOrg?.id) return;
        const toolId = tool.tool_id || tool.id;
        if (!toolId) return;

        setInstallingToolIds(prev => new Set([...prev, toolId]));
        try {
            await installToolToScope({ authFetch, toolId });
            await loadScopeInstalled();
            // Also keep existing serverInstalled in sync
            await loadServerInstalled();
            alert(`${tool.name} installed to scope.`);
        } catch (err) {
            console.error('[ToolsView] Install to scope failed:', err);
            alert(`Install failed: ${err.message}`);
        } finally {
            setInstallingToolIds(prev => {
                const next = new Set(prev);
                next.delete(toolId);
                return next;
            });
        }
    };

    // P4.0.B: Uninstall a tool from the current org scope via the new auth endpoint
    const handleUninstallFromScope = async (tool) => {
        if (!currentOrg?.id) return;
        const toolId = tool.tool_id || tool.id;
        if (!toolId) return;
        if (!confirm(`Uninstall ${tool.name} from scope?`)) return;

        try {
            await uninstallToolFromScope({ authFetch, toolId });
            await loadScopeInstalled();
            alert(`${tool.name} uninstalled from scope.`);
        } catch (err) {
            console.error('[ToolsView] Uninstall from scope failed:', err);
            alert(`Uninstall failed: ${err.message}`);
        }
    };

    // Export library to JSON file
    const handleExportLibrary = () => {
        if (!library) return;

        const exportData = {
            version: library.version,
            exportedAt: new Date().toISOString(),
            totalTools: library.tools.length,
            categories: library.categories,
            tools: library.tools,
            // Include installation state
            installations: {
                installedIds: [...installedIds],
                exportedFrom: window.location.hostname
            }
        };

        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `tool-library-export-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    // Export only installed tools
    const handleExportInstalled = () => {
        if (!library) return;

        const installedTools = library.tools.filter(t => installedIds.has(t.id));

        const exportData = {
            version: library.version,
            exportedAt: new Date().toISOString(),
            totalTools: installedTools.length,
            type: 'installed-only',
            tools: installedTools,
            installedIds: [...installedIds]
        };

        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `installed-tools-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    // handleAddTool REMOVED — GitHub URL custom tools were localStorage-only.
    // Remove custom tool from library (kept for any catalog custom tools)
    const handleRemoveCustomTool = (toolId) => {
        if (!confirm('Remove this custom tool from the library?')) return;
        // custom tools array is now empty (localStorage path removed), but keep
        // the installed-IDs cleanup for safety
        setInstalledIds(prev => {
            const next = new Set(prev);
            next.delete(toolId);
            return next;
        });
    };

    // Import tools from JSON file — P4.0.B: calls installToolToScope per tool instead
    // of the collector's bulk-import-catalog endpoint (which remains in place for P4 cleanup).
    // The library defs come from the static index; this rewire installs each tool_id to scope.
    const handleImportLibrary = (event) => {
        const file = event.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const importData = JSON.parse(e.target.result);

                if (!importData.tools || !Array.isArray(importData.tools)) {
                    alert('Invalid file format: missing tools array');
                    return;
                }

                // Optional: merge installedIds into local state (legacy)
                if (importData.installedIds && Array.isArray(importData.installedIds)) {
                    setInstalledIds(prev => new Set([...prev, ...importData.installedIds]));
                }

                // P4.0.B: install each tool to scope via the new auth endpoint (idempotent)
                let registered = 0;
                let skipped = 0;
                for (const tool of importData.tools) {
                    const toolId = tool.tool_id || tool.id || tool.name;
                    if (!toolId) { skipped++; continue; }
                    try {
                        await installToolToScope({ authFetch, toolId });
                        registered++;
                    } catch {
                        skipped++;
                    }
                }

                alert(`Imported ${registered} tools.${skipped ? `\nSkipped ${skipped} (not found in catalog or invalid).` : ''}`);

                // Refresh both scope and user-installed lists
                await Promise.all([loadScopeInstalled(), loadUserInstalledTools()]);

            } catch (err) {
                alert('Failed to parse JSON file: ' + err.message);
            }
        };
        reader.readAsText(file);
        event.target.value = '';
    };

    // Category counts
    const categoryCounts = useMemo(() => {
        const counts = { total: library?.tools?.length || 0 };
        categories.forEach(cat => {
            counts[cat.id] = cat.count || 0;
        });
        return counts;
    }, [categories, library]);

    // Left panel categories — computed from the current tab's tools.
    // Must be a top-level hook (before any early return).
    const panelCategories = useMemo(() => {
        let base;
        if (activeTab === 'installed') {
            const installedSet = [
                ...userInstalledTools.map(t => ({ ...t, category: t.category || 'integration' })),
                ...serverInstalled.map(t => ({ ...t, id: t.tool_id || t.id })),
                ...installedTools,
            ];
            base = installedSet;
        } else {
            base = allTools;
        }
        const cats = {};
        base.forEach(t => {
            const cat = t.category || 'other';
            if (!cats[cat]) {
                const meta = categoryById[cat] || { icon: '📦', name: cat };
                cats[cat] = { id: cat, ...meta, count: 0 };
            }
            cats[cat].count++;
        });
        return Object.values(cats).sort((a, b) => b.count - a.count);
    }, [activeTab, allTools, userInstalledTools, serverInstalled, installedTools, categoryById]);

    // Loading state
    if (libraryLoading) {
        return (
            <div className="qx-view" style={{ gap: 16 }}>
                <style>{`
                    .app-shell__content:has(.tools-view-shell) {
                        overflow: hidden;
                    }
                `}</style>
                <div className="qx-row qx-row--apart" style={{ flex: '0 0 auto', alignItems: 'center' }}>
                    <nav className="qx-tabs">
                        <span className="qx-tab qx-tab--active">Catalog</span>
                    </nav>
                </div>
                <div className="qx-row" style={{ flex: 1, minHeight: 0, gap: 16, alignItems: 'stretch' }}>
                    <aside className="qx-card" style={{ flex: '0 0 240px', minHeight: 0, padding: 20, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <div className="qx-spinner" />
                    </aside>
                    <section className="qx-card" style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <div className="qx-empty">
                            <div className="qx-spinner" />
                            <div className="qx-empty__body">Loading {library?.totalTools || 300}+ tools...</div>
                        </div>
                    </section>
                </div>
            </div>
        );
    }

    // Error state
    if (libraryError) {
        return (
            <div className="qx-view" style={{ gap: 16 }}>
                <div className="qx-row" style={{ flex: 1, minHeight: 0, gap: 16, alignItems: 'stretch' }}>
                    <section className="qx-card" style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <div className="qx-empty">
                            <div className="qx-empty__title">Failed to load library</div>
                            <div className="qx-empty__body">{libraryError}</div>
                            <button className="qx-btn qx-btn--ghost" onClick={() => window.location.reload()}>Retry</button>
                        </div>
                    </section>
                </div>
            </div>
        );
    }

    const showFilterBar = view === 'library' && (activeTab === 'catalog' || activeTab === 'installed');
    const hasActiveFilters = !!(selectedCategory || selectedParentCategory || selectedSubcategories.size > 0 || selectedRisk || searchQuery || selectedExecutorType);

    // Determine the active category label for the main panel header
    const activeCategoryMeta = selectedCategory
        ? (categoryById[selectedCategory] || { icon: '📦', name: selectedCategory })
        : { icon: '📦', name: 'All Tools' };

    const panelTotalCount = panelCategories.reduce((s, c) => s + c.count, 0);

    return (
        <div
            className="qx-view tools-view-shell"
            style={{ gap: 16, height: '100%', minHeight: 0 }}
        >
            {/* Override app-shell__content scroll so only our panels scroll. */}
            <style>{`
                .app-shell__content:has(.tools-view-shell) {
                    overflow: hidden;
                }
                @media (max-width: 899px) {
                    .quartermaster-sidebar-panel {
                        display: none !important;
                    }
                }
            `}</style>

            {/* ── TOP BAR — transparent, NO qx-card ──────────────────────────── */}
            <div className="qx-row qx-row--apart" style={{ flex: '0 0 auto', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>

                {/* Library / Installed segmented control + sub-tabs */}
                <div className="qx-row qx-row--tight" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                    {/* P4.0.B: Library / Installed seg control — ?view= */}
                    <div className="qx-seg" role="tablist">
                        <button
                            className={`qx-seg-item${view === 'library' ? ' is-active' : ''}`}
                            role="tab"
                            aria-selected={view === 'library'}
                            onClick={() => setView('library')}
                        >
                            Library
                        </button>
                        <button
                            className={`qx-seg-item${view === 'installed' ? ' is-active' : ''}`}
                            role="tab"
                            aria-selected={view === 'installed'}
                            onClick={() => setView('installed')}
                        >
                            Installed ({scopeInstalled.length})
                        </button>
                        <button
                            className={`qx-seg-item${view === 'assignments' ? ' is-active' : ''}`}
                            role="tab"
                            aria-selected={view === 'assignments'}
                            onClick={() => setView('assignments')}
                        >
                            Assignments
                        </button>
                        <button
                            className={`qx-seg-item${view === 'audit' ? ' is-active' : ''}`}
                            role="tab"
                            aria-selected={view === 'audit'}
                            onClick={() => setView('audit')}
                        >
                            Audit
                        </button>
                    </div>

                    {/* Sub-tabs — only in Library view */}
                    {view === 'library' && (
                        <nav className="qx-tabs">
                            <button
                                className={`qx-tab${activeTab === 'catalog' ? ' qx-tab--active' : ''}`}
                                onClick={() => setActiveTab('catalog')}
                            >
                                Catalog ({allTools.length})
                            </button>
                            <button
                                className={`qx-tab${activeTab === 'core' ? ' qx-tab--active' : ''}`}
                                onClick={() => setActiveTab('core')}
                            >
                                Core ({nativeTools.length})
                            </button>
                            <button
                                className={`qx-tab${activeTab === 'plugin' ? ' qx-tab--active' : ''}`}
                                onClick={() => setActiveTab('plugin')}
                            >
                                Plugin ({pluginTools.length})
                            </button>
                            <button
                                className={`qx-tab${activeTab === 'installed' ? ' qx-tab--active' : ''}`}
                                onClick={() => setActiveTab('installed')}
                            >
                                Legacy ({serverInstalled.length + userInstalledTools.length || installedIds.size})
                            </button>
                        </nav>
                    )}
                </div>

                <div className="qx-row" style={{ gap: 8 }}>
                    <button
                        className="qx-btn qx-btn--primary qx-btn--sm"
                        onClick={() => setWizardOpen(true)}
                        title="Paste an external repository URL or MCP endpoint: deploy as an agent power"
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}>
                            <path d="M4 16v4h16v-4"/>
                            <polyline points="8 12 12 8 16 12"/>
                            <line x1="12" y1="8" x2="12" y2="20"/>
                        </svg>
                        Deploy External Repository
                    </button>
                    <Link
                        to="/tools/add"
                        className="qx-btn qx-btn--ghost qx-btn--sm"
                        title="Register tools from external repo, MCP, OpenAPI, or author a script"
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}>
                            <path d="M12 5v14M5 12h14"/>
                        </svg>
                        Add Tool
                    </Link>
                    <button
                        className="qx-btn qx-btn--ghost qx-btn--sm"
                        onClick={handleExportLibrary}
                        title="Export full library with installation state"
                    >
                        Export
                    </button>
                    <label className="qx-btn qx-btn--ghost qx-btn--sm tools-view__import-label" title="Import tools from JSON">
                        Import
                        <input
                            type="file"
                            accept=".json"
                            onChange={handleImportLibrary}
                            style={{ display: 'none' }}
                        />
                    </label>
                </div>
            </div>

            {/* ── FILTER BAR — transparent, NO qx-card (Catalog + Installed only) */}
            {showFilterBar && (
                <div className="qx-row" style={{ flex: '0 0 auto', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                    <input
                        type="search"
                        className="qx-input"
                        aria-label="Search tools"
                        placeholder="Search tools…"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        style={{ width: 360, flex: '0 0 360px' }}
                    />
                    <select
                        value={selectedRisk || ''}
                        onChange={(e) => setSelectedRisk(e.target.value || null)}
                        className="qx-select"
                        style={{ width: 140, flex: '0 0 140px' }}
                    >
                        <option value="">All Risk</option>
                        <option value="low">Low</option>
                        <option value="medium">Medium</option>
                        <option value="high">High</option>
                    </select>
                </div>
            )}

            {/* ── D5: EXECUTOR TYPE CHIP FILTER ──────────────────────────────── */}
            {showFilterBar && (
                <div className="qx-row" style={{ flex: '0 0 auto', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    {[
                        { id: null, label: 'All' },
                        { id: 'endpoint', label: 'Endpoint' },
                        { id: 'hosted', label: 'Hosted' },
                        { id: 'catalog', label: 'Catalog' },
                        { id: 'native', label: 'Native' },
                        { id: 'toolsmith', label: 'Toolsmith' },
                    ].map(chip => (
                        <button
                            key={chip.id || 'all'}
                            className={`qx-chip${selectedExecutorType === chip.id ? ' qx-chip--active' : ''}`}
                            onClick={() => {
                                setSelectedExecutorType(chip.id);
                                try {
                                    if (chip.id) localStorage.setItem('tools-filter-executor-type', chip.id);
                                    else localStorage.removeItem('tools-filter-executor-type');
                                } catch { /* ignore */ }
                            }}
                            style={{ fontSize: '0.75rem', padding: '3px 10px' }}
                        >
                            {chip.label}
                        </button>
                    ))}
                </div>
            )}

            {/* ── ACTIVE FILTERS — transparent, only when set ─────────────────── */}
            {hasActiveFilters && (
                <div className="qx-row" style={{ flex: '0 0 auto', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span className="tools-view__filter-label">Filters:</span>
                    {selectedParentCategory && selectedSubcategories.size === 0 && (
                        <button className="qx-chip qx-chip--active" onClick={() => setSelectedParentCategory(null)}>
                            {PARENT_ICONS[selectedParentCategory] || '📁'} {selectedParentCategory} ×
                        </button>
                    )}
                    {[...selectedSubcategories].map(sub => (
                        <button key={sub} className="qx-chip qx-chip--active" onClick={() => handleSubcategoryToggle(sub)}>
                            {prettyLabel(sub)} ×
                        </button>
                    ))}
                    {selectedCategory && !selectedParentCategory && selectedSubcategories.size === 0 && (
                        <button className="qx-chip qx-chip--active" onClick={() => setSelectedCategory(null)}>
                            {categoryById[selectedCategory]?.icon || '📦'} {selectedCategory} ×
                        </button>
                    )}
                    {selectedRisk && (
                        <button className="qx-chip qx-chip--active" onClick={() => setSelectedRisk(null)}>
                            Risk: {selectedRisk} ×
                        </button>
                    )}
                    {searchQuery && (
                        <button className="qx-chip qx-chip--active" onClick={() => setSearchQuery('')}>
                            "{searchQuery}" ×
                        </button>
                    )}
                    {selectedExecutorType && (
                        <button className="qx-chip qx-chip--active" onClick={() => {
                            setSelectedExecutorType(null);
                            try { localStorage.removeItem('tools-filter-executor-type'); } catch { /* ignore */ }
                        }}>
                            Type: {selectedExecutorType} ×
                        </button>
                    )}
                    <button className="qx-btn qx-btn--ghost qx-btn--sm" onClick={clearFilters}>Clear all</button>
                </div>
            )}

            {/* ── BODY — P4.0.B: Installed view OR Library two-panel layout ─────── */}

            {/* ── INSTALLED VIEW — scope-installed tools from /api/tools/installed ── */}
            {view === 'installed' && (
                <div className="qx-row" style={{ flex: 1, minHeight: 0, gap: 16, alignItems: 'stretch' }}>
                    <section className="qx-card" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20 }}>
                        {scopeInstalledLoading ? (
                            <div className="qx-empty">
                                <div className="qx-spinner" />
                                <div className="qx-empty__body">Loading installed tools...</div>
                            </div>
                        ) : scopeInstalled.length === 0 ? (
                            <div className="qx-empty">
                                <div className="qx-empty__title">No tools installed to scope</div>
                                <div className="qx-empty__body">
                                    Switch to Library and click <strong>Install to Scope</strong> on any catalog tool.
                                </div>
                                <button className="qx-btn qx-btn--ghost" onClick={() => setView('library')}>
                                    Browse Library
                                </button>
                            </div>
                        ) : (
                            <div>
                                <div className="qx-section-title" style={{ marginBottom: 16 }}>
                                    {scopeInstalled.length} tool{scopeInstalled.length !== 1 ? 's' : ''} installed to this org scope
                                </div>
                                <div className="qx-grid-3">
                                    {scopeInstalled.map(inst => {
                                        const toolData = {
                                            id: inst.tool_id || inst.id,
                                            tool_id: inst.tool_id || inst.id,
                                            name: inst.name || inst.tool_id || inst.id,
                                            description: inst.description || '',
                                            category: inst.category || 'other',
                                            risk_level: inst.risk_level,
                                            provider: inst.provider,
                                        };
                                        return (
                                            <div key={inst.id || inst.tool_id} className="qx-card tool-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
                                                <div className="tool-card__row1">
                                                    <span className="tool-card__icon">
                                                        {categoryById[toolData.category]?.icon || '🔧'}
                                                    </span>
                                                    <span className="tool-card__name">{toolData.name}</span>
                                                    <span className="qx-pill qx-pill--sm qx-pill--success tool-card__status">
                                                        Installed
                                                    </span>
                                                </div>
                                                {toolData.description && (
                                                    <p className="tool-card__desc">{toolData.description}</p>
                                                )}
                                                <div className="qx-row qx-row--tight" style={{ marginTop: 'auto' }}>
                                                    <button
                                                        className="qx-btn qx-btn--ghost qx-btn--sm"
                                                        onClick={() => handleUninstallFromScope(toolData)}
                                                    >
                                                        Uninstall
                                                    </button>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                    </section>
                </div>
            )}

            {/* ── ASSIGNMENTS VIEW — Agent × Tool matrix (P4.C) ────────────── */}
            {view === 'assignments' && (
                <AgentToolMatrix scopeInstalled={scopeInstalled} />
            )}

            {/* ── AUDIT VIEW — Tool status table (P4.D) ────────────────────── */}
            {view === 'audit' && (
                <ToolAuditTable />
            )}

            {/* ── LIBRARY BODY — two sibling qx-cards (left: categories, main: tool grid) */}
            {view === 'library' && (
            <div className="qx-row" style={{ flex: 1, minHeight: 0, gap: 16, alignItems: 'stretch' }}>

                {/* LEFT PANEL — Categories. Fixed 240px. Internal scroll. */}
                <aside className="qx-card" style={{ flex: '0 0 240px', minHeight: 0, padding: 0, display: 'flex', flexDirection: 'column' }}>
                    <div className="qx-section-title" style={{ padding: '16px 20px 8px', flex: '0 0 auto' }}>
                        Filter by Category
                    </div>
                    <CategorySidebar
                        tools={activeTab === 'installed' ? [
                            ...userInstalledTools.map(t => ({ ...t, category: t.category || 'integration' })),
                            ...serverInstalled.map(t => ({ ...t, id: t.tool_id || t.id })),
                            ...installedTools,
                        ] : allTools}
                        selectedParentCategory={selectedParentCategory}
                        selectedSubcategories={selectedSubcategories}
                        expandedParents={expandedParents}
                        onParentClick={handleParentClick}
                        onSubcategoryToggle={handleSubcategoryToggle}
                        onToggleExpand={handleToggleExpand}
                        showAllCategories={showAllCategories}
                        onToggleShowAll={() => setShowAllCategories(v => !v)}
                        panelCategories={panelCategories}
                        selectedCategory={selectedCategory}
                        onLegacySelect={handleLegacySelect}
                        panelTotalCount={panelTotalCount}
                        showFilterBar={showFilterBar}
                    />
                </aside>

                {/* MAIN PANEL — Tool grid. flex: 1, internal scroll. */}
                <section className="qx-card" style={{ flex: 1, minHeight: 0, padding: 0, display: 'flex', flexDirection: 'column' }}>
                    <div className="qx-row qx-row--apart" style={{ padding: '16px 20px 0', flex: '0 0 auto', alignItems: 'center' }}>
                        <div className="qx-section-title">
                            {activeCategoryMeta.icon} {activeCategoryMeta.name}
                            {showFilterBar && (
                                <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 400, opacity: 0.6 }}>
                                    ({filteredTools.length} tools)
                                </span>
                            )}
                        </div>
                    </div>

                    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20 }}>

                        {/* Fresh install success banner */}
                        {freshInstallCount != null && (
                            <div className="qx-banner qx-banner--success" style={{ marginBottom: 16 }}>
                                {freshInstallCount} tool{freshInstallCount !== 1 ? 's' : ''} registered successfully.
                                <button className="qx-btn qx-btn--ghost qx-btn--sm" style={{ marginLeft: 12 }} onClick={() => setFreshInstallCount(null)}>Dismiss</button>
                            </div>
                        )}

                        {/* ── Catalog Tab ── */}
                        {activeTab === 'catalog' && (
                            filteredTools.length === 0 ? (
                                <div className="qx-empty">
                                    <div className="qx-empty__icon">
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                                    </div>
                                    <div className="qx-empty__title">No tools found</div>
                                    <div className="qx-empty__body">Try adjusting your filters or search query</div>
                                    <button className="qx-btn qx-btn--ghost" onClick={clearFilters}>Clear filters</button>
                                </div>
                            ) : (
                                <div className="qx-grid-3 catalog-grid-auto">
                                    {filteredTools.map(tool => {
                                        const isInstalled = installedIds.has(tool.id) ||
                                            (tool.tool_definition_id && serverInstalledDefIds.has(tool.tool_definition_id));
                                        const isScopeInstalled = scopeInstalled.some(
                                            i => (i.tool_id || i.id) === (tool.tool_id || tool.id)
                                        );
                                        const isInstalling = installingToolIds.has(tool.tool_id || tool.id);
                                        // TRUST-GATE-1.7: only tools already backed by a real
                                        // tool_definitions row (or deployable via the POWERS wizard)
                                        // can actually be installed to scope. Everything else is
                                        // discovery-only — no live-looking button that silently 404s.
                                        // (TOOLS-FINISH T2: the http_api / public-api reference
                                        // entries that had no executor and no deploy path were removed
                                        // from the catalog outright rather than kept as dead CTAs.)
                                        const actionable = isCatalogEntryActionable(tool);
                                        const inertReason = catalogInertReason(tool);
                                        // TOOLS-FINISH T1: mcp_hosted / mcp_endpoint catalog entries
                                        // with no real tool_definitions row yet have no install-to-scope
                                        // target — install-to-scope 404s against them. Route those to
                                        // the existing DeployPowerWizard (via /tools/add?type=external-repo)
                                        // seeded with this entry's reference URL, same path ToolDetailView
                                        // already uses. Once POWERS deploys it, the entry gets a real
                                        // tool_definition_id/fromCatalogApi flag and falls through to the
                                        // normal Install to Scope branch below.
                                        const hasRealRow = !!(tool.fromCatalogApi || tool.tool_definition_id || tool.user_installed);
                                        const deployableViaPowers = isCatalogToolDeployable(tool) && !hasRealRow;
                                        return (
                                            <div key={tool.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                                <ToolCard
                                                    tool={tool}
                                                    categoryMeta={categoryById[tool.category]}
                                                    isInstalled={isInstalled || isScopeInstalled}
                                                    isDeployable={isCatalogToolDeployable(tool)}
                                                    notYetAvailable={!actionable}
                                                    onClick={() => navigate(`/tools/${encodeURIComponent(tool.id || tool.name)}`)}
                                                />
                                                {deployableViaPowers ? (
                                                    <button
                                                        className="qx-btn qx-btn--sm qx-btn--primary"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            navigate(`/tools/add?type=external-repo&prefill=${encodeURIComponent(tool.reference)}`);
                                                        }}
                                                        title="Deploy this MCP server as a Power via the deploy wizard"
                                                    >
                                                        Deploy as Power
                                                    </button>
                                                ) : actionable ? (
                                                    /* P4.0.B: Install to Scope action */
                                                    <button
                                                        className={`qx-btn qx-btn--sm${isScopeInstalled ? '' : ' qx-btn--primary'}`}
                                                        disabled={isInstalling || isScopeInstalled}
                                                        onClick={(e) => { e.stopPropagation(); handleInstallToScope(tool); }}
                                                        title={isScopeInstalled ? 'Already installed to scope' : 'Install to your org scope'}
                                                    >
                                                        {isInstalling ? 'Installing…' : isScopeInstalled ? 'Installed' : 'Install to Scope'}
                                                    </button>
                                                ) : (
                                                    <button
                                                        className="qx-btn qx-btn--sm qx-btn--ghost"
                                                        disabled
                                                        title={inertReason}
                                                    >
                                                        Not yet available
                                                    </button>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            )
                        )}

                        {/* ── Core Tab ── */}
                        {activeTab === 'core' && (
                            coreLoading ? (
                                <div className="qx-empty">
                                    <div className="qx-spinner" />
                                    <div className="qx-empty__body">Loading core tools...</div>
                                </div>
                            ) : coreTools.length === 0 ? (
                                <div className="qx-empty">
                                    <div className="qx-empty__title">No core tools available</div>
                                    <div className="qx-empty__body">Core tools are provided by the collector service. Ensure it is running.</div>
                                </div>
                            ) : (
                                <div>
                                    <p className="tools-view__desc" style={{ marginBottom: 16 }}>
                                        {nativeTools.length} native tools built into QuoxCORE. Executed via the collector and SSH bastion.
                                    </p>
                                    {coreToolsByCategory.map(([category, tools]) => {
                                        const catMeta = categoryById[category] || _CAT_FALLBACK;
                                        return (
                                            <div key={category} style={{ marginBottom: 24 }}>
                                                <div className="qx-row qx-row--tight tools-view__cat-header" style={{ marginBottom: 12 }}>
                                                    <span>{catMeta.icon}</span>
                                                    <span className="tools-view__cat-name" style={{ color: catMeta.color }}>{catMeta.name}</span>
                                                    <span className="tools-view__cat-count">({tools.length})</span>
                                                </div>
                                                <div className="qx-grid-3">
                                                    {tools.map(tool => (
                                                        <ToolCard
                                                            key={tool.name}
                                                            tool={{ ...tool, id: tool.name }}
                                                            categoryMeta={categoryById[tool.category]}
                                                            isInstalled={true}
                                                            onClick={() => setSelectedCoreTool(tool)}
                                                        />
                                                    ))}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )
                        )}

                        {/* ── Plugin Tab ── */}
                        {activeTab === 'plugin' && (
                            coreLoading ? (
                                <div className="qx-empty">
                                    <div className="qx-spinner" />
                                    <div className="qx-empty__body">Loading plugin tools...</div>
                                </div>
                            ) : pluginTools.length === 0 ? (
                                <div className="qx-empty">
                                    <div className="qx-empty__title">No plugin tools loaded</div>
                                    <div className="qx-empty__body">Plugin tools are loaded from entity definitions. Check entity tool configuration in the collector.</div>
                                </div>
                            ) : (
                                <div>
                                    <p className="tools-view__desc" style={{ marginBottom: 16 }}>
                                        {pluginTools.length} tools loaded from entity definitions. These extend QuoxCORE with domain-specific capabilities.
                                    </p>
                                    {pluginToolsByCategory.map(([category, tools]) => {
                                        const catMeta = categoryById[category] || _CAT_FALLBACK;
                                        return (
                                            <div key={category} style={{ marginBottom: 24 }}>
                                                <div className="qx-row qx-row--tight tools-view__cat-header" style={{ marginBottom: 12 }}>
                                                    <span>{catMeta.icon}</span>
                                                    <span className="tools-view__cat-name" style={{ color: catMeta.color }}>{catMeta.name}</span>
                                                    <span className="tools-view__cat-count">({tools.length})</span>
                                                </div>
                                                <div className="qx-grid-3">
                                                    {tools.map(tool => (
                                                        <ToolCard
                                                            key={tool.name}
                                                            tool={{ ...tool, id: tool.name }}
                                                            categoryMeta={categoryById[tool.category]}
                                                            isInstalled={false}
                                                            onClick={() => setSelectedPluginTool(tool)}
                                                        />
                                                    ))}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )
                        )}

                        {/* ── Installed Tab ── */}
                        {activeTab === 'installed' && (
                            serverInstalledLoading ? (
                                <div className="qx-empty">
                                    <div className="qx-spinner" />
                                    <div className="qx-empty__body">Loading installed tools...</div>
                                </div>
                            ) : (serverInstalled.length > 0 || userInstalledTools.length > 0 || installedTools.length > 0) ? (
                                <div>
                                    {/* User-registered tools (OpenAPI/MCP) */}
                                    {userInstalledTools.length > 0 && (
                                        <div style={{ marginBottom: 24 }}>
                                            <div className="qx-section-title" style={{ marginBottom: 12 }}>
                                                Registered via OpenAPI / MCP ({userInstalledTools.length})
                                            </div>
                                            <div className="qx-grid-3">
                                                {userInstalledTools.map(tool => {
                                                    const toolData = {
                                                        id: tool.name,
                                                        name: tool.name,
                                                        description: tool.description,
                                                        category: tool.category || 'integration',
                                                        risk_level: 'low',
                                                        executor_type: tool.executor_type,
                                                        user_installed: true,
                                                    };
                                                    return (
                                                        <ToolCard
                                                            key={tool.name}
                                                            tool={toolData}
                                                            categoryMeta={categoryById[toolData.category]}
                                                            isInstalled={true}
                                                            onClick={() => navigate(`/tools/${encodeURIComponent(toolData.id)}`)}
                                                        />
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    )}

                                    {/* Org tool-library installations */}
                                    {serverInstalled.length > 0 && (
                                        <div style={{ marginBottom: 24 }}>
                                            {userInstalledTools.length > 0 && (
                                                <div className="qx-section-title" style={{ marginBottom: 12 }}>
                                                    Org Catalog Installations ({serverInstalled.length})
                                                </div>
                                            )}
                                            <div className="qx-grid-3">
                                                {serverInstalled.map(inst => {
                                                    const toolData = {
                                                        id: inst.tool_id || inst.id,
                                                        tool_definition_id: inst.tool_definition_id || inst.id,
                                                        name: inst.name,
                                                        description: inst.description,
                                                        category: inst.category,
                                                        risk_level: inst.risk_level,
                                                        provider: inst.provider,
                                                    };
                                                    return (
                                                        <ToolCard
                                                            key={inst.id}
                                                            tool={toolData}
                                                            categoryMeta={categoryById[toolData.category]}
                                                            isInstalled={true}
                                                            onClick={() => navigate(`/tools/${encodeURIComponent(toolData.id)}`)}
                                                        />
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    )}

                                    {/* localStorage / catalog installed fallback */}
                                    {installedTools.length > 0 && serverInstalled.length === 0 && userInstalledTools.length === 0 && (
                                        <div className="qx-grid-3">
                                            {installedTools.map(tool => (
                                                <ToolCard
                                                    key={tool.id}
                                                    tool={tool}
                                                    categoryMeta={categoryById[tool.category]}
                                                    isInstalled={true}
                                                    onClick={() => navigate(`/tools/${encodeURIComponent(tool.id)}`)}
                                                />
                                            ))}
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <div className="qx-empty">
                                    <div className="qx-empty__title">No tools installed</div>
                                    <div className="qx-empty__body">
                                        Use the + Add Tool button to register an OpenAPI spec or MCP server,
                                        or browse the catalog to install built-in tools.
                                    </div>
                                    <div className="qx-row qx-row--center qx-row--tight">
                                        <Link to="/tools/add" className="qx-btn qx-btn--primary">+ Add Tool</Link>
                                        <button className="qx-btn qx-btn--ghost" onClick={() => setActiveTab('catalog')}>Browse Catalog</button>
                                    </div>
                                </div>
                            )
                        )}

                    </div>
                </section>

                {/* QUARTERMASTER SIDEBAR — right panel, 360px, hidden on mobile */}
                <aside
                    className="qx-card quartermaster-sidebar-panel"
                    style={{
                        flex: '0 0 360px',
                        minHeight: 0,
                        height: '100%',
                        padding: 0,
                        display: 'flex',
                        flexDirection: 'column',
                        overflow: 'hidden',
                    }}
                >
                    <QuartermasterSidebar mode="library" />
                </aside>

            </div>
            )} {/* end view === 'library' */}

            {/* Core Tool Detail Modal (inline — keep for Core tab) */}
            {selectedCoreTool && (
                <CoreToolDetailModal
                    tool={selectedCoreTool}
                    agents={toolAgents[selectedCoreTool.name] || []}
                    onClose={() => setSelectedCoreTool(null)}
                    categoryById={categoryById}
                />
            )}

            {/* Plugin Tool Detail Modal (inline — keep for Plugin tab) */}
            {selectedPluginTool && (
                <PluginToolDetailModal
                    tool={selectedPluginTool}
                    agents={toolAgents[selectedPluginTool.name] || []}
                    onClose={() => setSelectedPluginTool(null)}
                    categoryById={categoryById}
                />
            )}

            {/* Catalog Tool Detail Modal (inline fallback) */}
            {selectedTool && (
                <ToolDetailModal
                    tool={selectedTool}
                    onClose={() => setSelectedTool(null)}
                    onInstall={() => handleInstallTool(selectedTool)}
                    installed={installedIds.has(selectedTool.id) ||
                        (selectedTool.tool_definition_id && serverInstalledDefIds.has(selectedTool.tool_definition_id))}
                    categoryById={categoryById}
                />
            )}

            {/* Register OpenAPI / MCP tool modal */}
            {showRegisterTool && (
                <RegisterToolModal
                    onClose={() => setShowRegisterTool(false)}
                    onSuccess={() => {
                        setShowRegisterTool(false);
                        loadUserInstalledTools();
                        setActiveTab('installed');
                    }}
                />
            )}

            {/* Deploy External Repository wizard */}
            {wizardOpen && (
                <DeployPowerWizard
                    orgId={currentOrg?.id}
                    onClose={() => setWizardOpen(false)}
                    onDeployed={() => {
                        setWizardOpen(false);
                        navigate('/agents');
                    }}
                />
            )}

        </div>
    );
}

export default ToolsView;
