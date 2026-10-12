/**
 * PD-5 — plugin lifecycle hook dispatcher.
 *
 * Plugins can export `hooks: { onInstall, onUpgrade, onUninstall, onRestore }`
 * from their entry. The host calls `fireLifecycleHook(...)` at the matching
 * boundary — this module is the pure dispatcher.
 *
 * Hooks receive (api, ctx). Errors are caught, logged, and swallowed: a buggy
 * plugin must never abort the host operation.
 */

/**
 * @param {Object} args
 * @param {Map<string, {exports?: any}>} args.loadedPlugins
 * @param {string} args.pluginId
 * @param {'onInstall'|'onUpgrade'|'onUninstall'|'onRestore'} args.hookName
 * @param {Object} [args.ctx]
 * @param {(pluginId: string) => any} [args.getApi]   — supplied by host so the
 *   hook receives the live api object. Defaults to a window-lookup.
 */
export async function fireLifecycleHook({ loadedPlugins, pluginId, hookName, ctx = {}, getApi }) {
    const entry = loadedPlugins?.get?.(pluginId);
    const fn = entry?.exports?.hooks?.[hookName];
    if (typeof fn !== 'function') return { fired: false, reason: 'not_declared' };

    const api = getApi
        ? getApi(pluginId)
        : (typeof window !== 'undefined' ? window.__quoxPluginApi?.[pluginId] : undefined);

    try {
        await fn(api, ctx);
        return { fired: true };
    } catch (err) {
        // Errors are non-fatal. Logged here once; host may also audit.
        console.warn(`[PluginHost] ${pluginId} ${hookName} hook error:`, err);
        return { fired: true, error: err };
    }
}
