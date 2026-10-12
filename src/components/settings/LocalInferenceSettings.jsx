/**
 * LocalInferenceSettings — Settings panel for managing local inference sources
 *
 * Allows users to add, test, and manage connections to self-hosted LLM
 * inference servers (Ollama, vLLM, llama.cpp, NVIDIA NIM).
 *
 * Part of the Local Inference plugin (beta).
 */

import { useState, useEffect, useCallback } from 'react';
import { registerDynamicProvider, unregisterDynamicProvider } from '../../config/modelCatalog';

const COLLECTOR_BASE = window.location.origin;

const BACKEND_OPTIONS = [
    { value: 'auto', label: 'Auto-detect' },
    { value: 'ollama', label: 'Ollama' },
    { value: 'vllm', label: 'vLLM' },
    { value: 'llamacpp', label: 'llama.cpp' },
    { value: 'nim', label: 'NVIDIA NIM' }
];

function generateSourceId() {
    return 'src_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export default function LocalInferenceSettings({ onNotification }) {
    const [sources, setSources] = useState([]);
    const [loading, setLoading] = useState(true);
    const [showAddForm, setShowAddForm] = useState(false);
    const [testResult, setTestResult] = useState(null);
    const [testing, setTesting] = useState(false);

    // Form state
    const [formName, setFormName] = useState('');
    const [formUrl, setFormUrl] = useState('');
    const [formBackend, setFormBackend] = useState('auto');
    const [formToken, setFormToken] = useState('');
    const [formResidency, setFormResidency] = useState('local');

    const notify = useCallback((msg, type = 'info') => {
        onNotification?.({ message: msg, type });
    }, [onNotification]);

    // Sync sources to dynamic model catalog
    const syncToCatalog = useCallback((sourceList) => {
        if (!sourceList || sourceList.length === 0) {
            unregisterDynamicProvider('local');
            return;
        }
        const models = {};
        for (const src of sourceList) {
            if (src.models && src.models.length > 0) {
                for (const m of src.models) {
                    const modelId = m.id || m.name;
                    models[modelId] = { name: m.name || modelId, contextWindow: 8192 };
                }
            }
        }
        if (Object.keys(models).length > 0) {
            registerDynamicProvider('local', {
                name: 'Local Inference',
                models,
                defaultModel: Object.keys(models)[0]
            });
        }
    }, []);

    // Load sources from collector
    const loadSources = useCallback(async () => {
        try {
            const res = await fetch(`${COLLECTOR_BASE}/api/v1/local-inference/sources`);
            if (res.ok) {
                const data = await res.json();
                const sourceList = data.sources || [];
                setSources(sourceList);
                syncToCatalog(sourceList);
            }
        } catch (err) {
            console.error('[LocalInference] Failed to load sources:', err);
        } finally {
            setLoading(false);
        }
    }, [syncToCatalog]);

    useEffect(() => { loadSources(); }, [loadSources]);

    // Test connection
    const handleTest = async () => {
        if (!formUrl) return;
        setTesting(true);
        setTestResult(null);
        try {
            const res = await fetch(`${COLLECTOR_BASE}/api/v1/local-inference/test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ baseUrl: formUrl, backendType: formBackend, authToken: formToken || null })
            });
            const data = await res.json();
            setTestResult(data);
        } catch (err) {
            setTestResult({ success: false, error: err.message });
        } finally {
            setTesting(false);
        }
    };

    // Add source
    const handleAdd = async () => {
        if (!formName || !formUrl) {
            notify('Name and URL are required', 'error');
            return;
        }
        try {
            const res = await fetch(`${COLLECTOR_BASE}/api/v1/local-inference/sources`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: generateSourceId(),
                    name: formName,
                    baseUrl: formUrl,
                    backendType: testResult?.backendType || formBackend,
                    authToken: formToken || null,
                    dataResidencyTag: formResidency,
                    defaultChatModel: testResult?.models?.[0]?.id || null
                })
            });
            if (res.ok) {
                notify(`Source "${formName}" added`, 'success');
                resetForm();
                loadSources();
            } else {
                const err = await res.json();
                notify(err.error || 'Failed to add source', 'error');
            }
        } catch (err) {
            notify('Failed to add source: ' + err.message, 'error');
        }
    };

    // Delete source
    const handleDelete = async (id, name) => {
        try {
            const res = await fetch(`${COLLECTOR_BASE}/api/v1/local-inference/sources/${id}`, { method: 'DELETE' });
            if (res.ok) {
                notify(`Source "${name}" removed`, 'info');
                loadSources();
            }
        } catch (err) {
            notify('Failed to remove source', 'error');
        }
    };

    const resetForm = () => {
        setShowAddForm(false);
        setFormName('');
        setFormUrl('');
        setFormBackend('auto');
        setFormToken('');
        setFormResidency('local');
        setTestResult(null);
    };

    return (
        <div style={{ maxWidth: 800 }}>
            {/* Header */}
            <div style={{ marginBottom: 24 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                    <h2 style={{ margin: 0, fontSize: 20, color: 'var(--text-primary, #f5f5f5)' }}>
                        Local Inference
                    </h2>
                    <span style={{
                        fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4,
                        background: 'rgba(34, 197, 94, 0.15)', color: '#22c55e', letterSpacing: 0.5
                    }}>BETA</span>
                </div>
                <p style={{ margin: 0, fontSize: 14, color: 'var(--text-secondary, #a1a1aa)', lineHeight: 1.5 }}>
                    Connect to self-hosted LLM servers running on your own hardware. Supports Ollama, vLLM, llama.cpp, and NVIDIA NIM.
                    All features are free during the public beta.
                </p>
            </div>

            {/* Source list */}
            {loading ? (
                <p style={{ color: 'var(--text-secondary, #a1a1aa)' }}>Loading sources...</p>
            ) : sources.length === 0 && !showAddForm ? (
                <div style={{
                    padding: 32, textAlign: 'center', border: '1px dashed rgba(255,255,255,0.1)',
                    borderRadius: 8, marginBottom: 16
                }}>
                    <p style={{ color: 'var(--text-secondary, #a1a1aa)', margin: '0 0 12px' }}>
                        No inference sources configured. Add a connection to get started.
                    </p>
                </div>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
                    {sources.map(source => (
                        <div key={source.id} style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                            padding: '12px 16px', background: 'rgba(255,255,255,0.03)',
                            borderRadius: 8, border: '1px solid rgba(255,255,255,0.06)'
                        }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                <span style={{
                                    width: 8, height: 8, borderRadius: '50%',
                                    background: source.healthy === true ? '#22c55e' : source.healthy === false ? '#ef4444' : '#71717a'
                                }} />
                                <div>
                                    <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary, #f5f5f5)' }}>
                                        {source.name}
                                    </div>
                                    <div style={{ fontSize: 12, color: 'var(--text-secondary, #a1a1aa)' }}>
                                        {source.baseUrl} | {source.backendType} | {source.dataResidencyTag || 'local'}
                                    </div>
                                </div>
                            </div>
                            <button
                                onClick={() => handleDelete(source.id, source.name)}
                                style={{
                                    background: 'none', border: '1px solid rgba(239,68,68,0.3)',
                                    color: '#ef4444', padding: '4px 12px', borderRadius: 4,
                                    cursor: 'pointer', fontSize: 12
                                }}
                            >
                                ✕ Remove
                            </button>
                        </div>
                    ))}
                </div>
            )}

            {/* Add button */}
            {!showAddForm && (
                <button
                    onClick={() => setShowAddForm(true)}
                    style={{
                        display: 'flex', alignItems: 'center', gap: 6,
                        background: 'rgba(34, 197, 94, 0.1)', border: '1px solid rgba(34, 197, 94, 0.3)',
                        color: '#22c55e', padding: '8px 16px', borderRadius: 6,
                        cursor: 'pointer', fontSize: 14, fontWeight: 500
                    }}
                >
                    + Add Inference Source
                </button>
            )}

            {/* Add form */}
            {showAddForm && (
                <div style={{
                    padding: 20, background: 'rgba(255,255,255,0.02)',
                    borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)',
                    marginTop: 12
                }}>
                    <h3 style={{ margin: '0 0 16px', fontSize: 16, color: 'var(--text-primary, #f5f5f5)' }}>
                        Add Inference Source
                    </h3>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                        {/* Name */}
                        <div>
                            <label style={labelStyle}>Source Name</label>
                            <input
                                type="text" value={formName} onChange={e => setFormName(e.target.value)}
                                placeholder="e.g. Office GPU, ML Cluster"
                                style={inputStyle}
                            />
                        </div>

                        {/* URL */}
                        <div>
                            <label style={labelStyle}>Base URL</label>
                            <input
                                type="text" value={formUrl} onChange={e => setFormUrl(e.target.value)}
                                placeholder="e.g. http://192.168.1.100:11434"
                                style={inputStyle}
                            />
                        </div>

                        {/* Backend type */}
                        <div>
                            <label style={labelStyle}>Backend Type</label>
                            <select value={formBackend} onChange={e => setFormBackend(e.target.value)} style={inputStyle}>
                                {BACKEND_OPTIONS.map(opt => (
                                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                                ))}
                            </select>
                        </div>

                        {/* Auth token */}
                        <div>
                            <label style={labelStyle}>Auth Token (optional)</label>
                            <input
                                type="password" value={formToken} onChange={e => setFormToken(e.target.value)}
                                placeholder="Bearer token if server requires auth"
                                style={inputStyle}
                            />
                        </div>

                        {/* Data residency */}
                        <div>
                            <label style={labelStyle}>Data Residency Tag</label>
                            <input
                                type="text" value={formResidency} onChange={e => setFormResidency(e.target.value)}
                                placeholder="e.g. local, on-prem, EU-west"
                                style={inputStyle}
                            />
                        </div>

                        {/* Test connection */}
                        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                            <button
                                onClick={handleTest}
                                disabled={!formUrl || testing}
                                style={{
                                    ...buttonStyle,
                                    background: 'rgba(59, 130, 246, 0.1)',
                                    borderColor: 'rgba(59, 130, 246, 0.3)',
                                    color: '#3b82f6',
                                    opacity: (!formUrl || testing) ? 0.5 : 1
                                }}
                            >
                                {testing ? '...' : '&#9889;'} Test Connection
                            </button>
                            <button onClick={handleAdd} disabled={!formName || !formUrl} style={{
                                ...buttonStyle,
                                background: 'rgba(34, 197, 94, 0.1)',
                                borderColor: 'rgba(34, 197, 94, 0.3)',
                                color: '#22c55e',
                                opacity: (!formName || !formUrl) ? 0.5 : 1
                            }}>
                                + Add Source
                            </button>
                            <button onClick={resetForm} style={{
                                ...buttonStyle,
                                background: 'none',
                                borderColor: 'rgba(255,255,255,0.1)',
                                color: 'var(--text-secondary, #a1a1aa)'
                            }}>
                                Cancel
                            </button>
                        </div>

                        {/* Test result */}
                        {testResult && (
                            <div style={{
                                padding: 12, borderRadius: 6, marginTop: 4,
                                background: testResult.success ? 'rgba(34,197,94,0.05)' : 'rgba(239,68,68,0.05)',
                                border: `1px solid ${testResult.success ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'}`
                            }}>
                                {testResult.success ? (
                                    <div>
                                        <div style={{ fontSize: 13, fontWeight: 500, color: '#22c55e', marginBottom: 6 }}>
                                            Connected ({testResult.latencyMs}ms) | Backend: {testResult.backendType} | {testResult.modelCount} model{testResult.modelCount !== 1 ? 's' : ''}
                                        </div>
                                        {testResult.models?.length > 0 && (
                                            <div style={{ fontSize: 12, color: 'var(--text-secondary, #a1a1aa)' }}>
                                                Models: {testResult.models.map(m => m.name || m.id).join(', ')}
                                            </div>
                                        )}
                                    </div>
                                ) : (
                                    <div style={{ fontSize: 13, color: '#ef4444' }}>
                                        Connection failed: {testResult.error}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Info box */}
            <div style={{
                marginTop: 24, padding: 16, borderRadius: 8,
                background: 'rgba(34, 197, 94, 0.03)',
                border: '1px solid rgba(34, 197, 94, 0.1)'
            }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: '#22c55e', marginBottom: 8 }}>
                    Supported backends
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary, #a1a1aa)', lineHeight: 1.6 }}>
                    <strong style={{ color: 'var(--text-primary, #f5f5f5)' }}>Ollama</strong> (port 11434) — Easiest setup, best for workstations<br />
                    <strong style={{ color: 'var(--text-primary, #f5f5f5)' }}>vLLM</strong> (port 8000) — High performance, best for multi-user<br />
                    <strong style={{ color: 'var(--text-primary, #f5f5f5)' }}>llama.cpp</strong> (port 8080) — Lightweight, good for experiments<br />
                    <strong style={{ color: 'var(--text-primary, #f5f5f5)' }}>NVIDIA NIM</strong> (port 8000) — Enterprise microservice
                </div>
            </div>
        </div>
    );
}

// Shared styles
const labelStyle = {
    display: 'block', fontSize: 12, fontWeight: 500,
    color: 'var(--text-secondary, #a1a1aa)', marginBottom: 4
};

const inputStyle = {
    width: '100%', padding: '8px 12px', fontSize: 14,
    background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 6, color: 'var(--text-primary, #f5f5f5)',
    outline: 'none', boxSizing: 'border-box'
};

const buttonStyle = {
    display: 'flex', alignItems: 'center', gap: 4,
    padding: '6px 14px', borderRadius: 6, border: '1px solid',
    cursor: 'pointer', fontSize: 13, fontWeight: 500, background: 'none'
};
