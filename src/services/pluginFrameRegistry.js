/**
 * pluginFrameRegistry — QUOXTRUST F2: the live registry of isolated plugin frames.
 *
 * Kept in its own module (no React, no thirdPartyPluginHost import) purely to break
 * the import cycle: thirdPartyPluginHost creates frames and registers routes whose
 * element is PluginFrameView; PluginFrameView needs getPluginFrame. Both import from
 * HERE, so neither imports the other.
 *
 * A non-official (untrusted) plugin runs in exactly ONE sandboxed iframe (created by
 * pluginFrameHost.createPluginFrame). The iframe lives in a hidden holder so it
 * survives navigation between the plugin's routes; PluginFrameView moves it into the
 * visible container on mount and back to the holder on unmount, preserving frame state.
 */

const FRAME_HOLDER_ID = '__quox_plugin_frame_holder';
const pluginFrames = new Map(); // pluginId -> frame handle (from createPluginFrame)

/**
 * The offscreen holder that keeps every live plugin iframe attached (and alive)
 * while no route is showing it.
 * @returns {HTMLElement|null}
 */
export function frameHolder() {
    if (typeof document === 'undefined') return null;
    let h = document.getElementById(FRAME_HOLDER_ID);
    if (!h) {
        h = document.createElement('div');
        h.id = FRAME_HOLDER_ID;
        h.style.display = 'none';
        h.setAttribute('aria-hidden', 'true');
        document.body.appendChild(h);
    }
    return h;
}

export function registerFrame(pluginId, frame) {
    pluginFrames.set(pluginId, frame);
}

export function getPluginFrame(pluginId) {
    return pluginFrames.get(pluginId) || null;
}

/**
 * Tear down and forget a plugin's frame (deactivation/uninstall).
 * @param {string} pluginId
 */
export function removeFrame(pluginId) {
    const frame = pluginFrames.get(pluginId);
    if (frame) {
        try { frame.destroy(); } catch { /* best-effort */ }
        pluginFrames.delete(pluginId);
    }
}

export { FRAME_HOLDER_ID };
