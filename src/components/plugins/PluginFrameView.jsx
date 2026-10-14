/**
 * PluginFrameView — QUOXTRUST F2: renders an ISOLATED (non-official) plugin's route.
 *
 * The plugin runs in a sandboxed, opaque-origin iframe (pluginFrameHost); this view is
 * just the on-screen window into it. On mount it moves the plugin's persistent iframe
 * from the offscreen holder into this container and tells the plugin which route to
 * render (a postMessage 'route' event over the mediated RPC). On unmount it returns the
 * iframe to the holder so the plugin keeps its state across navigation.
 *
 * There is deliberately NO React-component-from-the-plugin here: an untrusted plugin
 * never renders into the parent tree. This view only ever hosts the iframe.
 */
import { useEffect, useRef, useState } from 'react';
import { getPluginFrame, frameHolder } from '../../services/pluginFrameRegistry';
import { getLoadedPluginManifest } from '../../services/thirdPartyPluginHost';
import { AgentChatSidebar } from '../chat/AgentChatSidebar';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import './plugin-frame.css';

const CloseIcon = () => (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12" /></svg>
);
const ChatIcon = () => (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
);

/**
 * Host-rendered agent dock for a plugin that declares manifest.agentDefinition.
 * Same component and dock recipe as NotesQ / CalendarQ. No context from the
 * untrusted frame is ever fed to the chat (no contextBuilder).
 */
function PluginAgentDock({ pluginId, agent, onClose }) {
    const { currentOrg } = useWorkspace();
    const orgId = currentOrg?.id || 'NONE';
    const name = String(agent.name || agent.id || pluginId);
    return (
        <div className="qx-agent-dock qx-surface--backed" data-testid="plugin-agent-dock" aria-label={`${name} agent`}>
            <div className="qx-agent-dock__inner">
                <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm qx-agent-dock__close" onClick={onClose}
                    aria-label="Close agent" title="Close agent"><CloseIcon /></button>
                <AgentChatSidebar
                    panel={false}
                    agentId={agent.id || pluginId}
                    agentName={name.toUpperCase()}
                    agentColor={agent.color || '#a78bfa'}
                    agentRole={agent.role || 'Plugin agent'}
                    suggestions={Array.isArray(agent.suggestions) ? agent.suggestions.slice(0, 6) : []}
                    sessionPrefix={`PLUGIN_${pluginId}_${orgId}`}
                    placeholder={`Ask ${name.toUpperCase()}...`}
                    emptyText={`Ask ${name.toUpperCase()}...`}
                />
            </div>
        </div>
    );
}

export default function PluginFrameView({ pluginId, path }) {
    const containerRef = useRef(null);
    const [dockOpen, setDockOpen] = useState(true);

    useEffect(() => {
        const frame = getPluginFrame(pluginId);
        const el = containerRef.current;
        if (!frame || !el || !frame.iframe) return undefined;
        el.appendChild(frame.iframe);
        // Tell the plugin which of its declared routes to show.
        try { frame.emit('route', { path }); } catch { /* frame gone */ }
        return () => {
            // Park the iframe back offscreen so the plugin instance + state survive.
            const holder = frameHolder();
            if (holder && frame.iframe) {
                try { holder.appendChild(frame.iframe); } catch { /* detached */ }
            }
        };
    }, [pluginId, path]);

    const frame = getPluginFrame(pluginId);
    if (!frame) {
        return (
            <div className="qx-empty" style={{ padding: '2rem', color: '#fff' }}>
                Plugin “{pluginId}” is not running. Try re-enabling it in Settings → Plugins.
            </div>
        );
    }

    // GRIPE-701: the frame container must sit in a flex column that has a
    // definite height, or height:100% collapses and the iframe falls back to
    // the browser default of 150px (content clipped). .qx-view is the
    // canonical viewport-fit wrapper (flex:1; min-height:0) under app-shell.
    const manifest = getLoadedPluginManifest(pluginId);
    const agent = manifest && manifest.agentDefinition && manifest.agentSidebar !== false
        ? manifest.agentDefinition : null;

    return (
        <div className="qx-view" style={{ position: 'relative', display: 'flex', flexDirection: agent ? 'row' : 'column', gap: agent ? 12 : 0 }}>
            <div
                ref={containerRef}
                data-plugin-frame={pluginId}
                style={{ flex: 1, minHeight: 0, minWidth: 0, width: '100%', display: 'flex' }}
            />
            {agent && dockOpen ? (
                <PluginAgentDock pluginId={pluginId} agent={agent} onClose={() => setDockOpen(false)} />
            ) : null}
            {agent && !dockOpen ? (
                <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm qx-agent-dock__open" onClick={() => setDockOpen(true)}
                    aria-label="Open agent" title="Open agent"><ChatIcon /> Agent</button>
            ) : null}
        </div>
    );
}
