/**
 * OpenApiInstallPanel — STUDY-REV-2/P1.A-rebuild
 *
 * Extracted from AddToolModal's OpenAPI tab.
 * Accepts onSuccess(registeredTools) and onCancel callbacks.
 * Used by both the legacy AddToolModal (kept for any remaining consumers)
 * and the new ToolAddView full-page route.
 *
 * STUDY-REV-2/P1.A-categories: Category field with "create new" affordance.
 */

import { useState, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { listCategories, createCategory } from '../../services/toolCategoriesClient';

function OpenApiInstallPanel({ onSuccess, onCancel }) {
    const { authFetch } = useAuth();
    const { currentOrg } = useWorkspace();

    const [openapiMode, setOpenapiMode] = useState('url'); // 'url' | 'json'
    const [specUrl, setSpecUrl] = useState('');
    const [specJson, setSpecJson] = useState('');
    const [preview, setPreview] = useState(null);
    const [previewing, setPreviewing] = useState(false);
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
            .catch(err => console.warn('[OpenApiInstallPanel] Categories load failed:', err.message));
    }, [authFetch, currentOrg?.id]);

    function validate() {
        if (openapiMode === 'url') {
            if (!specUrl.startsWith('https://')) {
                setError('URL must start with https://');
                return false;
            }
        } else {
            try {
                JSON.parse(specJson);
            } catch {
                setError('Invalid JSON — paste a valid OpenAPI 3.x spec');
                return false;
            }
        }
        setError(null);
        return true;
    }

    async function handlePreview() {
        if (!validate()) return;
        setPreviewing(true);
        setError(null);
        setPreview(null);
        try {
            const body = openapiMode === 'url'
                ? { spec: specUrl, dryRun: true }
                : { spec: JSON.parse(specJson), dryRun: true };
            const resp = await authFetch('/collector/api/tools/register-openapi', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const data = await resp.json();
            if (!resp.ok) {
                setError(data.message || data.error || 'Preview failed');
                return;
            }
            setPreview(data.registered || []);
        } catch (err) {
            setError(err.message);
        } finally {
            setPreviewing(false);
        }
    }

    async function handleInstall() {
        if (!validate()) return;
        setInstalling(true);
        setError(null);
        try {
            const body = openapiMode === 'url'
                ? { spec: specUrl, category_id: selectedCategoryId }
                : { spec: JSON.parse(specJson), category_id: selectedCategoryId };
            const resp = await authFetch('/collector/api/tools/register-openapi', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const data = await resp.json();
            if (!resp.ok) {
                setError(data.message || data.error || 'Registration failed');
                return;
            }
            onSuccess?.(data.registered || []);
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

    const hasInput = openapiMode === 'url' ? !!specUrl : !!specJson;

    return (
        <div className="qx-stack">
            <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: 14, margin: 0 }}>
                Register tools from an OpenAPI 3.x specification. Each operation becomes a callable tool.
            </p>

            {/* Mode toggle */}
            <div className="qx-seg">
                <button
                    className={`qx-seg__btn${openapiMode === 'url' ? ' qx-seg__btn--active' : ''}`}
                    onClick={() => { setOpenapiMode('url'); setPreview(null); setError(null); }}
                >
                    URL
                </button>
                <button
                    className={`qx-seg__btn${openapiMode === 'json' ? ' qx-seg__btn--active' : ''}`}
                    onClick={() => { setOpenapiMode('json'); setPreview(null); setError(null); }}
                >
                    Paste JSON
                </button>
            </div>

            {openapiMode === 'url' ? (
                <div className="qx-field">
                    <label className="qx-field__label">OpenAPI Spec URL</label>
                    <input
                        type="text"
                        className="qx-input qx-input--mono"
                        placeholder="https://petstore3.swagger.io/api/v3/openapi.json"
                        value={specUrl}
                        onChange={e => { setSpecUrl(e.target.value); setPreview(null); setError(null); }}
                    />
                    <span className="qx-field__hint">Must be an https:// URL returning JSON</span>
                </div>
            ) : (
                <div className="qx-field">
                    <label className="qx-field__label">OpenAPI 3.x JSON</label>
                    <textarea
                        className="qx-textarea qx-input--mono"
                        placeholder={'{\n  "openapi": "3.0.0",\n  "paths": {...}\n}'}
                        value={specJson}
                        onChange={e => { setSpecJson(e.target.value); setPreview(null); setError(null); }}
                        rows={10}
                        style={{ resize: 'vertical' }}
                    />
                </div>
            )}

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
                {creatingError && <p className="qx-banner qx-banner--error" style={{ margin: '4px 0 0' }}>{creatingError}</p>}
            </div>

            {error && (
                <div className="qx-banner qx-banner--error">{error}</div>
            )}

            {preview && (
                <div className="qx-banner qx-banner--success">
                    <div style={{ marginBottom: 8, fontWeight: 600 }}>
                        {preview.length} tool{preview.length !== 1 ? 's' : ''} found — click Install to persist
                    </div>
                    {preview.slice(0, 20).map(t => (
                        <div key={t.name} style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 4 }}>
                            <code className="qx-code">{t.name}</code>
                            <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>{t.description}</span>
                        </div>
                    ))}
                    {preview.length > 20 && (
                        <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>...and {preview.length - 20} more</span>
                    )}
                </div>
            )}

            <div className="qx-row qx-row--end qx-row--tight">
                {onCancel && (
                    <button className="qx-btn qx-btn--ghost" onClick={onCancel}>Cancel</button>
                )}
                <button
                    className="qx-btn qx-btn--ghost"
                    onClick={handlePreview}
                    disabled={previewing || !hasInput}
                >
                    {previewing ? 'Previewing...' : 'Preview'}
                </button>
                <button
                    className="qx-btn qx-btn--primary"
                    onClick={handleInstall}
                    disabled={installing || !hasInput}
                >
                    {installing ? 'Installing...' : 'Install'}
                </button>
            </div>
        </div>
    );
}

export default OpenApiInstallPanel;
