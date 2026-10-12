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
import { useEffect, useRef } from 'react';
import { getPluginFrame, frameHolder } from '../../services/pluginFrameRegistry';

export default function PluginFrameView({ pluginId, path }) {
    const containerRef = useRef(null);

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
            <div className="qx-empty" style={{ padding: '2rem', color: 'rgba(255,255,255,0.7)' }}>
                Plugin “{pluginId}” is not running. Try re-enabling it in Settings → Plugins.
            </div>
        );
    }

    // GRIPE-701: the frame container must sit in a flex column that has a
    // definite height, or height:100% collapses and the iframe falls back to
    // the browser default of 150px (content clipped). .qx-view is the
    // canonical viewport-fit wrapper (flex:1; min-height:0) under app-shell.
    return (
        <div className="qx-view" style={{ display: 'flex', flexDirection: 'column' }}>
            <div
                ref={containerRef}
                data-plugin-frame={pluginId}
                style={{ flex: 1, minHeight: 0, width: '100%', display: 'flex' }}
            />
        </div>
    );
}
