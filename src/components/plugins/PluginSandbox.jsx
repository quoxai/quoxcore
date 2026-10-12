/**
 * PluginSandbox — ErrorBoundary + scoped SDK context for TRUSTED (official) plugins.
 *
 * NAME CAVEAT (QuoxTrust F2): despite the name, this is NOT a security sandbox — it is
 * an ErrorBoundary plus a React-context API for a plugin that runs IN the parent
 * document. That is safe ONLY for signature-verified official first-party bundles.
 * UNTRUSTED (non-official) plugins never reach this component: they run in a real
 * opaque-origin sandboxed iframe via pluginFrameHost.js / PluginFrameView.jsx (no parent
 * DOM/cookies/network, mediated postMessage RPC). Do not route untrusted code here.
 *
 * Wraps a plugin component mount point (and, for the isolated path, the PluginFrameView
 * that hosts the iframe). Catches render errors and provides the scoped API context that
 * in-parent official plugins consume.
 */

import { Component, createContext, useContext, useMemo } from 'react';
import { getPluginConfig, savePluginConfig } from '../../services/pluginConfigStorage';
import { getHostAuthContext } from '../../services/hostAuthContext';

// ── Plugin API Context ────────────────────────────────────────────────────

const PluginAPIContext = createContext(null);

/**
 * Hook for plugins to access the scoped API.
 * @returns {PluginAPI}
 */
export function usePluginApi() {
    const api = useContext(PluginAPIContext);
    if (!api) throw new Error('usePluginApi must be used within a PluginSandbox');
    return api;
}

/**
 * Build a scoped plugin API object.
 * All calls are namespaced to the plugin — plugins cannot access other plugins' data.
 */
function createPluginApi(pluginId) {
    const STORAGE_PREFIX = `plugin-data-${pluginId}`;
    const COLLECTOR_BASE = window.__quoxCollectorUrl || '/collector';

    return {
        pluginId,

        // PSDK-5: Scoped storage (server-side SQLite, namespaced per plugin + org)
        storage: {
            async get(key) {
                try {
                    const res = await fetch(`${COLLECTOR_BASE}/api/v1/plugins/${pluginId}/storage/${encodeURIComponent(key)}`, { credentials: 'include' });
                    const data = await res.json();
                    return data.value;
                } catch { return null; }
            },
            async set(key, value) {
                await fetch(`${COLLECTOR_BASE}/api/v1/plugins/${pluginId}/storage/${encodeURIComponent(key)}`, {
                    method: 'PUT', credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ value }),
                });
            },
            async remove(key) {
                await fetch(`${COLLECTOR_BASE}/api/v1/plugins/${pluginId}/storage/${encodeURIComponent(key)}`, {
                    method: 'DELETE', credentials: 'include',
                });
            },
            async keys() {
                try {
                    const res = await fetch(`${COLLECTOR_BASE}/api/v1/plugins/${pluginId}/storage`, { credentials: 'include' });
                    const data = await res.json();
                    return Object.keys(data.data || {});
                } catch { return []; }
            },
            async getAll() {
                try {
                    const res = await fetch(`${COLLECTOR_BASE}/api/v1/plugins/${pluginId}/storage`, { credentials: 'include' });
                    const data = await res.json();
                    return data.data || {};
                } catch { return {}; }
            },
        },

        // Plugin config (uses existing pluginConfigStorage)
        config: {
            get() { return getPluginConfig(pluginId); },
            save(config) { return savePluginConfig(pluginId, config); },
        },

        // Proxied fetch — routes through collector plugin gateway
        async fetch(path, options = {}) {
            const url = `${COLLECTOR_BASE}/api/v1/plugins/${pluginId}${path.startsWith('/') ? path : '/' + path}`;
            const res = await fetch(url, {
                ...options,
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/json',
                    ...options.headers,
                },
            });
            return res;
        },

        // Notifications — dispatches event for any global listener.
        // Also logs to console for visibility during Phase 1.
        notify(message, type = 'info') {
            console.log(`[Plugin:${pluginId}] ${type}: ${message}`);
            window.dispatchEvent(new CustomEvent('quox-notification', {
                detail: { message, type, source: pluginId }
            }));
        },

        // Memory access (permission-gated by backend)
        memory: {
            async save(entry) {
                const res = await fetch(`${COLLECTOR_BASE}/api/v1/memory`, {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ...entry, source: `plugin:${pluginId}` }),
                });
                return res.json();
            },
            async search(query, limit = 10) {
                const res = await fetch(`${COLLECTOR_BASE}/api/v1/memory/search`, {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ query, limit, source: `plugin:${pluginId}` }),
                });
                return res.json();
            },
        },

        // PSDK-4: Navigation
        navigate(path) {
            window.dispatchEvent(new CustomEvent('quox-navigate', { detail: { path } }));
        },

        // PSDK-4: Current user context
        getUser() {
            // #770: real host-side source (WorkspaceContext publishes it), not the dead
            // 'quox-auth-state' key.
            return getHostAuthContext();
        },

        // PSDK-4: Chat integration — open sidebar chat with an agent
        chat: {
            openSidebar(agentId, options = {}) {
                window.dispatchEvent(new CustomEvent('quox-open-agent-chat', {
                    detail: { agentId, ...options }
                }));
            },
        },

        // AEE envelope emission (permission-gated by backend)
        aee: {
            async emit(intent, payload) {
                const res = await fetch(`${COLLECTOR_BASE}/api/v1/envelopes`, {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        type: 'event',
                        intent,
                        payload,
                        from: `plugin.${pluginId}`,
                    }),
                });
                return res.json();
            },
        },
    };
}

