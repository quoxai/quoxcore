#!/usr/bin/env node
/**
 * check-dist-clean — the acceptance gate for the LL-7 code strip.
 *
 *   npm run build && node scripts/check-dist-clean.mjs
 *
 * Two assertions per stripped plugin, and BOTH matter:
 *
 *   1. NEGATIVE — its markers are absent from every dist/assets/*.js. This is
 *      the claim that actually sells: the free build does not contain the paid
 *      code. It holds only because App.jsx's lazy() import and the /quoxbox
 *      row in routeRegistry.js were deleted, so Rollup never reaches the view.
 *
 *   2. POSITIVE CONTROL — the same markers ARE present in the built
 *      plugin.esm.js, together with the sentinel. Without this, a typo in a
 *      marker string, or a build that silently emitted nothing, would make the
 *      negative assertion pass for the wrong reason. A green scan has to mean
 *      "moved", never "vanished".
 *
 * LL-7 review note 2: the sentinel is a PROPERTY OF THE REGISTERED EXPORTS
 * OBJECT (`__qxSentinel: 'QX_P1_<id>'`), not a bare const. A bare const is
 * tree-shaken out of a minified bundle and the positive control dies with it.
 *
 * Exit 0 = clean. Exit 1 = a stripped view leaked back into the free build, or
 * its bundle is missing/stale. Wired into CI and pre-deploy.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { strippedPlugins } from '../src/config/stripRegistry.js';
import { STRIP_MARKERS } from './strip-markers.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The plugins this scan asserts against, derived from the single strip
 * registry (src/config/stripRegistry.js) rather than kept as a second list
 * here. LL-7 increment 2 generalised it: a plugin enters this scan by flipping
 * its registry row to status 'stripped', which is the same flip that arms its
 * ESLint patterns and mounts its locked stub. One edit, three enforcements —
 * there is no way to strip a plugin and forget to scan for it.
 *
 * The marker STRINGS come from scripts/strip-markers.mjs, which nothing under
 * src/ may import — a marker written into a browser-imported module ships into
 * dist/assets and makes this scan permanently red. That file's header has the
 * recipe for adding a row.
 */
export const STRIPPED_PLUGINS = strippedPlugins().map(({ pluginId, bundle }) => ({
    pluginId,
    bundle,
    sentinel: STRIP_MARKERS[pluginId]?.sentinel,
    markers: STRIP_MARKERS[pluginId]?.markers || [],
    // A plugin whose exclusive surface no longer carries any pinnable marker
    // (see strip-markers.mjs) opts out of the positive control with an issue
    // reference. The negative/leak direction still runs. See #595 (grafana).
    pendingControl: STRIP_MARKERS[pluginId]?.pendingControl,
    // sentinelOnly: the plugin's exclusive surface is a license gate over CORE
    // components, so it has no exclusive copy to pin. Its build-injected
    // sentinel is the positive control instead — scanned by the negative pass
    // and required present by the positive pass. See grafana / #595.
    sentinelOnly: STRIP_MARKERS[pluginId]?.sentinelOnly,
}));

/** Read every emitted JS asset of the free build. */
export function readDistAssets(distDir = path.join(REPO, 'dist')) {
    const assetsDir = path.join(distDir, 'assets');
    if (!existsSync(assetsDir)) {
        throw new Error(`no ${assetsDir} — run "npm run build" first`);
    }
    return readdirSync(assetsDir)
        .filter((f) => f.endsWith('.js'))
        .map((f) => ({ file: path.join('assets', f), code: readFileSync(path.join(assetsDir, f), 'utf8') }));
}

/**
 * Run both directions of the scan.
 * @returns {{ok: boolean, leaks: Array, controlFailures: Array, checked: number}}
 */
export function scanDistForStrippedPlugins({ distDir, plugins = STRIPPED_PLUGINS } = {}) {
    const assets = readDistAssets(distDir);
    const leaks = [];
    const controlFailures = [];

    for (const plugin of plugins) {
        // 0. A stripped plugin with no markers would make the negative
        // assertion trivially true. Refuse rather than report a green scan for
        // a plugin nothing was ever looked for — UNLESS it is sentinelOnly, in
        // which case its build-injected sentinel is what gets scanned (below)
        // and pinned (positive pass), so the scan is not vacuous. See #595.
        const hasMarkers = plugin.markers && plugin.markers.length > 0;
        if (!hasMarkers && !plugin.sentinelOnly) {
            controlFailures.push({ pluginId: plugin.pluginId, reason: 'no markers declared in the strip registry — nothing was scanned for' });
            continue;
        }
        if (plugin.sentinelOnly && !plugin.sentinel) {
            controlFailures.push({ pluginId: plugin.pluginId, reason: 'sentinelOnly plugin declares no sentinel — nothing to scan for or pin' });
            continue;
        }

        // 1. Negative: nothing of this plugin may appear in the free build.
        for (const marker of (plugin.markers || []).concat(plugin.sentinel ? [plugin.sentinel] : [])) {
            for (const asset of assets) {
                if (asset.code.includes(marker)) {
                    leaks.push({ pluginId: plugin.pluginId, marker, file: asset.file });
                }
            }
        }

        // 2. Positive control: it must be present in the built bundle instead.
        // A plugin flagged pendingControl (its exclusive surface lost every
        // pinnable marker, tracked by the referenced issue) opts out of the
        // positive control only — the leak scan above still guards it.
        if (plugin.pendingControl) {
            continue;
        }
        const bundlePath = path.join(REPO, plugin.bundle);
        if (!existsSync(bundlePath)) {
            controlFailures.push({ pluginId: plugin.pluginId, reason: `missing bundle ${plugin.bundle}` });
            continue;
        }
        const bundle = readFileSync(bundlePath, 'utf8');
        for (const marker of plugin.markers) {
            if (!bundle.includes(marker)) {
                controlFailures.push({ pluginId: plugin.pluginId, reason: `marker absent from bundle: ${JSON.stringify(marker)}` });
            }
        }
        if (!bundle.includes(plugin.sentinel)) {
            controlFailures.push({
                pluginId: plugin.pluginId,
                reason: `sentinel ${plugin.sentinel} absent from bundle — it was tree-shaken; attach it to the registered exports object`,
            });
        }
    }

    return { ok: leaks.length === 0 && controlFailures.length === 0, leaks, controlFailures, checked: assets.length };
}

// ── CLI ───────────────────────────────────────────────────────────────────

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
    let result;
    try {
        result = scanDistForStrippedPlugins();
    } catch (err) {
        console.error(`✖ dist scan │ ${err.message}`);
        process.exit(1);
    }

    for (const leak of result.leaks) {
        console.error(`✖ LEAK │ ${leak.pluginId} marker ${JSON.stringify(leak.marker)} found in dist/${leak.file}`);
    }
    for (const fail of result.controlFailures) {
        console.error(`✖ CONTROL │ ${fail.pluginId}: ${fail.reason}`);
    }

    if (result.ok) {
        console.log(`Ⓠ QUOX │ dist scan │ ${STRIPPED_PLUGINS.length} stripped plugin(s) absent from ${result.checked} dist assets, present in their bundles ✔`);
        process.exit(0);
    }
    process.exit(1);
}
