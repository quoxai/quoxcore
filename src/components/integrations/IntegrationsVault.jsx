/**
 * IntegrationsVault Component — Phase 2 Rewrite
 *
 * Full-page vault layout with sidebar filters + main content area.
 * Supports grid/table view toggle, type/status/search filtering,
 * bulk operations, and the existing add/edit/delete/test/rotate CRUD.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { INTEGRATION_TYPES, INTEGRATION_CATEGORIES, getIntegrationsByCategory } from '../../config/integrationTypes';
import { useIntegrationTypes } from '../../hooks/useIntegrationTypes';
import { useAuth } from '../../contexts/AuthContext';
import Button from '../ui/Button';
import IntegrationCard from './IntegrationCard';
import IntegrationModal from './IntegrationModal';
import VaultSidebar from '../vault/VaultSidebar';
import VaultBulkActions from '../vault/VaultBulkActions';
import { csrfFetch } from '../../utils/csrfFetch';
import { VAULT_LIST, VAULT_CREATE, VAULT_UPDATE, VAULT_DELETE, VAULT_TEST, VAULT_DEFAULT, VAULT_ROTATE } from '../../config/apiPaths';
import { CREDENTIAL_KIND_ORDER, DEFAULT_CREDENTIAL_KIND, getCredentialKindLabel } from '../../config/vaultCredentialKinds';
import './integrations.css';
import '../inbox/inbox-layout.css';

// Icons
const LockIcon = () => (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
);

const PlusIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
);

const ShieldCheckIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        <path d="M9 12l2 2 4-4" />
    </svg>
);

const CheckCircleIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
        <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
);

const XCircleIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="10" />
        <line x1="15" y1="9" x2="9" y2="15" />
        <line x1="9" y1="9" x2="15" y2="15" />
    </svg>
);

const EncryptedIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
);

const HiddenIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
        <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
);

const AuditIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
    </svg>
);

const SearchIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="11" cy="11" r="8" />
        <path d="M21 21l-4.35-4.35" />
    </svg>
);

const RefreshIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M23 4v6h-6" />
        <path d="M1 20v-6h6" />
        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
);

// Format relative time
function formatRelativeTime(dateStr) {
    if (!dateStr) return 'Never';
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
}

export default function IntegrationsVault({ orgId, orgs }) {
    const { authFetch } = useAuth();
    const { types: integrationTypes } = useIntegrationTypes();
    const [integrations, setIntegrations] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [filter, setFilter] = useState('all');
    const [orgFilter, setOrgFilter] = useState('all'); // 'all' | org.id
    const [statusFilter, setStatusFilter] = useState('all');
    const [folderFilter, setFolderFilter] = useState('all');
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedIds, setSelectedIds] = useState(new Set());
    const [testingAll, setTestingAll] = useState(false);
    const [modalOpen, setModalOpen] = useState(false);
    const [editingIntegration, setEditingIntegration] = useState(null);
    const [notification, setNotification] = useState(null);
    const [viewMode, setViewMode] = useState('grid');
    const navigate = useNavigate();

    // Fetch integrations (supports multi-org when orgs prop provided and orgFilter is 'all')
    const fetchIntegrations = useCallback(async () => {
        const fetchOrgIds = (orgs && orgs.length > 1 && orgFilter === 'all')
            ? orgs.map(o => o.id)
            : [orgFilter !== 'all' ? orgFilter : orgId];

        if (!fetchOrgIds[0]) { setLoading(false); return; }
        try {
            setLoading(true);
            const results = await Promise.allSettled(
                fetchOrgIds.map(async (oid) => {
                    const response = await authFetch(VAULT_LIST(oid));
                    if (!response.ok) {
                        if (response.status === 404) return [];
                        throw new Error('Failed to fetch integrations');
                    }
                    const data = await response.json();
                    return (data.credentials || []).map(c => ({ ...c, org_id: c.org_id || oid }));
                })
            );
            const merged = results
                .filter(r => r.status === 'fulfilled')
                .flatMap(r => r.value);
            setIntegrations(merged);
        } catch (err) {
            console.error('Failed to fetch integrations:', err);
            setIntegrations([]);
        } finally {
            setLoading(false);
        }
    }, [orgId, orgs, orgFilter, authFetch]);

    useEffect(() => {
        fetchIntegrations();
    }, [fetchIntegrations]);

    // Notification helper
    const showNotification = useCallback((message, type = 'info') => {
        setNotification({ message, type });
        setTimeout(() => setNotification(null), 4000);
    }, []);

    // Filter integrations
    const filteredIntegrations = useMemo(() => {
        let filtered = integrations;

        if (filter !== 'all') {
            filtered = filtered.filter(i => i.integration_type === filter);
        }

        if (statusFilter !== 'all') {
            filtered = filtered.filter(i => {
                if (statusFilter === 'healthy') return i.test_status === 'success';
                if (statusFilter === 'failed') return i.test_status === 'failed';
                if (statusFilter === 'untested') return !i.test_status || i.test_status === 'untested';
                return true;
            });
        }

        if (folderFilter !== 'all') {
            filtered = filtered.filter(i => i.folder_id === folderFilter);
        }

        if (searchQuery.trim()) {
            const query = searchQuery.toLowerCase().trim();
            filtered = filtered.filter(i =>
                i.label?.toLowerCase().includes(query) ||
                i.integration_type?.toLowerCase().includes(query) ||
                i.description?.toLowerCase().includes(query)
            );
        }

        return filtered;
    }, [integrations, filter, statusFilter, folderFilter, searchQuery]);

    // VAULT-AUDIT P7: group filtered integrations by credential_kind (typed
    // taxonomy from VAULT-P2), with a nested by-type grouping inside each
    // kind section — replaces the flat/type-only list with kind-first
    // section headers. credential_kind is sourced directly from the GET
    // vault credentials response (DB column, defaults to 'service_api').
    const groupedByKind = useMemo(() => {
        const kindGroups = {};
        for (const integration of filteredIntegrations) {
            const kind = integration.credential_kind || DEFAULT_CREDENTIAL_KIND;
            if (!kindGroups[kind]) {
                kindGroups[kind] = { kind, label: getCredentialKindLabel(kind), items: [], typeGroups: {} };
            }
            kindGroups[kind].items.push(integration);

            const type = integration.integration_type;
            if (!kindGroups[kind].typeGroups[type]) {
                kindGroups[kind].typeGroups[type] = {
                    type: integrationTypes[type] || { id: type, name: type, color: '#6B7280' },
                    items: []
                };
            }
            kindGroups[kind].typeGroups[type].items.push(integration);
        }

        const finalize = (kind) => ({ ...kindGroups[kind], typeGroups: Object.values(kindGroups[kind].typeGroups) });
        const ordered = CREDENTIAL_KIND_ORDER.filter(k => kindGroups[k]).map(finalize);
        const extras = Object.keys(kindGroups)
            .filter(k => !CREDENTIAL_KIND_ORDER.includes(k))
            .map(finalize);
        return [...ordered, ...extras];
    }, [filteredIntegrations, integrationTypes]);

    // Selection handlers
    const handleSelect = useCallback((id, selected) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (selected) next.add(id);
            else next.delete(id);
            return next;
        });
    }, []);

    const handleSelectAll = useCallback(() => {
        const visibleIds = filteredIntegrations.map(i => i.id);
        const allSelected = visibleIds.every(id => selectedIds.has(id));
        setSelectedIds(allSelected ? new Set() : new Set(visibleIds));
    }, [filteredIntegrations, selectedIds]);

    // Per-kind-section select-all (table view is now grouped by credential_kind)
    const areAllSelected = useCallback((items) => items.length > 0 && items.every(i => selectedIds.has(i.id)), [selectedIds]);

    const toggleSelectGroup = useCallback((items) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            const allSelected = items.every(i => next.has(i.id));
            for (const item of items) {
                if (allSelected) next.delete(item.id);
                else next.add(item.id);
            }
            return next;
        });
    }, []);

    // Resolve the correct org for a credential (multi-org support)
    const credOrgId = useCallback((credId) => {
        const cred = integrations.find(i => i.id === credId);
        return cred?.org_id || orgId;
    }, [integrations, orgId]);

    // CRUD handlers
    // Adding a new integration opens the full-page browse (/vault/browse)
    // rather than a cramped modal type-picker. The modal here is kept for
    // edit/rotate of an existing credential only. The full page also renders
    // the 'custom'/uncategorised bucket, which the modal picker skips, so
    // uncategorised types (e.g. github) are reachable there.
    const handleAddNew = useCallback(() => {
        navigate('/vault/browse');
    }, [navigate]);

    const handleEdit = useCallback((integration) => {
        setEditingIntegration(integration);
        setModalOpen(true);
    }, []);

    const handleDelete = useCallback(async (id) => {
        if (!confirm('Delete this credential? This cannot be undone.')) return;
        try {
            const response = await csrfFetch(VAULT_DELETE(credOrgId(id), id), {
                method: 'DELETE'
            });
            if (!response.ok) throw new Error('Failed to delete');
            setIntegrations(prev => prev.filter(i => i.id !== id));
            showNotification('Credential deleted', 'success');
        } catch {
            showNotification('Failed to delete credential', 'error');
        }
    }, [credOrgId, showNotification]);

    const handleTest = useCallback(async (id) => {
        try {
            const response = await csrfFetch(VAULT_TEST(credOrgId(id), id), {
                method: 'POST'
            });
            const data = await response.json();
            setIntegrations(prev => prev.map(i =>
                i.id === id ? { ...i, test_status: data.success ? 'success' : 'failed' } : i
            ));
            // VAULT-INTEG P8: use the backend's real message (it already
            // reads "... format check only)" for a format_check result)
            // instead of a hardcoded "Connection successful" that reads
            // identically whether or not a live probe actually ran.
            showNotification(
                data.message || (data.success ? 'Connection successful' : 'Connection failed'),
                data.success ? 'success' : 'error'
            );
        } catch {
            showNotification('Failed to test connection', 'error');
        }
    }, [credOrgId, showNotification]);

    const handleSetDefault = useCallback(async (id) => {
        try {
            const oid = credOrgId(id);
            const response = await csrfFetch(VAULT_DEFAULT(oid, id), {
                method: 'POST'
            });
            if (!response.ok) throw new Error('Failed to set default');
            const updated = await response.json();
            setIntegrations(prev => prev.map(i => {
                if (i.id === id) return { ...i, is_default: true };
                // Only clear default for same type within the same org
                if (i.integration_type === updated.integration_type && (i.org_id || orgId) === oid) return { ...i, is_default: false };
                return i;
            }));
            showNotification('Set as default', 'success');
        } catch {
            showNotification('Failed to set default', 'error');
        }
    }, [credOrgId, orgId, showNotification]);

    const handleRotate = useCallback((integration) => {
        setEditingIntegration({ ...integration, _rotateMode: true });
        setModalOpen(true);
    }, []);

    const handleTestAll = useCallback(async () => {
        if (integrations.length === 0) return;
        setTestingAll(true);
        let successCount = 0, failCount = 0;
        for (const integration of integrations) {
            try {
                const oid = integration.org_id || orgId;
                const response = await csrfFetch(VAULT_TEST(oid, integration.id), {
                    method: 'POST'
                });
                const data = await response.json();
                setIntegrations(prev => prev.map(i =>
                    i.id === integration.id ? { ...i, test_status: data.success ? 'success' : 'failed' } : i
                ));
                if (data.success) successCount++;
                else failCount++;
            } catch { failCount++; }
        }
        setTestingAll(false);
        showNotification(`Tested ${successCount + failCount}: ${successCount} healthy, ${failCount} failed`, successCount > failCount ? 'success' : 'error');
    }, [integrations, orgId, showNotification]);

    const handleSave = useCallback(async (data) => {
        try {
            const isEditing = !!editingIntegration;
            const isRotating = editingIntegration?._rotateMode;
            const saveOrgId = editingIntegration?.org_id || orgId;

            let url, method;
            if (isRotating) {
                url = `${VAULT_ROTATE(saveOrgId, editingIntegration.id)}?test=true`;
                method = 'POST';
            } else if (isEditing) {
                url = VAULT_UPDATE(saveOrgId, editingIntegration.id);
                method = 'PUT';
            } else {
                url = VAULT_CREATE(orgId);
                method = 'POST';
            }

            const response = await csrfFetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });

            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                throw new Error(err.message || `Failed to save (HTTP ${response.status})`);
            }

            const saved = await response.json();
            if (isEditing) {
                setIntegrations(prev => prev.map(i => i.id === saved.id ? saved : i));
            } else {
                setIntegrations(prev => [...prev, saved]);
            }

            setModalOpen(false);
            setEditingIntegration(null);
            showNotification(
                isRotating ? 'Credential rotated' : isEditing ? 'Credential updated' : 'Credential added',
                'success'
            );
        } catch (err) {
            throw err;
        }
    }, [editingIntegration, orgId, showNotification]);

    // Bulk callbacks
    const handleBulkDeleteSuccess = useCallback((ids) => {
        setIntegrations(prev => prev.filter(i => !ids.has(i.id)));
    }, []);

    const handleBulkTestComplete = useCallback((id, status) => {
        setIntegrations(prev => prev.map(i =>
            i.id === id ? { ...i, test_status: status } : i
        ));
    }, []);

    // Table view row
    const renderTableRow = (integration) => {
        const config = integrationTypes[integration.integration_type] || { name: integration.integration_type, color: '#6B7280' };
        return (
            <tr key={integration.id} className="vault-table__row">
                <td className="vault-table__cell vault-table__cell--check">
                    <input
                        type="checkbox"
                        checked={selectedIds.has(integration.id)}
                        onChange={(e) => handleSelect(integration.id, e.target.checked)}
                    />
                </td>
                <td className="vault-table__cell">
                    <div className="vault-table__name">
                        <span
                            className={`vault-table__health vault-table__health--${integration.test_status || 'untested'}`}
                        />
                        <span>{integration.label}</span>
                        {integration.is_default && (
                            <span className="vault-table__badge">Default</span>
                        )}
                        {integration.visibility && integration.visibility !== 'org' && (
                            <span className="vault-table__visibility-badge">
                                {integration.visibility === 'personal' ? 'Personal' : 'Team'}
                            </span>
                        )}
                        {orgs && orgs.length > 1 && integration.org_id && (
                            <span className="inbox-item-org-badge">
                                {orgs.find(o => o.id === integration.org_id)?.name || 'Unknown'}
                            </span>
                        )}
                    </div>
                </td>
                <td className="vault-table__cell">
                    <span className="vault-table__type" style={{ color: config.color }}>
                        {config.name}
                    </span>
                </td>
                <td className="vault-table__cell vault-table__cell--mono">
                    {integration.key_preview || '****'}
                </td>
                <td className="vault-table__cell vault-table__cell--muted">
                    {formatRelativeTime(integration.last_used_at)}
                </td>
                <td className="vault-table__cell">
                    <div className="vault-table__actions">
                        <button className="vault-table__action-btn" onClick={() => handleTest(integration.id)} title="Test">
                            <RefreshIcon />
                        </button>
                        <button className="vault-table__action-btn" onClick={() => handleEdit(integration)} title="Edit">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                            </svg>
                        </button>
                        <button className="vault-table__action-btn vault-table__action-btn--danger" onClick={() => handleDelete(integration.id)} title="Delete">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <polyline points="3 6 5 6 21 6" />
                                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                            </svg>
                        </button>
                    </div>
                </td>
            </tr>
        );
    };

    return (
        <div className="integrations-vault integrations-vault--full-page">
            {/* Header */}
            <div className="integrations-vault__header">
                <div>
                    <h1 className="integrations-vault__title">
                        <span className="integrations-vault__title-icon"><LockIcon /></span>
                        Credentials
                    </h1>
                    <p className="integrations-vault__subtitle">
                        {integrations.length} credential{integrations.length !== 1 ? 's' : ''} stored
                        {filteredIntegrations.length !== integrations.length && ` (${filteredIntegrations.length} shown)`}
                    </p>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <span className="integrations-vault__security-badge">
                        <ShieldCheckIcon /> AES-256
                    </span>
                    <Button
                        variant="secondary"
                        onClick={handleTestAll}
                        disabled={testingAll || integrations.length === 0}
                    >
                        <RefreshIcon /> {testingAll ? 'Testing...' : 'Test All'}
                    </Button>
                    <Button variant="primary" onClick={handleAddNew}>
                        <PlusIcon /> Add Credential
                    </Button>
                </div>
            </div>

            {/* Org filter pills (multi-org) */}
            {orgs && orgs.length > 1 && (
                <div className="inbox-org-filter-strip" style={{ paddingTop: 0, paddingBottom: 8 }}>
                    <button
                        className={`inbox-org-filter-strip__pill ${orgFilter === 'all' ? 'inbox-org-filter-strip__pill--active' : ''}`}
                        onClick={() => setOrgFilter('all')}
                    >
                        All Orgs
                    </button>
                    {orgs.map(org => (
                        <button
                            key={org.id}
                            className={`inbox-org-filter-strip__pill ${orgFilter === org.id ? 'inbox-org-filter-strip__pill--active' : ''}`}
                            onClick={() => setOrgFilter(orgFilter === org.id ? 'all' : org.id)}
                        >
                            {org.logo_url && <img src={org.logo_url} alt="" className="inbox-org-filter-strip__logo" />}
                            {org.name}
                        </button>
                    ))}
                </div>
            )}

            {/* Notification Toast */}
            {notification && (
                <div
                    className={`integrations-notification integrations-notification--${notification.type}`}
                    role="status"
                    aria-live="polite"
                >
                    <span className="integrations-notification__icon">
                        {notification.type === 'success' ? <CheckCircleIcon /> : <XCircleIcon />}
                    </span>
                    <span className="integrations-notification__message">{notification.message}</span>
                </div>
            )}

            {/* Bulk Actions Bar */}
            <VaultBulkActions
                selectedIds={selectedIds}
                orgId={orgId}
                resolveOrgId={credOrgId}
                onClearSelection={() => setSelectedIds(new Set())}
                onDeleteSuccess={handleBulkDeleteSuccess}
                onTestComplete={handleBulkTestComplete}
                showNotification={showNotification}
            />

            {/* Main Layout: Sidebar + Content */}
            <div className="integrations-vault__layout">
                {/* Sidebar */}
                {integrations.length > 0 && (
                    <VaultSidebar
                        credentials={integrations}
                        activeType={filter}
                        activeStatus={statusFilter}
                        activeFolder={folderFilter}
                        viewMode={viewMode}
                        onTypeChange={setFilter}
                        onStatusChange={setStatusFilter}
                        onFolderChange={setFolderFilter}
                        onViewChange={setViewMode}
                    />
                )}

                {/* Content Area */}
                <div className="integrations-vault__content">
                    {/* Search Bar */}
                    {integrations.length > 0 && (
                        <div className="integrations-toolbar">
                            <div className="integrations-search">
                                <SearchIcon />
                                <input
                                    type="text"
                                    className="integrations-search__input"
                                    placeholder="Search credentials..."
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                />
                                {searchQuery && (
                                    <button
                                        className="integrations-search__clear"
                                        onClick={() => setSearchQuery('')}
                                    >
                                        &times;
                                    </button>
                                )}
                            </div>
                            {filteredIntegrations.length > 0 && (
                                <label className="integrations-toolbar__select-all">
                                    <input
                                        type="checkbox"
                                        checked={filteredIntegrations.length > 0 && filteredIntegrations.every(i => selectedIds.has(i.id))}
                                        onChange={handleSelectAll}
                                    />
                                    Select all
                                </label>
                            )}
                        </div>
                    )}

                    {/* Loading */}
                    {loading && (
                        <div className="settings-card">
                            <div className="settings-card__body" style={{ textAlign: 'center', padding: '48px' }}>
                                <div className="ui-spinner" style={{ margin: '0 auto 16px' }} />
                                <p style={{ color: 'var(--ui-text-muted)' }}>Loading credentials...</p>
                            </div>
                        </div>
                    )}

                    {/* Empty State */}
                    {!loading && integrations.length === 0 && (
                        <div className="integrations-empty">
                            <svg className="integrations-empty__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                            </svg>
                            <h2 className="integrations-empty__title">No credentials yet</h2>
                            <p className="integrations-empty__description">
                                Securely store API keys and credentials for services like OpenAI, Telegram, Slack, and more.
                            </p>
                            <div className="integrations-empty__features">
                                <span className="integrations-empty__feature">
                                    <span className="integrations-empty__feature-icon"><EncryptedIcon /></span>
                                    AES-256 Encryption
                                </span>
                                <span className="integrations-empty__feature">
                                    <span className="integrations-empty__feature-icon"><HiddenIcon /></span>
                                    Keys Never Exposed
                                </span>
                                <span className="integrations-empty__feature">
                                    <span className="integrations-empty__feature-icon"><AuditIcon /></span>
                                    Full Audit Trail
                                </span>
                            </div>
                            <Button variant="primary" onClick={handleAddNew}>
                                <PlusIcon /> Add Your First Credential
                            </Button>
                        </div>
                    )}

                    {/* No Results */}
                    {!loading && integrations.length > 0 && filteredIntegrations.length === 0 && (
                        <div className="integrations-empty" style={{ padding: '48px 24px' }}>
                            <h2 className="integrations-empty__title">No matches</h2>
                            <p className="integrations-empty__description">
                                Try adjusting your filters or search query.
                            </p>
                            <Button variant="secondary" onClick={() => {
                                setFilter('all');
                                setStatusFilter('all');
                                setFolderFilter('all');
                                setSearchQuery('');
                            }}>
                                Clear Filters
                            </Button>
                        </div>
                    )}

                    {/* Table View — grouped by credential_kind (VAULT-AUDIT P7) */}
                    {!loading && viewMode === 'table' && filteredIntegrations.length > 0 && groupedByKind.map(kindGroup => (
                        <div key={kindGroup.kind} className="vault-kind-section">
                            <div className="vault-kind-section__header">
                                <h2 className="vault-kind-section__title">{kindGroup.label}</h2>
                                <span className="vault-kind-section__count">{kindGroup.items.length}</span>
                            </div>
                            <div className="vault-table-wrapper">
                                <table className="vault-table">
                                    <thead>
                                        <tr>
                                            <th className="vault-table__th vault-table__th--check">
                                                <input
                                                    type="checkbox"
                                                    checked={areAllSelected(kindGroup.items)}
                                                    onChange={() => toggleSelectGroup(kindGroup.items)}
                                                />
                                            </th>
                                            <th className="vault-table__th">Name</th>
                                            <th className="vault-table__th">Type</th>
                                            <th className="vault-table__th">Key</th>
                                            <th className="vault-table__th">Last Used</th>
                                            <th className="vault-table__th">Actions</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {kindGroup.items.map(renderTableRow)}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    ))}

                    {/* Grid View — kind sections, each subdivided by integration type (VAULT-AUDIT P7) */}
                    {!loading && viewMode === 'grid' && groupedByKind.map(kindGroup => (
                        <div key={kindGroup.kind} className="vault-kind-section">
                            <div className="vault-kind-section__header">
                                <h2 className="vault-kind-section__title">{kindGroup.label}</h2>
                                <span className="vault-kind-section__count">{kindGroup.items.length}</span>
                            </div>
                            {kindGroup.typeGroups.map(group => (
                                <div key={group.type.id} className="integration-group">
                                    <div className="integration-group__header">
                                        <h3 className="integration-group__title">{group.type.name}</h3>
                                        <span className="integration-group__count">{group.items.length}</span>
                                    </div>
                                    <div className="integration-group__grid">
                                        {group.items.map(integration => (
                                            <IntegrationCard
                                                key={integration.id}
                                                integration={integration}
                                                typeConfig={integrationTypes[integration.integration_type]}
                                                selected={selectedIds.has(integration.id)}
                                                onSelect={(selected) => handleSelect(integration.id, selected)}
                                                onEdit={() => handleEdit(integration)}
                                                onDelete={() => handleDelete(integration.id)}
                                                onTest={() => handleTest(integration.id)}
                                                onSetDefault={() => handleSetDefault(integration.id)}
                                                onRotate={() => handleRotate(integration)}
                                            />
                                        ))}
                                        <button className="integration-add-card" onClick={handleAddNew}>
                                            <div className="integration-add-card__icon"><PlusIcon /></div>
                                            <span className="integration-add-card__text">Add {group.type.name}</span>
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    ))}

                    {/* Standalone add card when grid view has no groups after filtering */}
                    {!loading && viewMode === 'grid' && integrations.length > 0 && groupedByKind.length === 0 && filteredIntegrations.length === 0 && (
                        <button className="integration-add-card" onClick={handleAddNew} style={{ maxWidth: '320px' }}>
                            <div className="integration-add-card__icon"><PlusIcon /></div>
                            <span className="integration-add-card__text">Add Credential</span>
                        </button>
                    )}
                </div>
            </div>

            {/* Modal */}
            {modalOpen && (
                <IntegrationModal
                    isOpen={modalOpen}
                    onClose={() => {
                        setModalOpen(false);
                        setEditingIntegration(null);
                    }}
                    onSave={handleSave}
                    editingIntegration={editingIntegration}
                />
            )}
        </div>
    );
}
