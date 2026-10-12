/**
 * AddToolModal — STUDY-REV-2/P1.A + P4.A + P4.B
 *
 * Four-tab modal for registering tools:
 *   - OpenAPI 3.x spec (collector toolDefinitionsStore)
 *   - MCP server (collector toolDefinitionsStore)
 *   - Git repo (auth service tool_definitions + pending sandbox build)
 *   - Script (auth service tool_definitions + pending sandbox build)
 *
 * Glass-design-system compliant. Uses .qx-modal-overlay / .qx-modal,
 * .qx-tabs, .qx-seg, .qx-field, .qx-input, .qx-textarea, .qx-banner,
 * .qx-btn. Inline styles ≤ 5 (only maxWidth + resize:vertical).
 */

import { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import InstallRepoPanel from './InstallRepoPanel';
import InstallScriptPanel from './InstallScriptPanel';

function AddToolModal({ onClose, onSuccess }) {
    const { authFetch } = useAuth();
    const { currentOrg } = useWorkspace();

    const [activeTab, setActiveTab] = useState('openapi');

    // OpenAPI tab state
    const [openapiMode, setOpenapiMode] = useState('url'); // 'url' | 'json'
    const [specUrl, setSpecUrl] = useState('');
    const [specJson, setSpecJson] = useState('');
    const [preview, setPreview] = useState(null);
    const [previewing, setPreviewing] = useState(false);
    const [installing, setInstalling] = useState(false);
    const [openApiError, setOpenApiError] = useState(null);

    // MCP tab state
    const [mcpName, setMcpName] = useState('');
    const [mcpUri, setMcpUri] = useState('');
    const [mcpTransport, setMcpTransport] = useState('http');
    const [mcpToolsJson, setMcpToolsJson] = useState('');
    const [mcpError, setMcpError] = useState(null);
    const [mcpInstalling, setMcpInstalling] = useState(false);

    const [successMessage, setSuccessMessage] = useState(null);

    // OpenAPI: client-side validation
    function validateOpenApi() {
        if (openapiMode === 'url') {
            if (!specUrl.startsWith('https://')) {
                setOpenApiError('URL must start with https://');
                return false;
            }
        } else {
            try {
                JSON.parse(specJson);
            } catch {
                setOpenApiError('Invalid JSON — paste a valid OpenAPI 3.x spec');
                return false;
            }
        }
        setOpenApiError(null);
        return true;
    }

    async function handlePreview() {
        if (!validateOpenApi()) return;
        setPreviewing(true);
        setOpenApiError(null);
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
                setOpenApiError(data.message || data.error || 'Preview failed');
                return;
            }
            setPreview(data.registered || []);
        } catch (err) {
            setOpenApiError(err.message);
        } finally {
            setPreviewing(false);
        }
    }

    async function handleInstallOpenApi() {
        if (!validateOpenApi()) return;
        setInstalling(true);
        setOpenApiError(null);
        try {
            const body = openapiMode === 'url'
                ? { spec: specUrl }
                : { spec: JSON.parse(specJson) };
            const resp = await authFetch('/collector/api/tools/register-openapi', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const data = await resp.json();
            if (!resp.ok) {
                setOpenApiError(data.message || data.error || 'Registration failed');
                return;
            }
            setSuccessMessage(`Registered ${data.registered?.length || 0} tool${data.registered?.length !== 1 ? 's' : ''}${data.skipped?.length > 0 ? `, skipped ${data.skipped.length}` : ''}`);
            onSuccess?.();
        } catch (err) {
            setOpenApiError(err.message);
        } finally {
            setInstalling(false);
        }
    }

    async function handleInstallMcp() {
        setMcpError(null);
        if (!mcpName.trim()) { setMcpError('Name is required'); return; }
        if (!mcpUri.trim()) { setMcpError('URI is required'); return; }

        let tools = undefined;
        if (mcpToolsJson.trim()) {
            try {
                tools = JSON.parse(mcpToolsJson);
                if (!Array.isArray(tools)) { setMcpError('Tools JSON must be an array'); return; }
            } catch {
                setMcpError('Invalid tools JSON — must be an array of {name, description, input_schema}');
                return;
            }
        }

        setMcpInstalling(true);
        try {
            const resp = await authFetch('/collector/api/tools/register-mcp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: mcpName, uri: mcpUri, transport: mcpTransport, tools }),
            });
            const data = await resp.json();
            if (!resp.ok) {
                setMcpError(data.message || data.error || 'Registration failed');
                return;
            }
            setSuccessMessage(`MCP server registered: ${data.registered?.length || 0} tool${data.registered?.length !== 1 ? 's' : ''}`);
            onSuccess?.();
        } catch (err) {
            setMcpError(err.message);
        } finally {
            setMcpInstalling(false);
        }
    }

    if (successMessage) {
        return (
            <div className="qx-modal-overlay" onClick={onClose}>
                <div className="qx-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '520px' }}>
                    <div className="qx-modal__header">
                        <h2>Tool Registered</h2>
                        <button className="qx-btn qx-btn--ghost qx-btn--sm" onClick={onClose}>✕</button>
                    </div>
                    <div className="qx-modal__success">
                        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <circle cx="12" cy="12" r="10" stroke="#22c55e" strokeWidth="2"/>
                            <path d="M8 12l3 3 5-5" stroke="#22c55e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                        <p>{successMessage}</p>
                        <p className="qx-modal__hint">
                            Tools appear in the Installed tab. The executor is pending P3 (Tools Deep).
                        </p>
                        <button className="qx-btn qx-btn--primary" onClick={onClose}>Done</button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="qx-modal-overlay" onClick={onClose}>
            <div className="qx-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '620px' }}>
                {/* Header */}
                <div className="qx-modal__header">
                    <h2>Add Tool</h2>
                    <button className="qx-btn qx-btn--ghost qx-btn--sm" onClick={onClose}>✕</button>
                </div>

                {/* Tab selector */}
                <nav className="qx-tabs">
                    <button
                        className={`qx-tab${activeTab === 'openapi' ? ' qx-tab--active' : ''}`}
                        onClick={() => setActiveTab('openapi')}
                    >
                        OpenAPI
                    </button>
                    <button
                        className={`qx-tab${activeTab === 'mcp' ? ' qx-tab--active' : ''}`}
                        onClick={() => setActiveTab('mcp')}
                    >
                        MCP Server
                    </button>
                    <button
                        className={`qx-tab${activeTab === 'repo' ? ' qx-tab--active' : ''}`}
                        onClick={() => setActiveTab('repo')}
                    >
                        Repo
                    </button>
                    <button
                        className={`qx-tab${activeTab === 'script' ? ' qx-tab--active' : ''}`}
                        onClick={() => setActiveTab('script')}
                    >
                        Script
                    </button>
                </nav>

                {/* ── OpenAPI tab ── */}
                {activeTab === 'openapi' && (
                    <div className="qx-modal__body">
                        <p className="qx-modal__desc">
                            Register tools from an OpenAPI 3.x specification. Each operation becomes a callable tool.
                        </p>

                        {/* Mode toggle */}
                        <div className="qx-seg">
                            <button
                                className={`qx-seg__btn${openapiMode === 'url' ? ' qx-seg__btn--active' : ''}`}
                                onClick={() => { setOpenapiMode('url'); setPreview(null); setOpenApiError(null); }}
                            >
                                URL
                            </button>
                            <button
                                className={`qx-seg__btn${openapiMode === 'json' ? ' qx-seg__btn--active' : ''}`}
                                onClick={() => { setOpenapiMode('json'); setPreview(null); setOpenApiError(null); }}
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
                                    onChange={e => { setSpecUrl(e.target.value); setPreview(null); setOpenApiError(null); }}
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
                                    onChange={e => { setSpecJson(e.target.value); setPreview(null); setOpenApiError(null); }}
                                    rows={8}
                                    style={{ resize: 'vertical' }}
                                />
                            </div>
                        )}

                        {openApiError && (
                            <div className="qx-banner qx-banner--error">
                                {openApiError}
                            </div>
                        )}

                        {preview && (
                            <div className="qx-banner qx-banner--success qx-modal__preview">
                                <span className="qx-modal__preview-count">
                                    {preview.length} tool{preview.length !== 1 ? 's' : ''} found — click Install to persist
                                </span>
                                {preview.slice(0, 20).map(t => (
                                    <div key={t.name} className="qx-modal__preview-item">
                                        <code className="qx-code">{t.name}</code>
                                        <span className="qx-modal__preview-desc">{t.description}</span>
                                    </div>
                                ))}
                                {preview.length > 20 && (
                                    <span className="qx-modal__preview-desc">...and {preview.length - 20} more</span>
                                )}
                            </div>
                        )}

                        <div className="qx-modal__actions">
                            <button className="qx-btn qx-btn--ghost" onClick={onClose}>Cancel</button>
                            <button
                                className="qx-btn qx-btn--ghost"
                                onClick={handlePreview}
                                disabled={previewing || (!specUrl && !specJson)}
                            >
                                {previewing ? 'Previewing...' : 'Preview'}
                            </button>
                            <button
                                className="qx-btn qx-btn--primary"
                                onClick={handleInstallOpenApi}
                                disabled={installing || (!specUrl && !specJson)}
                            >
                                {installing ? 'Installing...' : 'Install'}
                            </button>
                        </div>
                    </div>
                )}

                {/* ── MCP tab ── */}
                {activeTab === 'mcp' && (
                    <div className="qx-modal__body">
                        <p className="qx-modal__desc">
                            Register an MCP server. Declare tools manually — auto-discovery ships in P4.
                        </p>

                        <div className="qx-grid-2">
                            <div className="qx-field">
                                <label className="qx-field__label qx-field__label--required">Server Name</label>
                                <input
                                    type="text"
                                    className="qx-input"
                                    placeholder="my-mcp-server"
                                    value={mcpName}
                                    onChange={e => { setMcpName(e.target.value); setMcpError(null); }}
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
                                onChange={e => { setMcpUri(e.target.value); setMcpError(null); }}
                            />
                        </div>

                        <div className="qx-field">
                            <label className="qx-field__label">Declared Tools (optional JSON array)</label>
                            <textarea
                                className="qx-textarea qx-input--mono"
                                placeholder={'[\n  { "name": "my_tool", "description": "Does X", "input_schema": {"type":"object","properties":{},"required":[]} }\n]'}
                                value={mcpToolsJson}
                                onChange={e => { setMcpToolsJson(e.target.value); setMcpError(null); }}
                                rows={5}
                                style={{ resize: 'vertical' }}
                            />
                            <span className="qx-field__hint">
                                Leave empty to register a placeholder. Auto-discovery ships in P4.
                            </span>
                        </div>

                        {mcpError && (
                            <div className="qx-banner qx-banner--error">
                                {mcpError}
                            </div>
                        )}

                        <div className="qx-modal__actions">
                            <button className="qx-btn qx-btn--ghost" onClick={onClose}>Cancel</button>
                            <button
                                className="qx-btn qx-btn--primary"
                                onClick={handleInstallMcp}
                                disabled={mcpInstalling}
                            >
                                {mcpInstalling ? 'Registering...' : 'Register'}
                            </button>
                        </div>
                    </div>
                )}

                {/* ── Repo tab ── */}
                {activeTab === 'repo' && (
                    <div className="qx-modal__body">
                        <InstallRepoPanel
                            onSuccess={(tool) => {
                                setSuccessMessage(`Repo tool registered: ${tool?.name || 'unknown'} (status: pending sandbox build)`);
                                onSuccess?.();
                            }}
                            onCancel={onClose}
                        />
                    </div>
                )}

                {/* ── Script tab ── */}
                {activeTab === 'script' && (
                    <div className="qx-modal__body">
                        <InstallScriptPanel
                            onSuccess={(tool) => {
                                setSuccessMessage(`Script tool registered: ${tool?.name || 'unknown'} (status: pending sandbox build)`);
                                onSuccess?.();
                            }}
                            onCancel={onClose}
                        />
                    </div>
                )}
            </div>
        </div>
    );
}

export default AddToolModal;
