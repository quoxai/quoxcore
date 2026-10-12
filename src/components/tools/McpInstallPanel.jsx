/**
 * McpInstallPanel — STUDY-REV-2/P1.A-rebuild
 *
 * Extracted from AddToolModal's MCP tab.
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

function McpInstallPanel({ onSuccess, onCancel }) {
    const { authFetch } = useAuth();
    const { currentOrg } = useWorkspace();

    const [mcpName, setMcpName] = useState('');
    const [mcpUri, setMcpUri] = useState('');
    const [mcpTransport, setMcpTransport] = useState('http');
    const [mcpToolsJson, setMcpToolsJson] = useState('');
    const [error, setError] = useState(null);
    const [installing, setInstalling] = useState(false);

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
            .catch(err => console.warn('[McpInstallPanel] Categories load failed:', err.message));
    }, [authFetch, currentOrg?.id]);

    async function handleInstall() {
        setError(null);
        if (!mcpName.trim()) { setError('Name is required'); return; }
        if (!mcpUri.trim()) { setError('URI is required'); return; }

        let tools = undefined;
        if (mcpToolsJson.trim()) {
            try {
                tools = JSON.parse(mcpToolsJson);
                if (!Array.isArray(tools)) { setError('Tools JSON must be an array'); return; }
            } catch {
                setError('Invalid tools JSON: must be an array of {name, description, input_schema}');
                return;
            }
        }

        setInstalling(true);
        try {
            const resp = await authFetch('/collector/api/tools/register-mcp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: mcpName,
                    uri: mcpUri,
                    transport: mcpTransport,
                    tools,
                    category_id: selectedCategoryId,
                }),
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

    return (
        <div className="qx-stack">
            <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: 14, margin: 0 }}>
                Register an MCP server. Declare tools manually.
            </p>

            <div className="qx-grid-2">
                <div className="qx-field">
                    <label className="qx-field__label qx-field__label--required">Server Name</label>
                    <input
                        type="text"
                        className="qx-input"
                        placeholder="my-mcp-server"
                        value={mcpName}
                        onChange={e => { setMcpName(e.target.value); setError(null); }}
                    />
                </div>
                <div className="qx-field">
                    <label className="qx-field__label qx-field__label--required">Transport</label>
                    <div className="qx-seg">
                        {['stdio', 'http'].map(t => (
                            <button
                                key={t}
                                className={`qx-seg__btn${mcpTransport === t ? ' qx-seg__btn--active' : ''}`}
                                onClick={() => setMcpTransport(t)}
                            >
                                {t}
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            <div className="qx-field">
                <label className="qx-field__label qx-field__label--required">Server URI</label>
                <input
                    type="text"
                    className="qx-input qx-input--mono"
                    placeholder={mcpTransport === 'stdio' ? '/path/to/mcp-server' : 'http://localhost:8080'}
                    value={mcpUri}
                    onChange={e => { setMcpUri(e.target.value); setError(null); }}
                />
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
                {creatingError && <p className="qx-banner qx-banner--error" style={{ margin: '4px 0 0' }}>{creatingError}</p>}
            </div>

            <div className="qx-field">
                <label className="qx-field__label">Declared Tools (optional JSON array)</label>
                <textarea
                    className="qx-textarea qx-input--mono"
                    placeholder={'[\n  { "name": "my_tool", "description": "Does X", "input_schema": {"type":"object","properties":{},"required":[]} }\n]'}
                    value={mcpToolsJson}
                    onChange={e => { setMcpToolsJson(e.target.value); setError(null); }}
                    rows={6}
                    style={{ resize: 'vertical' }}
                />
                <span className="qx-field__hint">
                    Leave empty to register a placeholder.
                </span>
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
                    disabled={installing}
                >
                    {installing ? 'Registering...' : 'Register'}
                </button>
            </div>
        </div>
    );
}

export default McpInstallPanel;