// ── Error Boundary ────────────────────────────────────────────────────────

class PluginErrorBoundary extends Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false, error: null };
    }

    static getDerivedStateFromError(error) {
        return { hasError: true, error };
    }

    componentDidCatch(error, info) {
        console.error(`[PluginSandbox] Error in plugin "${this.props.pluginId}":`, error, info);
    }

    render() {
        if (this.state.hasError) {
            return (
                <div style={{
                    padding: '2rem',
                    textAlign: 'center',
                    background: 'rgba(239, 68, 68, 0.1)',
                    border: '1px solid rgba(239, 68, 68, 0.3)',
                    borderRadius: '8px',
                    margin: '1rem',
                }}>
                    <p style={{ color: 'rgba(255,255,255,0.9)', fontSize: '1rem', marginBottom: '0.5rem' }}>
                        Plugin error: {this.props.pluginId}
                    </p>
                    <p style={{ color: 'rgba(255,255,255,0.6)', fontSize: '0.85rem', marginBottom: '1rem' }}>
                        {this.state.error?.message || 'An unexpected error occurred'}
                    </p>
                    <button
                        onClick={() => {
                            if (this.props.onDisable) this.props.onDisable();
                        }}
                        style={{
                            padding: '6px 16px',
                            background: 'rgba(239, 68, 68, 0.2)',
                            border: '1px solid rgba(239, 68, 68, 0.4)',
                            borderRadius: '6px',
                            color: 'rgba(255,255,255,0.8)',
                            cursor: 'pointer',
                            marginRight: '8px',
                        }}
                    >
                        Disable Plugin
                    </button>
                    <button
                        onClick={() => this.setState({ hasError: false, error: null })}
                        style={{
                            padding: '6px 16px',
                            background: 'rgba(255,255,255,0.1)',
                            border: '1px solid rgba(255,255,255,0.2)',
                            borderRadius: '6px',
                            color: 'rgba(255,255,255,0.8)',
                            cursor: 'pointer',
                        }}
                    >
                        Retry
                    </button>
                </div>
            );
        }
        return this.props.children;
    }
}

// ── PluginSandbox Component ───────────────────────────────────────────────

/**
 * Wrap a third-party plugin component with error boundary and scoped API context.
 *
 * @param {Object} props
 * @param {string} props.pluginId - The plugin identifier
 * @param {React.ReactNode} props.children - The plugin component to render
 * @param {Function} [props.onDisable] - Called when user clicks "Disable Plugin" after error
 */
export default function PluginSandbox({ pluginId, children, onDisable }) {
    const api = useMemo(() => createPluginApi(pluginId), [pluginId]);

    // SEC-CSS-SCOPE: this is the single DOM mount boundary for every
    // third-party plugin route (see App.jsx). `data-plugin-root` gives
    // pluginCssScope.js a stable attribute to scope the plugin's injected
    // CSS to — a plugin's rules can only match elements inside this
    // subtree, never host chrome outside it.
    return (
        <div data-plugin-root={pluginId}>
            <PluginErrorBoundary pluginId={pluginId} onDisable={onDisable}>
                <PluginAPIContext.Provider value={api}>
                    {children}
                </PluginAPIContext.Provider>
            </PluginErrorBoundary>
        </div>
    );
}
