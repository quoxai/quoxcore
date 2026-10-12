/**
 * WorkflowLibraryView - Workflow Library Plugin
 *
 * Browse 1,300+ workflow templates converted to QuoxFlow format.
 * Search by integration, category, tags, or natural language.
 *
 * Features:
 * - Category-based browsing
 * - Integration filtering (Telegram, Slack, OpenAI, etc.)
 * - Tag-based search
 * - Click card to open full-screen workflow viewer with WireMap diagram
 * - Deploy workflow to QuoxFlow
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useOutletContext, useNavigate, useSearchParams } from 'react-router-dom';
import { useHubActions } from './WorkflowsHubView';
import { useAuth } from '../../contexts/AuthContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { WireMap } from '../../components/workflow';
import { CollectionImporter } from '../../components/workflow/CollectionImporter';
import { loadWorkflowJson } from '../../services/workflowLoader';
import { createWorkflow } from '../../services/workflowEngine';
import { listUserLibrary, saveToUserLibrary, deleteFromUserLibrary } from '../../services/userLibraryClient';
import './views.css';

// Simple SVG Icon Components
const Icons = {
    search: () => (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
        </svg>
    ),
    filter: () => (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polygon points="22,3 2,3 10,12.46 10,19 14,21 14,12.46"/>
        </svg>
    ),
    grid: () => (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
            <rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
        </svg>
    ),
    list: () => (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/>
            <line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/>
            <line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
        </svg>
    ),
    x: () => (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
    ),
    copy: () => (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>
    ),
    check: () => (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="20 6 9 17 4 12"/>
        </svg>
    ),
    box: () => (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
        </svg>
    ),
    diagram: () => (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/>
            <circle cx="18" cy="18" r="3"/><line x1="9" y1="6" x2="15" y2="6"/><line x1="6" y1="9" x2="6" y2="15"/>
            <line x1="18" y1="9" x2="18" y2="15"/><line x1="9" y1="18" x2="15" y2="18"/>
        </svg>
    ),
    arrowLeft: () => (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
        </svg>
    ),
    externalLink: () => (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
            <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
        </svg>
    ),
    template: () => (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
            <line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/>
        </svg>
    ),
    save: () => (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
            <polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>
        </svg>
    ),
    trash: () => (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>
            <path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
        </svg>
    ),
    deploy: () => (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/>
        </svg>
    ),
    upload: () => (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
    ),
};

// Category emoji/icon mapping (simpler approach)
const CATEGORY_ICONS = {
    'monitoring': '\u{1F4CA}',
    'automation': '\u26A1',
    'integration': '\u{1F517}',
    'notification': '\u{1F514}',
    'data-processing': '\u{1F5C4}\uFE0F',
    'ai-llm': '\u{1F9E0}',
    'security': '\u{1F6E1}\uFE0F',
    'devops': '\u{1F527}',
    'communication': '\u{1F4AC}',
    'productivity': '\u{1F4C1}',
    'other': '\u{1F4E6}'
};

// Render category icon helper
const CategoryIcon = ({ category }) => (
    <span className="category-emoji">{CATEGORY_ICONS[category] || '\u{1F4E6}'}</span>
);

// Category colors
const CATEGORY_COLORS = {
    'monitoring': '#10b981',
    'automation': '#f59e0b',
    'integration': '#6366f1',
    'notification': '#ef4444',
    'data-processing': '#8b5cf6',
    'ai-llm': '#ec4899',
    'security': '#3b82f6',
    'devops': '#14b8a6',
    'communication': '#06b6d4',
    'productivity': '#84cc16',
    'other': '#6b7280'
};

// Source filter options
const SOURCE_FILTERS = [
    { id: 'all', label: 'All' },
    { id: 'curated', label: 'Curated' },
    { id: 'n8n-imported', label: 'Extended Library' },
    { id: 'mine', label: 'My Library' },
];

function WorkflowLibraryView({ embedded = false }) {
    const outletCtx = useOutletContext() || {};
    const setHubActions = useHubActions();
    // When embedded inside WorkflowsHubView, route actions to the tab-row slot
    // instead of the breadcrumb (where they were cramped).
    const setPageActions = embedded ? setHubActions : outletCtx.setPageActions;
    const navigate = useNavigate();
    const [searchParams, setSearchParams] = useSearchParams();
    const { authFetch } = useAuth();
    const { currentOrg } = useWorkspace();

    // State
    const [library, setLibrary] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    const [searchQuery, setSearchQuery] = useState('');
    const [selectedCategory, setSelectedCategory] = useState(null);
    const [selectedIntegrations, setSelectedIntegrations] = useState([]);
    const [selectedTags, setSelectedTags] = useState([]);
    const [viewMode, setViewMode] = useState('grid'); // grid or list

    const [showFilters, setShowFilters] = useState(true);
    const [copiedId, setCopiedId] = useState(null);

    // Source filter — persisted in URL ?source=
    const sourceFilter = searchParams.get('source') || 'all';

    // n8n legacy toggle (off by default — hides n8n-imported + category=other rows)
    const [showLegacyN8n, setShowLegacyN8n] = useState(false);

    // My Library state
    const [myLibraryEntries, setMyLibraryEntries] = useState([]);
    const [myLibraryLoading, setMyLibraryLoading] = useState(false);
    const [myLibraryError, setMyLibraryError] = useState(null);

    // Save-to-library modal state
    const [saveModalWorkflow, setSaveModalWorkflow] = useState(null); // workflow being saved
    const [saveName, setSaveName] = useState('');
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState(null);
    const [saveSuccess, setSaveSuccess] = useState(null); // name of last saved workflow

    // Import modal state
    const [showImportModal, setShowImportModal] = useState(false);
    const [importSummary, setImportSummary] = useState(null); // { succeeded, failed, failedNames }
    const [importing, setImporting] = useState(false);

    // Full-screen viewer state
    const [viewerWorkflow, setViewerWorkflow] = useState(null);
    const [viewerWorkflowJson, setViewerWorkflowJson] = useState(null);
    const [loadingViewer, setLoadingViewer] = useState(false);

    // Deploy states
    const [deploying, setDeploying] = useState(false);
    const [deployStatus, setDeployStatus] = useState(null); // { success, message, workflowId }

    // Load library
    useEffect(() => {
        async function loadLibrary() {
            try {
                const response = await import('../../config/workflow-library-index.json');
                setLibrary(response.default || response);
                setLoading(false);
            } catch (err) {
                setError('Failed to load workflow library');
                setLoading(false);
            }
        }
        loadLibrary();
    }, []);

    // Load My Library when source=mine
    useEffect(() => {
        if (sourceFilter !== 'mine' || !authFetch || !currentOrg?.id) return;
        setMyLibraryLoading(true);
        setMyLibraryError(null);
        listUserLibrary({ authFetch, orgId: currentOrg.id })
            .then(entries => {
                setMyLibraryEntries(entries);
                setMyLibraryLoading(false);
            })
            .catch(err => {
                setMyLibraryError(err.message || 'Failed to load your library');
                setMyLibraryLoading(false);
            });
    }, [sourceFilter, authFetch, currentOrg?.id]);

    useEffect(() => {
        setPageActions?.(
            <div className="header-actions">
                <button
                    className="qx-btn qx-btn--ghost qx-btn--sm"
                    onClick={() => setShowImportModal(true)}
                    title="Import n8n workflows from ZIP or JSON files"
                >
                    <Icons.upload />
                    <span>Import n8n</span>
                </button>
                <button
                    className="qx-btn qx-btn--sm"
                    onClick={() => navigate('/workflow-builder')}
                >
                    Build Custom Workflow
                </button>
                <button
                    className="qx-btn qx-btn--primary qx-btn--sm"
                    onClick={() => navigate('/workflows')}
                >
                    My Workflows
                </button>
            </div>
        );
        return () => setPageActions?.(null);
    }, [setPageActions, navigate]);

    // Computed: categories with counts
    const categories = useMemo(() => {
        if (!library) return [];
        const cats = {};
        library.workflows.forEach(w => {
            const cat = w.identity.category;
            if (!cats[cat]) {
                cats[cat] = {
                    id: cat,
                    name: cat.charAt(0).toUpperCase() + cat.slice(1).replace(/-/g, ' '),
                    count: 0,
                    color: CATEGORY_COLORS[cat] || '#6b7280'
                };
            }
            cats[cat].count++;
        });
        return Object.values(cats).sort((a, b) => b.count - a.count);
    }, [library]);

    // Computed: integrations with counts
    const integrations = useMemo(() => {
        if (!library) return [];
        const ints = {};
        library.workflows.forEach(w => {
            (w.capabilities?.integrations || []).forEach(i => {
                if (!ints[i]) {
                    ints[i] = { name: i, count: 0 };
                }
                ints[i].count++;
            });
        });
        return Object.values(ints).sort((a, b) => b.count - a.count).slice(0, 20);
    }, [library]);

    // Computed: popular tags
    const popularTags = useMemo(() => {
        if (!library) return [];
        const tags = {};
        library.workflows.forEach(w => {
            (w.identity?.tags || []).forEach(t => {
                if (!tags[t]) {
                    tags[t] = { name: t, count: 0 };
                }
                tags[t].count++;
            });
        });
        return Object.values(tags).sort((a, b) => b.count - a.count).slice(0, 15);
    }, [library]);

    // Computed: filtered workflows (curated static library)
    const filteredWorkflows = useMemo(() => {
        if (!library) return [];

        let results = [...library.workflows];

        // Source filter — uses source field ('quox-curated' | 'n8n-imported')
        // Falls back to category heuristic for entries without a source field (legacy)
        if (sourceFilter === 'curated') {
            results = results.filter(w => w.source === 'quox-curated' || (w.source == null && w.identity.category !== 'other'));
        } else if (sourceFilter === 'n8n-imported') {
            results = results.filter(w => w.source === 'n8n-imported' || (w.source == null && w.identity.category === 'other'));
        } else if (sourceFilter === 'mine') {
            // My Library renders separately from myLibraryEntries
            return [];
        } else {
            // sourceFilter === 'all': hide n8n-imported unless toggle is on
            if (!showLegacyN8n) {
                results = results.filter(w => w.source === 'quox-curated' || (w.source == null && w.identity.category !== 'other'));
            }
        }

        // Category filter
        if (selectedCategory) {
            results = results.filter(w => w.identity.category === selectedCategory);
        }

        // Integration filter
        if (selectedIntegrations.length > 0) {
            results = results.filter(w =>
                selectedIntegrations.some(i => w.capabilities?.integrations?.includes(i))
            );
        }

        // Tag filter
        if (selectedTags.length > 0) {
            results = results.filter(w =>
                selectedTags.some(t => w.identity?.tags?.includes(t))
            );
        }

        // Search query
        if (searchQuery) {
            const q = searchQuery.toLowerCase();
            results = results.filter(w =>
                w.identity.name.toLowerCase().includes(q) ||
                w.identity.description.toLowerCase().includes(q) ||
                w.identity.tags?.some(t => t.includes(q)) ||
                w.capabilities?.integrations?.some(i => i.includes(q))
            );
        }

        return results;
    }, [library, selectedCategory, selectedIntegrations, selectedTags, searchQuery, sourceFilter, showLegacyN8n]);

    // Source filter change
    const setSourceFilter = useCallback((source) => {
        setSearchParams(prev => {
            const next = new URLSearchParams(prev);
            if (source === 'all') {
                next.delete('source');
            } else {
                next.set('source', source);
            }
            return next;
        });
    }, [setSearchParams]);

    // Open save-to-library modal
    const openSaveModal = useCallback((workflow) => {
        setSaveModalWorkflow(workflow);
        setSaveName(workflow.identity?.name || '');
        setSaveError(null);
    }, []);

    // Confirm save to library
    const confirmSave = useCallback(async () => {
        if (!saveModalWorkflow || !currentOrg?.id || !authFetch) return;
        setSaving(true);
        setSaveError(null);
        try {
            // Load the definition JSON if not already available
            let definitionJson = {};
            if (saveModalWorkflow.workflowFile) {
                try {
                    definitionJson = await loadWorkflowJson(saveModalWorkflow.workflowFile);
                } catch (_) {
                    definitionJson = { id: saveModalWorkflow.id, name: saveModalWorkflow.identity?.name };
                }
            }
            await saveToUserLibrary({
                authFetch,
                orgId: currentOrg.id,
                name: saveName.trim(),
                description: saveModalWorkflow.identity?.description || '',
                definitionJson,
                source: 'curated',
                sourceWorkflowId: saveModalWorkflow.id,
                tags: saveModalWorkflow.identity?.tags || [],
            });
            setSaveSuccess(saveName.trim());
            setSaveModalWorkflow(null);
        } catch (err) {
            setSaveError(err.message || 'Failed to save workflow');
        } finally {
            setSaving(false);
        }
    }, [saveModalWorkflow, saveName, authFetch, currentOrg?.id]);

    // Delete from My Library
    const handleDeleteMyEntry = useCallback(async (entry) => {
        if (!currentOrg?.id || !authFetch) return;
        try {
            await deleteFromUserLibrary({ authFetch, orgId: currentOrg.id, id: entry.id });
            setMyLibraryEntries(prev => prev.filter(e => e.id !== entry.id));
        } catch (err) {
            console.error('[user-library] delete failed:', err);
        }
    }, [authFetch, currentOrg?.id]);

    // Handle bulk import from CollectionImporter
    // result is the object returned by indexWorkflows; each result.workflows[i].n8nWorkflowJson
    // carries the original parsed JSON.
    const handleImport = useCallback(async (result) => {
        if (!result?.workflows?.length || !currentOrg?.id || !authFetch) return;
        setImporting(true);
        setShowImportModal(false);
        setImportSummary(null);

        const succeeded = [];
        const failed = [];

        for (const wf of result.workflows) {
            const name = wf.identity?.name || 'Unnamed Workflow';
            try {
                await saveToUserLibrary({
                    authFetch,
                    orgId: currentOrg.id,
                    name,
                    description: wf.identity?.description || '',
                    definitionJson: wf.n8nWorkflowJson || {},
                    source: 'n8n-imported',
                    sourceWorkflowId: null,
                    tags: [
                        ...(wf.identity?.tags || []),
                        ...(wf.capabilities?.integrations || []),
                    ].slice(0, 20),
                });
                succeeded.push(name);
            } catch (err) {
                const isDuplicate = err.message?.includes('409') || err.message?.toLowerCase().includes('duplicate') || err.message?.toLowerCase().includes('already exists');
                failed.push({ name, reason: isDuplicate ? 'duplicate name' : (err.message || 'unknown error') });
                console.warn('[n8n-import] skipped', name, ':', err.message);
            }
        }

        setImporting(false);
        setImportSummary({ succeeded: succeeded.length, failed });

        // If user is viewing My Library, refresh the list so imports appear immediately
        if (sourceFilter === 'mine' && authFetch && currentOrg?.id) {
            listUserLibrary({ authFetch, orgId: currentOrg.id })
                .then(entries => setMyLibraryEntries(entries))
                .catch(() => {});
        }
    }, [authFetch, currentOrg?.id, sourceFilter]);

    // Toggle integration filter
    const toggleIntegration = useCallback((integration) => {
        setSelectedIntegrations(prev =>
            prev.includes(integration)
                ? prev.filter(i => i !== integration)
                : [...prev, integration]
        );
    }, []);

    // Toggle tag filter
    const toggleTag = useCallback((tag) => {
        setSelectedTags(prev =>
            prev.includes(tag)
                ? prev.filter(t => t !== tag)
                : [...prev, tag]
        );
    }, []);

    // Clear all filters
    const clearFilters = useCallback(() => {
        setSearchQuery('');
        setSelectedCategory(null);
        setSelectedIntegrations([]);
        setSelectedTags([]);
    }, []);

    // Copy workflow ID
    const copyWorkflowId = useCallback((id) => {
        navigator.clipboard.writeText(id);
        setCopiedId(id);
        setTimeout(() => setCopiedId(null), 2000);
    }, []);

    // Open full-screen workflow viewer
    const openViewer = useCallback(async (workflow) => {
        setViewerWorkflow(workflow);
        setViewerWorkflowJson(null);

        if (workflow?.workflowFile) {
            setLoadingViewer(true);
            try {
                const json = await loadWorkflowJson(workflow.workflowFile);
                setViewerWorkflowJson(json);
            } catch (err) {
                console.error('Failed to load workflow diagram:', err);
            } finally {
                setLoadingViewer(false);
            }
        }
    }, []);

    // Close viewer and return to library
    const closeViewer = useCallback(() => {
        setViewerWorkflow(null);
        setViewerWorkflowJson(null);
        setDeployStatus(null);
    }, []);

    // Deploy workflow to QuoxFlow
    const handleDeploy = useCallback(async (workflow) => {
        if (deploying || !workflow?.workflowFile) return;
        setDeploying(true);
        setDeployStatus(null);
        try {
            const json = viewerWorkflowJson || await loadWorkflowJson(workflow.workflowFile);
            const result = await createWorkflow(json);
            const id = result?.id || result?.data?.id;
            setDeployStatus({ success: true, message: `Deployed "${workflow.identity.name}"`, workflowId: id });
        } catch (err) {
            setDeployStatus({ success: false, message: err.message || 'Deploy failed' });
        } finally {
            setDeploying(false);
        }
    }, [deploying, viewerWorkflowJson]);

    if (loading) {
        return (
            <div className="workflow-library-view view-page">
                <div className="loading-state">
                    <div className="loading-spinner" />
                    <p>Loading 1,300+ workflow templates...</p>
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="workflow-library-view view-page">
                <div className="error-state">
                    <p>{error}</p>
                    <button onClick={() => window.location.reload()}>Retry</button>
                </div>
            </div>
        );
    }

    // =========================================================================
    // FULL-SCREEN VIEWER MODE
    // =========================================================================
    if (viewerWorkflow) {
        const wf = viewerWorkflow;
        const nodeCount = viewerWorkflowJson?.nodes?.length || wf.nodeCount || 0;

        return (
            <div className="workflow-library-view view-page">
                <div className="wf-viewer">
                    {/* Viewer Header */}
                    <div className="wf-viewer__header">
                        <button className="wf-viewer__back" onClick={closeViewer}>
                            <Icons.arrowLeft />
                            <span>Back to Library</span>
                        </button>
                        <div className="wf-viewer__title">
                            <div
                                className="wf-viewer__category-badge"
                                style={{ backgroundColor: CATEGORY_COLORS[wf.identity.category] }}
                            >
                                <CategoryIcon category={wf.identity.category} />
                            </div>
                            <div>
                                <h2>{wf.identity.name}</h2>
                                <span className="wf-viewer__subtitle">
                                    {wf.identity.category.charAt(0).toUpperCase() + wf.identity.category.slice(1).replace(/-/g, ' ')}
                                    {nodeCount > 0 && <> &middot; {nodeCount} nodes</>}
                                    {wf.trigger?.type && <> &middot; {wf.trigger.type} trigger</>}
                                </span>
                            </div>
                        </div>
                        <div className="wf-viewer__header-actions">
                            <button
                                className="btn"
                                onClick={() => copyWorkflowId(wf.id)}
                                title="Copy workflow ID"
                            >
                                {copiedId === wf.id ? <Icons.check /> : <Icons.copy />}
                                <span>{copiedId === wf.id ? 'Copied' : 'Copy ID'}</span>
                            </button>
                            <button
                                className="btn btn--success"
                                onClick={() => handleDeploy(wf)}
                                disabled={deploying || !wf.workflowFile}
                                title="Deploy to QuoxFlow"
                            >
                                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>
                                <span>{deploying ? 'Deploying...' : 'Deploy to QuoxFlow'}</span>
                            </button>
                            <button
                                className="btn btn--primary"
                                onClick={() => navigate('/workflow-builder', { state: { template: wf } })}
                            >
                                <Icons.template />
                                <span>Use as Template</span>
                            </button>
                        </div>
                    </div>

                    {/* Deploy Status Banner */}
                    {deployStatus && (
                        <div className={`wf-viewer__status-banner wf-viewer__status-banner--${deployStatus.success ? 'success' : 'error'}`}>
                            {deployStatus.success ? <Icons.check /> : <Icons.x />}
                            <span>{deployStatus.message}</span>
                            {deployStatus.success && deployStatus.workflowId && (
                                <button className="btn btn--small" onClick={() => navigate('/workflows')}>
                                    View in Workflows
                                </button>
                            )}
                            <button className="wf-viewer__status-dismiss" onClick={() => setDeployStatus(null)}>
                                <Icons.x />
                            </button>
                        </div>
                    )}

                    {/* Viewer Body: Diagram + Sidebar Details */}
                    <div className="wf-viewer__body">
                        {/* Diagram Area */}
                        <div className="wf-viewer__diagram">
                            {loadingViewer ? (
                                <div className="wf-viewer__loading">
                                    <div className="loading-spinner" />
                                    <p>Loading workflow diagram...</p>
                                </div>
                            ) : viewerWorkflowJson ? (
                                <WireMap
                                    workflowJson={viewerWorkflowJson}
                                />
                            ) : wf.workflowFile ? (
                                <div className="wf-viewer__loading">
                                    <p>Failed to load workflow diagram</p>
                                </div>
                            ) : (
                                <div className="wf-viewer__no-diagram">
                                    <Icons.diagram />
                                    <p>No diagram available for this workflow</p>
                                </div>
                            )}
                        </div>

                        {/* Details Sidebar */}
                        <aside className="wf-viewer__details">
                            <div className="wf-viewer__details-inner">
                                {/* Description */}
                                <div className="detail-section">
                                    <h4>Description</h4>
                                    <p>{wf.identity.description}</p>
                                </div>

                                {/* Integrations */}
                                {wf.capabilities?.integrations?.length > 0 && (
                                    <div className="detail-section">
                                        <h4>Integrations</h4>
                                        <div className="detail-tags">
                                            {wf.capabilities.integrations.map(i => (
                                                <span key={i} className="detail-tag">{i}</span>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {/* Tags */}
                                {wf.identity?.tags?.length > 0 && (
                                    <div className="detail-section">
                                        <h4>Tags</h4>
                                        <div className="detail-tags">
                                            {wf.identity.tags.map(t => (
                                                <span key={t} className="detail-tag detail-tag--tag">#{t}</span>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {/* Safety */}
                                <div className="detail-section">
                                    <h4>Safety</h4>
                                    <div className={`detail-defcon defcon--${wf.safety?.defconLevel?.toLowerCase()}`}>
                                        DEFCON: {wf.safety?.defconLevel || 'GREEN'}
                                    </div>
                                    {wf.safety?.requiresApproval && (
                                        <p className="detail-warning">Requires human approval</p>
                                    )}
                                </div>

                                {/* Trigger */}
                                <div className="detail-section">
                                    <h4>Trigger</h4>
                                    <p className="detail-trigger">{wf.trigger?.type || 'manual'}</p>
                                </div>

                                {/* Stats */}
                                {(wf.nodeCount || wf.edgeCount) && (
                                    <div className="detail-section">
                                        <h4>Structure</h4>
                                        <p>{wf.nodeCount} nodes, {wf.edgeCount} edges</p>
                                    </div>
                                )}

                                {/* Actions */}
                                <div className="wf-viewer__detail-actions">
                                    <button
                                        className="btn btn--success"
                                        onClick={() => handleDeploy(wf)}
                                        disabled={deploying || !wf.workflowFile}
                                    >
                                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>
                                        <span>{deploying ? 'Deploying...' : 'Deploy to QuoxFlow'}</span>
                                    </button>
                                    <button
                                        className="btn btn--primary"
                                        onClick={() => navigate('/workflow-builder', { state: { template: wf } })}
                                    >
                                        <Icons.template />
                                        <span>Use as Template</span>
                                    </button>
                                    <button
                                        className="btn"
                                        onClick={() => {
                                            window.open('/workflows', '_blank');
                                        }}
                                    >
                                        <Icons.externalLink />
                                        <span>View Workflows</span>
                                    </button>
                                    <button
                                        className="btn"
                                        onClick={closeViewer}
                                    >
                                        <Icons.arrowLeft />
                                        <span>Back to Library</span>
                                    </button>
                                </div>
                            </div>
                        </aside>
                    </div>
                </div>
            </div>
        );
    }

    // =========================================================================
    // LIBRARY BROWSE MODE (card grid with search/filter)
    // =========================================================================
    return (
        <div className="workflow-library-view view-page">

            {/* Save Success Toast */}
            {saveSuccess && (
                <div className="qx-banner qx-banner--success library-save-toast">
                    <Icons.check />
                    <span>&ldquo;{saveSuccess}&rdquo; saved to My Library</span>
                    <button className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setSaveSuccess(null)}>
                        <Icons.x />
                    </button>
                </div>
            )}

            {/* Import in-progress notice */}
            {importing && (
                <div className="qx-banner qx-banner--info library-save-toast">
                    <div className="loading-spinner" style={{ width: 16, height: 16 }} />
                    <span>Importing workflows to My Library&hellip;</span>
                </div>
            )}

            {/* Import Summary Banner */}
            {importSummary && !importing && (
                <div className={`qx-banner ${importSummary.failed.length === 0 ? 'qx-banner--success' : importSummary.succeeded === 0 ? 'qx-banner--error' : 'qx-banner--warning'} library-save-toast`}>
                    {importSummary.failed.length === 0 ? <Icons.check /> : <Icons.x />}
                    <span>
                        Imported {importSummary.succeeded} workflow{importSummary.succeeded !== 1 ? 's' : ''}
                        {importSummary.failed.length > 0 && (
                            <> &mdash; {importSummary.failed.length} skipped ({importSummary.failed.map(f => `${f.name}: ${f.reason}`).join('; ')})</>
                        )}
                        {importSummary.succeeded > 0 && (
                            <>. <button className="qx-btn qx-btn--ghost qx-btn--sm" style={{ display: 'inline-flex', padding: '0 4px' }} onClick={() => setSourceFilter('mine')}>View My Library</button></>
                        )}
                    </span>
                    <button className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setImportSummary(null)}>
                        <Icons.x />
                    </button>
                </div>
            )}

            {/* Import Modal */}
            {showImportModal && (
                <div className="library-save-modal-overlay" onClick={() => setShowImportModal(false)}>
                    <div className="library-import-modal" onClick={e => e.stopPropagation()}>
                        <div className="library-import-modal__header">
                            <h3>Import n8n Workflows</h3>
                            <button
                                className="qx-btn qx-btn--ghost qx-btn--sm"
                                onClick={() => setShowImportModal(false)}
                            >
                                <Icons.x />
                            </button>
                        </div>
                        <CollectionImporter onImportComplete={handleImport} />
                    </div>
                </div>
            )}

            {/* Save-to-Library Modal */}
            {saveModalWorkflow && (
                <div className="library-save-modal-overlay" onClick={() => setSaveModalWorkflow(null)}>
                    <div className="library-save-modal" onClick={e => e.stopPropagation()}>
                        <h3>Save to My Library</h3>
                        <p className="library-save-modal__subtitle">{saveModalWorkflow.identity?.description}</p>
                        <label className="library-save-modal__label">
                            Name
                            <input
                                className="library-save-modal__input"
                                type="text"
                                value={saveName}
                                onChange={e => setSaveName(e.target.value)}
                                autoFocus
                                onKeyDown={e => { if (e.key === 'Enter') confirmSave(); }}
                            />
                        </label>
                        {saveError && (
                            <p className="library-save-modal__error">{saveError}</p>
                        )}
                        <div className="library-save-modal__actions">
                            <button
                                className="qx-btn qx-btn--ghost qx-btn--sm"
                                onClick={() => setSaveModalWorkflow(null)}
                                disabled={saving}
                            >
                                Cancel
                            </button>
                            <button
                                className="qx-btn qx-btn--primary qx-btn--sm"
                                onClick={confirmSave}
                                disabled={saving || !saveName.trim()}
                            >
                                {saving ? 'Saving...' : 'Save'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Source Filter — segmented control above search */}
            <div className="library-source-filter">
                {SOURCE_FILTERS.map(sf => (
                    <button
                        key={sf.id}
                        className={`qx-btn qx-btn--sm ${(sourceFilter === sf.id || (sf.id === 'all' && sourceFilter === '')) ? 'qx-btn--primary' : 'qx-btn--ghost'}`}
                        onClick={() => setSourceFilter(sf.id)}
                    >
                        {sf.label}
                    </button>
                ))}
                {sourceFilter === 'all' && (
                    <label className="library-legacy-toggle">
                        <input
                            type="checkbox"
                            checked={showLegacyN8n}
                            onChange={e => setShowLegacyN8n(e.target.checked)}
                        />
                        <span>Show extended library</span>
                    </label>
                )}
            </div>

            {/* Search and Controls */}
            <div className="library-controls">
                <div className="library-search">
                    <span className="search-icon"><Icons.search /></span>
                    <input
                        type="text"
                        aria-label="Search workflows"
                        placeholder="Search workflows by name, integration, or tag..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                    />
                    {searchQuery && (
                        <button className="clear-search" onClick={() => setSearchQuery('')}>
                            <Icons.x />
                        </button>
                    )}
                </div>

                <div className="library-actions">
                    {sourceFilter !== 'mine' && (
                        <>
                            <button
                                className={`btn btn--icon ${showFilters ? 'btn--active' : ''}`}
                                onClick={() => setShowFilters(!showFilters)}
                                title="Toggle filters"
                            >
                                <Icons.filter />
                            </button>
                            <button
                                className={`btn btn--icon ${viewMode === 'grid' ? 'btn--active' : ''}`}
                                onClick={() => setViewMode('grid')}
                                title="Grid view"
                            >
                                <Icons.grid />
                            </button>
                            <button
                                className={`btn btn--icon ${viewMode === 'list' ? 'btn--active' : ''}`}
                                onClick={() => setViewMode('list')}
                                title="List view"
                            >
                                <Icons.list />
                            </button>
                        </>
                    )}
                </div>
            </div>

            {/* Active Filters */}
            {(selectedCategory || selectedIntegrations.length > 0 || selectedTags.length > 0) && (
                <div className="active-filters">
                    <span className="active-filters__label">Active filters:</span>
                    {selectedCategory && (
                        <button
                            className="filter-tag"
                            onClick={() => setSelectedCategory(null)}
                        >
                            <CategoryIcon category={selectedCategory} />
                            {selectedCategory}
                            <span className="filter-x">&times;</span>
                        </button>
                    )}
                    {selectedIntegrations.map(i => (
                        <button
                            key={i}
                            className="filter-tag"
                            onClick={() => toggleIntegration(i)}
                        >
                            {i}
                            <span className="filter-x">&times;</span>
                        </button>
                    ))}
                    {selectedTags.map(t => (
                        <button
                            key={t}
                            className="filter-tag filter-tag--tag"
                            onClick={() => toggleTag(t)}
                        >
                            #{t}
                            <span className="filter-x">&times;</span>
                        </button>
                    ))}
                    <button className="clear-all" onClick={clearFilters}>
                        Clear all
                    </button>
                </div>
            )}

            <div className="library-content">
                {/* Sidebar Filters — only shown for non-mine sources */}
                {showFilters && sourceFilter !== 'mine' && (
                    <aside className="library-sidebar">
                        {/* Categories */}
                        <div className="filter-section">
                            <h3>Categories</h3>
                            <div className="category-list">
                                {categories.map(cat => (
                                    <button
                                        key={cat.id}
                                        className={`category-item ${selectedCategory === cat.id ? 'category-item--active' : ''}`}
                                        onClick={() => setSelectedCategory(
                                            selectedCategory === cat.id ? null : cat.id
                                        )}
                                        style={{ '--cat-color': cat.color }}
                                    >
                                        <CategoryIcon category={cat.id} />
                                        <span className="category-name">{cat.name}</span>
                                        <span className="category-count">{cat.count}</span>
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Integrations */}
                        <div className="filter-section">
                            <h3>Integrations</h3>
                            <div className="integration-list">
                                {integrations.map(int => (
                                    <button
                                        key={int.name}
                                        className={`integration-item ${selectedIntegrations.includes(int.name) ? 'integration-item--active' : ''}`}
                                        onClick={() => toggleIntegration(int.name)}
                                    >
                                        <span className="integration-name">{int.name}</span>
                                        <span className="integration-count">{int.count}</span>
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Popular Tags */}
                        <div className="filter-section">
                            <h3>Popular Tags</h3>
                            <div className="tag-cloud">
                                {popularTags.map(tag => (
                                    <button
                                        key={tag.name}
                                        className={`tag-item ${selectedTags.includes(tag.name) ? 'tag-item--active' : ''}`}
                                        onClick={() => toggleTag(tag.name)}
                                    >
                                        #{tag.name}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </aside>
                )}

                {/* Workflow Grid/List */}
                <main className="library-main">

                    {/* MY LIBRARY MODE */}
                    {sourceFilter === 'mine' ? (
                        <>
                            {myLibraryLoading && (
                                <div className="loading-state">
                                    <div className="loading-spinner" />
                                    <p>Loading your library...</p>
                                </div>
                            )}
                            {myLibraryError && (
                                <div className="error-state">
                                    <p>{myLibraryError}</p>
                                </div>
                            )}
                            {!myLibraryLoading && !myLibraryError && myLibraryEntries.length === 0 && (
                                <div className="empty-state">
                                    <span className="empty-icon">{'\u{1F4DA}'}</span>
                                    <h3>Your library is empty</h3>
                                    <p>Save workflow templates here using the &ldquo;Save to My Library&rdquo; button on any card.</p>
                                    <button className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setSourceFilter('all')}>
                                        Browse Templates
                                    </button>
                                </div>
                            )}
                            {!myLibraryLoading && myLibraryEntries.length > 0 && (
                                <div className="results-header">
                                    <span className="results-count">
                                        {myLibraryEntries.length} saved workflow{myLibraryEntries.length !== 1 ? 's' : ''}
                                    </span>
                                </div>
                            )}
                            {!myLibraryLoading && myLibraryEntries.length > 0 && (
                                <div className="workflow-grid">
                                    {myLibraryEntries.map(entry => {
                                        const tags = (() => { try { return JSON.parse(entry.tags || '[]'); } catch { return []; } })();
                                        return (
                                            <div key={entry.id} className="workflow-card workflow-card--mine">
                                                <div className="workflow-card__category" style={{ backgroundColor: '#6366f1' }}>
                                                    <span className="category-emoji">{'\u{1F4DA}'}</span>
                                                </div>
                                                <div className="workflow-card__content">
                                                    <h4 className="workflow-card__name">{entry.name}</h4>
                                                    {entry.description && (
                                                        <p className="workflow-card__description">{entry.description}</p>
                                                    )}
                                                    {entry.source_workflow_id && (
                                                        <p className="workflow-card__source-label">
                                                            from template &middot; {entry.source}
                                                        </p>
                                                    )}
                                                    {tags.length > 0 && (
                                                        <div className="workflow-card__meta">
                                                            {tags.slice(0, 3).map(t => (
                                                                <span key={t} className="workflow-card__integration">#{t}</span>
                                                            ))}
                                                        </div>
                                                    )}
                                                </div>
                                                <div className="workflow-card__actions">
                                                    <button
                                                        className="qx-btn qx-btn--ghost qx-btn--sm"
                                                        onClick={() => navigate('/workflow-builder', { state: { savedEntry: entry } })}
                                                        title="Open in Builder"
                                                    >
                                                        <Icons.template />
                                                        <span>Open</span>
                                                    </button>
                                                    <button
                                                        className="qx-btn qx-btn--ghost qx-btn--sm qx-btn--danger"
                                                        onClick={() => handleDeleteMyEntry(entry)}
                                                        title="Delete from My Library"
                                                    >
                                                        <Icons.trash />
                                                    </button>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </>
                    ) : (
                        /* CURATED / ALL MODE */
                        <>
                            <div className="results-header">
                                <span className="results-count">
                                    {filteredWorkflows.length.toLocaleString()} workflow{filteredWorkflows.length !== 1 ? 's' : ''}
                                    {(selectedCategory || selectedIntegrations.length > 0 || selectedTags.length > 0 || searchQuery) && ' matching filters'}
                                </span>
                            </div>

                            {filteredWorkflows.length === 0 ? (
                                <div className="empty-state">
                                    <span className="empty-icon">{'\u{1F4E6}'}</span>
                                    <h3>No workflows found</h3>
                                    <p>Try adjusting your filters or search query</p>
                                    <button className="btn" onClick={clearFilters}>Clear filters</button>
                                </div>
                            ) : (
                                <div className={`workflow-${viewMode}`}>
                                    {filteredWorkflows.slice(0, 100).map(workflow => (
                                        <div
                                            key={workflow.id}
                                            className="workflow-card"
                                            onClick={() => openViewer(workflow)}
                                        >
                                            <div
                                                className="workflow-card__category"
                                                style={{ backgroundColor: CATEGORY_COLORS[workflow.identity.category] }}
                                            >
                                                <CategoryIcon category={workflow.identity.category} />
                                            </div>
                                            <div className="workflow-card__content">
                                                <h4 className="workflow-card__name">{workflow.identity.name}</h4>
                                                <p className="workflow-card__description">
                                                    {workflow.identity.description}
                                                </p>
                                                <div className="workflow-card__meta">
                                                    {workflow.capabilities?.integrations?.slice(0, 3).map(i => (
                                                        <span key={i} className="workflow-card__integration">
                                                            {i}
                                                        </span>
                                                    ))}
                                                    {workflow.capabilities?.integrations?.length > 3 && (
                                                        <span className="workflow-card__more">
                                                            +{workflow.capabilities.integrations.length - 3}
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                            <div className="workflow-card__actions">
                                                <button
                                                    className="qx-btn qx-btn--ghost qx-btn--sm"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        navigate('/workflow-builder', { state: { template: workflow } });
                                                    }}
                                                    title="Open in Builder"
                                                >
                                                    <Icons.template />
                                                    <span>Open</span>
                                                </button>
                                                <button
                                                    className="qx-btn qx-btn--ghost qx-btn--sm"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        openSaveModal(workflow);
                                                    }}
                                                    title="Save to My Library"
                                                >
                                                    <Icons.save />
                                                    <span>Save</span>
                                                </button>
                                                <button
                                                    className="qx-btn qx-btn--ghost qx-btn--sm"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        handleDeploy(workflow);
                                                    }}
                                                    title="Deploy to QuoxFlow"
                                                    disabled={!workflow.workflowFile}
                                                >
                                                    <Icons.deploy />
                                                    <span>Deploy</span>
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}

                            {filteredWorkflows.length > 100 && (
                                <div className="load-more">
                                    <p>Showing 100 of {filteredWorkflows.length.toLocaleString()} workflows</p>
                                    <p className="hint">Use filters or search to narrow results</p>
                                </div>
                            )}
                        </>
                    )}
                </main>
            </div>
        </div>
    );
}

export default WorkflowLibraryView;
