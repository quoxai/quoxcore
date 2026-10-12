/**
 * InstallScriptPanel — STUDY-REV-2/P4.B
 *
 * Register a tool from an inline script body (Python, Node, or Bash).
 * Pattern-matches InstallRepoPanel exactly.
 *
 * Accepts onSuccess(tool) and onCancel callbacks.
 * Used by AddToolModal (Script tab).
 *
 * On submit:
 *   1. Base64-encode the script body in JS.
 *   2. POST /api/orgs/:orgId/tool-library/from-script  (auth service)
 *   3. installToolToScope(tool.tool_id)                 (auto-links to current org scope)
 *
 * Fields:
 *   - Name (required)
 *   - Description (textarea, optional)
 *   - Language (select: Python / Node / Bash)
 *   - Script body (large monospace textarea)
 *   - Sandbox profile (select: default / network-allowed / filesystem-rw)
 *   - Entrypoint (text, optional)
 *   - Category (with "+ Create new…" affordance, mirrors InstallRepoPanel)
 */

import { useState, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { listCategories, createCategory } from '../../services/toolCategoriesClient';
import { installToolToScope } from '../../services/toolInstallScopeClient';

const LANGUAGE_OPTIONS = [
    { value: 'python', label: 'Python' },
    { value: 'node', label: 'Node' },
    { value: 'bash', label: 'Bash' },
];

const SANDBOX_OPTIONS = [
    { value: 'default', label: 'default — restricted sandbox' },
    { value: 'network-allowed', label: 'network-allowed — sandbox with egress' },
    { value: 'filesystem-rw', label: 'filesystem-rw — sandbox with disk access' },
];

const ENTRYPOINT_DEFAULTS = {
    python: 'main.py',
    node: 'index.js',
    bash: 'run.sh',
};

function InstallScriptPanel({ onSuccess, onCancel }) {
    const { authFetch } = useAuth();
    const { currentOrg } = useWorkspace();

    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [language, setLanguage] = useState('python');
    const [scriptBody, setScriptBody] = useState('');
    const [sandboxProfile, setSandboxProfile] = useState('default');
    const [entrypoint, setEntrypoint] = useState('main.py');
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
            .catch(err => console.warn('[InstallScriptPanel] Categories load failed:', err.message));
    }, [authFetch, currentOrg?.id]);

    // Update default entrypoint when language changes
    function handleLanguageChange(lang) {
        setLanguage(lang);
        setEntrypoint(ENTRYPOINT_DEFAULTS[lang] || '');
        setError(null);
    }

    function validate() {
        if (!name.trim()) {
            setError('Name is required');
            return false;
        }
        if (!scriptBody.trim()) {
            setError('Script body is required');
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
            // Base64-encode the script body before sending
            const scriptBodyB64 = btoa(unescape(encodeURIComponent(scriptBody)));

            const resp = await authFetch(`/api/orgs/${orgId}/tool-library/from-script`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: name.trim(),
                    description: description.trim() || undefined,
                    language,
                    script_body_b64: scriptBodyB64,
                    sandbox_profile: sandboxProfile,
                    entrypoint: entrypoint.trim() || undefined,
                    category_id: selectedCategoryId,
                }),
            });
            const data = await resp.json();
            if (!resp.ok) {
                // 409 = already registered — treat as soft success info
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
                    console.warn('[InstallScriptPanel] install-to-scope failed (non-fatal):', scopeErr.message);
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

    const hasInput = !!name.trim() && !!scriptBody.trim();

    return (
        <div className="qx-stack">
            <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: 14, margin: 0 }}>
                Register a tool from an inline script. The script is stored as beta — execution
                requires the Toolsmith sandbox agent (ships separately).
            </p>

            <div className="qx-grid-2">
                {/* Name */}
                <div className="qx-field">
                    <label className="qx-field__label qx-field__label--required">Tool Name</label>
                    <input
                        type="text"
                        className="qx-input"
                        placeholder="my-script-tool"
                        value={name}
                        onChange={e => { setName(e.target.value); setError(null); }}
                    />
                    <span className="qx-field__hint">Alphanumeric, hyphens, underscores</span>
                </div>

                {/* Language */}
                <div className="qx-field">
                    <label className="qx-field__label qx-field__label--required">Language</label>
                    <select
                        className="qx-select"
                        value={language}
                        onChange={e => handleLanguageChange(e.target.value)}
                    >
                        {LANGUAGE_OPTIONS.map(opt => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                    </select>
                </div>
            </div>

            {/* Description */}
            <div className="qx-field">
                <label className="qx-field__label">Description</label>
                <textarea
                    className="qx-textarea"
                    placeholder="What this tool does…"
                    value={description}
                    onChange={e => { setDescription(e.target.value); setError(null); }}
                    rows={2}
                />
            </div>

            {/* Script body */}
            <div className="qx-field">
                <label className="qx-field__label qx-field__label--required">Script Body</label>
                <textarea
                    className="qx-textarea"
                    placeholder={language === 'python'
                        ? 'def main():\n    return {"result": "hello"}'
                        : language === 'node'
                        ? 'module.exports = async function main() {\n    return { result: "hello" };\n};'
                        : '#!/usr/bin/env bash\necho "hello"'}
                    value={scriptBody}
                    onChange={e => { setScriptBody(e.target.value); setError(null); }}
                    rows={10}
                    style={{ fontFamily: 'ui-monospace, monospace' }}
                />
                <span className="qx-field__hint">
                    Stored securely as base64. Execution requires the Toolsmith sandbox.
                </span>
            </div>

            <div className="qx-grid-2">
                {/* Sandbox profile */}
                <div className="qx-field">
                    <label className="qx-field__label">Sandbox Profile</label>
                    <select
                        className="qx-select"
                        value={sandboxProfile}
                        onChange={e => { setSandboxProfile(e.target.value); setError(null); }}
                    >
                        {SANDBOX_OPTIONS.map(opt => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                    </select>
                </div>

                {/* Entrypoint */}
                <div className="qx-field">
                    <label className="qx-field__label">Entrypoint</label>
                    <input
                        type="text"
                        className="qx-input"
                        placeholder={ENTRYPOINT_DEFAULTS[language]}
                        value={entrypoint}
                        onChange={e => { setEntrypoint(e.target.value); setError(null); }}
                    />
                    <span className="qx-field__hint">File name for the executor to invoke</span>
                </div>
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

export default InstallScriptPanel;
