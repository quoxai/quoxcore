/**
 * PromptsLibraryView — STUDY-REV-2 / P7.E.2
 *
 * Full rewrite on top of the server-side /api/prompts API.
 * No localStorage as primary storage — server is the source of truth.
 *
 * On first mount: runs a one-time drain if old localStorage keys are present.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import {
    listPrompts,
    createPrompt,
    updatePrompt,
    deletePrompt,
    listVersions,
    restoreVersion,
    exportPrompts,
    migratePromptsFromLocalStorage,
} from '../../services/promptsClient';
import {
    hasLocalStorageData,
    readDrain,
    clearLocalStorageKeys,
} from '../../lib/promptsLocalStorageDrain';
import PromptHistoryModal from '../../components/prompts/PromptHistoryModal';
import './views.css';

// ─── helpers ─────────────────────────────────────────────────────────────────

function relativeTime(iso) {
    if (!iso) return '';
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    const hrs = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    if (hrs < 24) return `${hrs}h ago`;
    if (days < 7) return `${days}d ago`;
    return new Date(iso).toLocaleDateString();
}

// ─── icons ────────────────────────────────────────────────────────────────────

const Icons = {
    search: () => (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
        </svg>
    ),
    plus: () => (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
    ),
    edit: () => (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
    ),
    trash: () => (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
        </svg>
    ),
    send: () => (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="22" y1="2" x2="11" y2="13"/>
            <polygon points="22 2 15 22 11 13 2 9 22 2"/>
        </svg>
    ),
    clock: () => (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
        </svg>
    ),
    x: () => (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
    ),
    grid: () => (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
            <rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
        </svg>
    ),
    list: () => (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/>
            <line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/>
            <line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
        </svg>
    ),
    download: () => (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
    ),
    slash: () => (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="6" y1="18" x2="18" y2="6"/>
        </svg>
    ),
    file: () => (
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
        </svg>
    ),
};

// ─── PromptCard ───────────────────────────────────────────────────────────────

function PromptCard({ prompt, viewMode, onEdit, onDelete, onSendToChat }) {
    const tags = prompt.tags || [];
    const deployTargets = prompt.deploy_targets || [];
    const isSlash = deployTargets.includes('slash');

    return (
        <div className={`prompt-card prompt-card--${viewMode}`} onClick={() => onEdit(prompt)}>
            <div className="prompt-card__header">
                <h3 className="prompt-card__name">{prompt.name || 'Untitled'}</h3>
                {isSlash && (
                    <span className="prompt-card__badge">
                        <Icons.slash /> slash
                    </span>
                )}
            </div>
            {prompt.description && (
                <p className="prompt-card__desc">{prompt.description}</p>
            )}
            {tags.length > 0 && (
                <div className="prompt-card__tags">
                    {tags.slice(0, 4).map(t => (
                        <span key={t} className="qx-pill">{t}</span>
                    ))}
                </div>
            )}
            <div className="prompt-card__footer">
                <span className="prompt-card__time">{relativeTime(prompt.updated_at)}</span>
                <div className="prompt-card__actions" onClick={e => e.stopPropagation()}>
                    <button
                        className="qx-btn qx-btn--ghost qx-btn--xs"
                        title="Send to composer"
                        onClick={() => onSendToChat(prompt)}
                    >
                        <Icons.send />
                    </button>
                    <button
                        className="qx-btn qx-btn--ghost qx-btn--xs"
                        title="Edit"
                        onClick={() => onEdit(prompt)}
                    >
                        <Icons.edit />
                    </button>
                    <button
                        className="qx-btn qx-btn--ghost qx-btn--xs qx-btn--danger"
                        title="Delete"
                        onClick={() => onDelete(prompt)}
                    >
                        <Icons.trash />
                    </button>
                </div>
            </div>
        </div>
    );
}

// ─── EditModal ────────────────────────────────────────────────────────────────

function EditModal({ prompt, authFetch, onSaved, onClose }) {
    const isEdit = !!prompt;
    const [name, setName] = useState(prompt?.name || '');
    const [description, setDescription] = useState(prompt?.description || '');
    const [body, setBody] = useState(prompt?.body || '');
    const [tagsInput, setTagsInput] = useState((prompt?.tags || []).join(', '));
    const [category, setCategory] = useState(prompt?.category || 'custom');
    const [visibility, setVisibility] = useState(prompt?.visibility || 'private');
    const [variables, setVariables] = useState(
        prompt?.variables ? JSON.stringify(prompt.variables, null, 2) : ''
    );
    const [deploySlash, setDeploySlash] = useState(
        (prompt?.deploy_targets || []).includes('slash')
    );
    const [deployChat, setDeployChat] = useState(
        (prompt?.deploy_targets || []).includes('chat') || !isEdit
    );
    const [versions, setVersions] = useState([]);
    const [showHistory, setShowHistory] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (isEdit && prompt.id) {
            listVersions({ authFetch, id: prompt.id })
                .then(setVersions)
                .catch(() => setVersions([]));
        }
    }, [isEdit, prompt?.id, authFetch]);

    const deployTargets = [];
    if (deployChat) deployTargets.push('chat');
    if (deploySlash) deployTargets.push('slash');

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!name.trim() || !body.trim()) {
            setError('Name and body are required');
            return;
        }

        let parsedVars;
        if (variables.trim()) {
            try { parsedVars = JSON.parse(variables); } catch {
                setError('Variables must be valid JSON');
                return;
            }
        }

        setSaving(true);
        setError(null);
        try {
            const tags = tagsInput.split(',').map(t => t.trim()).filter(Boolean);
            const payload = {
                authFetch,
                name: name.trim(),
                body: body.trim(),
                description: description.trim(),
                tags,
                category,
                visibility,
                deployTargets,
                ...(parsedVars !== undefined && { variables: parsedVars }),
            };
            const saved = isEdit
                ? await updatePrompt({ ...payload, id: prompt.id })
                : await createPrompt(payload);
            onSaved(saved);
        } catch (err) {
            setError(err.message);
        } finally {
            setSaving(false);
        }
    };

    const handleRestore = async (version) => {
        try {
            const restored = await restoreVersion({ authFetch, id: prompt.id, version: version.version });
            onSaved(restored);
        } catch (err) {
            setError(err.message);
        }
        setShowHistory(false);
    };

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content prompt-edit-modal" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <h2>{isEdit ? 'Edit Prompt' : 'New Prompt'}</h2>
                    <button className="modal-close" onClick={onClose}><Icons.x /></button>
                </div>
                <form className="modal-body" onSubmit={handleSubmit}>
                    {error && <div className="qx-banner qx-banner--error">{error}</div>}

                    <div className="form-row">
                        <label>Name *</label>
                        <input
                            className="qx-input"
                            type="text"
                            value={name}
                            onChange={e => setName(e.target.value)}
                            placeholder="My Prompt"
                            required
                        />
                    </div>

                    <div className="form-row">
                        <label>Description</label>
                        <input
                            className="qx-input"
                            type="text"
                            value={description}
                            onChange={e => setDescription(e.target.value)}
                            placeholder="What does this prompt do?"
                        />
                    </div>

                    <div className="form-row two-col">
                        <div>
                            <label>Category</label>
                            <input
                                className="qx-input"
                                type="text"
                                value={category}
                                onChange={e => setCategory(e.target.value)}
                                placeholder="custom"
                            />
                        </div>
                        <div>
                            <label>Visibility</label>
                            <select
                                className="qx-input"
                                value={visibility}
                                onChange={e => setVisibility(e.target.value)}
                            >
                                <option value="private">Private</option>
                                <option value="org">Org-visible</option>
                            </select>
                        </div>
                    </div>

                    <div className="form-row">
                        <label>Tags (comma-separated)</label>
                        <input
                            className="qx-input"
                            type="text"
                            value={tagsInput}
                            onChange={e => setTagsInput(e.target.value)}
                            placeholder="agent, coding, tools"
                        />
                    </div>

                    <div className="form-row">
                        <label>Prompt Body *</label>
                        <textarea
                            className="qx-input prompt-body-input"
                            value={body}
                            onChange={e => setBody(e.target.value)}
                            placeholder="Enter your system prompt here..."
                            rows={10}
                            required
                        />
                    </div>

                    <div className="form-row">
                        <label>Variables (JSON array, optional)</label>
                        <textarea
                            className="qx-input prompt-body-input"
                            value={variables}
                            onChange={e => setVariables(e.target.value)}
                            placeholder='[{"name": "tone", "default": "friendly"}]'
                            rows={3}
                        />
                    </div>

                    <div className="form-row">
                        <label>Deploy targets</label>
                        <div className="deploy-targets">
                            <label className="checkbox-label">
                                <input
                                    type="checkbox"
                                    checked={deployChat}
                                    onChange={e => setDeployChat(e.target.checked)}
                                />
                                Send to chat composer
                            </label>
                            <label className="checkbox-label">
                                <input
                                    type="checkbox"
                                    checked={deploySlash}
                                    onChange={e => setDeploySlash(e.target.checked)}
                                />
                                Register as slash command
                            </label>
                        </div>
                    </div>

                    {isEdit && versions.length > 0 && (
                        <div className="form-row">
                            <button
                                type="button"
                                className="qx-btn qx-btn--secondary"
                                onClick={() => setShowHistory(true)}
                            >
                                <Icons.clock /> Version history ({versions.length})
                            </button>
                        </div>
                    )}

                    <div className="modal-footer">
                        <button type="button" className="qx-btn qx-btn--secondary" onClick={onClose}>
                            Cancel
                        </button>
                        <button type="submit" className="qx-btn qx-btn--primary" disabled={saving}>
                            {saving ? 'Saving...' : (isEdit ? 'Save Changes' : 'Create Prompt')}
                        </button>
                    </div>
                </form>
            </div>

            {showHistory && prompt && (
                <PromptHistoryModal
                    promptId={prompt.id}
                    versions={versions}
                    onRestore={handleRestore}
                    onClose={() => setShowHistory(false)}
                />
            )}
        </div>
    );
}

// ─── PromptsLibraryView ───────────────────────────────────────────────────────

function PromptsLibraryView() {
    const { setPageActions } = useOutletContext() || {};
    const { authFetch } = useAuth();

    const [prompts, setPrompts] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [migrateStatus, setMigrateStatus] = useState(null); // null | 'running' | 'done' | 'error'

    const [searchQuery, setSearchQuery] = useState('');
    const [tagFilter, setTagFilter] = useState('');
    const [viewMode, setViewMode] = useState('grid');

    const [editingPrompt, setEditingPrompt] = useState(null); // null = closed, {} = new, {...} = edit
    const [showEditModal, setShowEditModal] = useState(false);

    const drainRanRef = useRef(false);

    // ── Load / refresh prompts ─────────────────────────────────────────────────

    const loadPrompts = useCallback(async () => {
        try {
            const data = await listPrompts({ authFetch, q: searchQuery || undefined, tags: tagFilter || undefined });
            setPrompts(data);
        } catch (err) {
            setError(err.message);
        }
    }, [authFetch, searchQuery, tagFilter]);

    // ── One-time localStorage drain on mount ──────────────────────────────────

    useEffect(() => {
        if (drainRanRef.current) return;
        drainRanRef.current = true;

        async function maybeMigrate() {
            if (!hasLocalStorageData()) {
                setLoading(false);
                await loadPrompts();
                return;
            }
            setMigrateStatus('running');
            try {
                const payload = readDrain();
                await migratePromptsFromLocalStorage({ authFetch, ...payload });
                clearLocalStorageKeys();
                setMigrateStatus('done');
            } catch (err) {
                console.warn('[PromptsLibraryView] Migration failed (non-fatal):', err);
                setMigrateStatus('error');
            } finally {
                setLoading(false);
                await loadPrompts();
            }
        }

        maybeMigrate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Re-fetch when search/tag filters change (skip initial mount — handled above)
    const isFirstRender = useRef(true);
    useEffect(() => {
        if (isFirstRender.current) { isFirstRender.current = false; return; }
        loadPrompts();
    }, [loadPrompts]);

    // ── Page actions ───────────────────────────────────────────────────────────

    useEffect(() => {
        setPageActions?.(
            <>
                <button
                    className="qx-btn qx-btn--primary"
                    onClick={() => { setEditingPrompt(null); setShowEditModal(true); }}
                >
                    <Icons.plus /> New Prompt
                </button>
                <button
                    className="qx-btn qx-btn--secondary"
                    onClick={handleExport}
                >
                    <Icons.download /> Export
                </button>
            </>
        );
        return () => setPageActions?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [setPageActions]);

    // ── Handlers ───────────────────────────────────────────────────────────────

    const handleSaved = useCallback((saved) => {
        setShowEditModal(false);
        setEditingPrompt(null);
        loadPrompts();
    }, [loadPrompts]);

    const handleDelete = useCallback(async (prompt) => {
        if (!confirm(`Delete "${prompt.name}"? This cannot be undone.`)) return;
        try {
            await deletePrompt({ authFetch, id: prompt.id });
            loadPrompts();
        } catch (err) {
            alert(`Delete failed: ${err.message}`);
        }
    }, [authFetch, loadPrompts]);

    const handleSendToChat = useCallback((prompt) => {
        // Dispatch a custom event that ChatTab can listen to for inserting prompt body
        const event = new CustomEvent('quox:prompt-insert', {
            detail: { body: prompt.body, name: prompt.name, variables: prompt.variables || [] },
            bubbles: true,
        });
        document.dispatchEvent(event);
    }, []);

    const handleExport = useCallback(async () => {
        try {
            const data = await exportPrompts({ authFetch });
            const json = JSON.stringify(data, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `quox-prompts-export-${new Date().toISOString().split('T')[0]}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (err) {
            alert(`Export failed: ${err.message}`);
        }
    }, [authFetch]);

    // ── Render ─────────────────────────────────────────────────────────────────

    if (loading) {
        return (
            <div className="prompts-library-view">
                <div className="library-loading">
                    <div className="loading-spinner" />
                    {migrateStatus === 'running'
                        ? <p>Migrating your prompts to the server...</p>
                        : <p>Loading your prompts...</p>
                    }
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="prompts-library-view">
                <div className="library-error">
                    <p>{error}</p>
                    <button className="qx-btn qx-btn--secondary" onClick={loadPrompts}>Retry</button>
                </div>
            </div>
        );
    }

    return (
        <div className="prompts-library-view">
            {/* Controls bar */}
            <div className="library-controls">
                <div className="library-search">
                    <Icons.search />
                    <input
                        className="qx-input"
                        type="text"
                        placeholder="Search prompts..."
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                    />
                </div>
                <div className="library-search" style={{ maxWidth: 200 }}>
                    <input
                        className="qx-input"
                        type="text"
                        placeholder="Filter by tags..."
                        value={tagFilter}
                        onChange={e => setTagFilter(e.target.value)}
                    />
                </div>
                <div className="library-view-toggle">
                    <button
                        className={`qx-btn qx-btn--ghost ${viewMode === 'grid' ? 'active' : ''}`}
                        onClick={() => setViewMode('grid')}
                        title="Grid view"
                    >
                        <Icons.grid />
                    </button>
                    <button
                        className={`qx-btn qx-btn--ghost ${viewMode === 'list' ? 'active' : ''}`}
                        onClick={() => setViewMode('list')}
                        title="List view"
                    >
                        <Icons.list />
                    </button>
                </div>
            </div>

            {migrateStatus === 'done' && (
                <div className="qx-banner qx-banner--success" style={{ marginBottom: 12 }}>
                    Your prompts have been migrated from local storage to the server.
                </div>
            )}

            {/* Prompts grid/list */}
            <div className="library-main">
                {prompts.length === 0 ? (
                    <div className="empty-state">
                        <Icons.file />
                        <h3>No prompts yet</h3>
                        <p>Save your first prompt to get started.</p>
                        <button
                            className="qx-btn qx-btn--primary"
                            onClick={() => { setEditingPrompt(null); setShowEditModal(true); }}
                        >
                            <Icons.plus /> New Prompt
                        </button>
                    </div>
                ) : (
                    <div className={`prompts-${viewMode}`}>
                        {prompts.map(p => (
                            <PromptCard
                                key={p.id}
                                prompt={p}
                                viewMode={viewMode}
                                onEdit={(prompt) => { setEditingPrompt(prompt); setShowEditModal(true); }}
                                onDelete={handleDelete}
                                onSendToChat={handleSendToChat}
                            />
                        ))}
                    </div>
                )}
            </div>

            {/* Edit / Create modal */}
            {showEditModal && (
                <EditModal
                    prompt={editingPrompt}
                    authFetch={authFetch}
                    onSaved={handleSaved}
                    onClose={() => { setShowEditModal(false); setEditingPrompt(null); }}
                />
            )}
        </div>
    );
}

export default PromptsLibraryView;
