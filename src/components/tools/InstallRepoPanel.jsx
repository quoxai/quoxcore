/**
 * InstallRepoPanel — STUDY-REV-2/P4.A
 *
 * Register a tool from a Git repository URL + manifest path.
 * Pattern-matches OpenApiInstallPanel and McpInstallPanel exactly.
 *
 * Accepts onSuccess(tool) and onCancel callbacks.
 * Used by AddToolModal (Repo tab) and ToolAddView full-page route.
 *
 * On submit:
 *   1. POST /api/orgs/:orgId/tool-library/from-repo  (auth service)
 *   2. installToolToScope(tool.tool_id)               (auto-links to current org scope)
 *
 * Fields:
 *   - Git URL (required)
 *   - Manifest path (default: tool.json)
 *   - Branch (default: main)
 *   - Signing key ref (optional, plain text — Vault dropdown deferred)
 *   - Category (with "+ Create new…" affordance)
 */

import { useState, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { listCategories, createCategory } from '../../services/toolCategoriesClient';
import { installToolToScope } from '../../services/toolInstallScopeClient';

function InstallRepoPanel({ onSuccess, onCancel }) {
    const { authFetch } = useAuth();
    const { currentOrg } = useWorkspace();

    const [gitUrl, setGitUrl] = useState('');
    const [manifestPath, setManifestPath] = useState('tool.json');
    const [branch, setBranch] = useState('main');
    const [signingKeyRef, setSigningKeyRef] = useState('');
    const [installing, setInstalling] = useState(false);
    const [error, setError] = useState(null);

    // Category state
    const [categories, setCategories] = useState([]);
    const [selectedCategoryId, setSelectedCategoryId] = useState('integration');
    const [creatingCategory, setCreatingCategory] = useState(false);
    const [newCategoryName, setNewCategoryName] = useState('');
    const [creatingError, setCreatingError] = useState(null);

    // Load categories on mount / org change
    useEffect(() => {
        listCategories({ authFetch, orgId: currentOrg?.id })
            .then(setCategories)
            .catch(err => console.warn('[InstallRepoPanel] Categories load failed:', err.message));
    }, [authFetch, currentOrg?.id]);

    function validate() {
        if (!gitUrl.trim()) {
            setError('Git URL is required');
            return false;
        }
        const trimmed = gitUrl.trim();
        if (
            !trimmed.startsWith('https://') &&
            !trimmed.startsWith('http://') &&
            !trimmed.startsWith('git@')
        ) {
            setError('Git URL must start with https://, http://, or git@');
            return false;
        }
        setError(null);
        return true;
    }

    async function handleInstall() {
        if (!validate()) return;
        setInstalling(true);
        setError(null);

        try {
            const orgId = currentOrg?.id;
            const resp = await authFetch(`/api/orgs/${orgId}/tool-library/from-repo`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    git_url: gitUrl.trim(),
                    manifest_path: manifestPath.trim() || 'tool.json',
                    branch: branch.trim() || 'main',
                    signing_key_ref: signingKeyRef.trim() || null,
                    category_id: selectedCategoryId,
                }),
            });
            const data = await resp.json();
            if (!resp.ok) {
                // 409 = already registered — treat as soft success
                if (resp.status === 409 && data.tool) {
                    setError(`Already registered as '${data.tool.name}' — nothing to do.`);
                    return;
                }
                setError(data.message || data.error || 'Registration failed');
                return;
            }

            const tool = data.tool;

            // Auto-link to current org scope via install-to-scope
            if (tool?.tool_id) {
                try {
                    await installToolToScope({ authFetch, toolId: tool.tool_id });
                } catch (scopeErr) {
                    // Non-fatal — tool was registered; scope link will be retried on next load
                    console.warn('[InstallRepoPanel] install-to-scope failed (non-fatal):', scopeErr.message);
                }
            }

            onSuccess?.(tool);
        } catch (err) {
            setError(err.message);
        } finally {
            setInstalling(false);
        }
    }

    async function handleCreateCategory() {
        setCreatingError(null);
        try {
            const cat = await createCategory({ authFetch, name: newCategoryName });
            setCategories(prev => [...prev, cat]);
            setSelectedCategoryId(cat.id);
            setCreatingCategory(false);
            setNewCategoryName('');
        } catch (err) {
            setCreatingError(err.message);
        }
    }

    const hasInput = !!gitUrl.trim();

    return (
        <div className="qx-stack">
            <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: 14, margin: 0 }}>
                Register a tool from a Git repository. The repo must contain a tool manifest
                at the specified path. The sandbox build is queued automatically.
            </p>

            {/* Git URL */}
            <div className="qx-field">
                <label className="qx-field__label qx-field__label--required">Git URL</label>
                <input
                    type="text"
                    className="qx-input qx-input--mono"
                    placeholder="https://github.com/owner/repo"
                    value={gitUrl}
                    onChange={e => { setGitUrl(e.target.value); setError(null); }}
                />
                <span className="qx-field__hint">https://, http://, or git@ formats accepted</span>
            </div>

            <div className="qx-grid-2">
                {/* Manifest path */}
                <div className="qx-field">
                    <label className="qx-field__label">Manifest Path</label>
                    <input
                        type="text"
                        className="qx-input qx-input--mono"
                        placeholder="tool.json"
                        value={manifestPath}
                        onChange={e => { setManifestPath(e.target.value); setError(null); }}
                    />
                    <span className="qx-field__hint">Relative path inside repo</span>
                </div>

                {/* Branch */}
                <div className="qx-field">
                    <label className="qx-field__label">Branch</label>
                    <input
                        type="text"
                        className="qx-input qx-input--mono"
                        placeholder="main"
                        value={branch}
                        onChange={e => { setBranch(e.target.value); setError(null); }}
                    />
                </div>
            </div>

            {/* Signing key ref */}
            <div className="qx-field">
                <label className="qx-field__label">Signing Key Ref (optional)</label>
                <input
                    type="text"
                    className="qx-input qx-input--mono"
                    placeholder="vault:secrets/my-signing-key"
                    value={signingKeyRef}
                    onChange={e => { setSigningKeyRef(e.target.value); setError(null); }}
                />
                <span className="qx-field__hint">
                    Vault reference for manifest signature verification. Full Vault selector ships later.
                </span>
            </div>

            {/* Category field */}
            <div className="qx-field">
                <label className="qx-field__label">Category</label>
                {creatingCategory ? (
                    <div className="qx-row qx-row--tight">
                        <input
                            className="qx-input"
                            placeholder="New category name"
                            value={newCategoryName}
                            onChange={e => setNewCategoryName(e.target.value)}
                            autoFocus
                            style={{ flex: 1 }}
                        />
                        <button
                            className="qx-btn qx-btn--primary qx-btn--sm"
                            onClick={handleCreateCategory}
                            disabled={newCategoryName.trim().length < 2}
                        >
                            Create
                        </button>
                        <button
                            className="qx-btn qx-btn--ghost qx-btn--sm"
                            onClick={() => { setCreatingCategory(false); setCreatingError(null); }}
                        >
                            Cancel
                        </button>
                    </div>
                ) : (
                    <select
                        className="qx-select"
                        value={selectedCategoryId}
                        onChange={e => {
                            if (e.target.value === '__create__') {
                                setCreatingCategory(true);
                            } else {
                                setSelectedCategoryId(e.target.value);
                            }
                        }}
                    >
                        {categories.map(c => (
                            <option key={c.id} value={c.id}>
                                {c.icon} {c.name}{c.org_id ? ' (yours)' : ''}
                            </option>
                        ))}
                        <option value="__create__">+ Create new category…</option>
                    </select>
                )}
                {creatingError && (
                    <p className="qx-banner qx-banner--error" style={{ margin: '4px 0 0' }}>
                        {creatingError}
                    </p>
                )}
            </div>

            {error && (
                <div className="qx-banner qx-banner--error">{error}</div>
            )}

            <div className="qx-row qx-row--end qx-row--tight">
                {onCancel && (
                    <button className="qx-btn qx-btn--ghost" onClick={onCancel}>Cancel</button>
                )}
                <button
                    className="qx-btn qx-btn--primary"
                    onClick={handleInstall}
                    disabled={installing || !hasInput}
                >
                    {installing ? 'Registering...' : 'Register'}
                </button>
            </div>
        </div>
    );
}

export default InstallRepoPanel;
