#!/usr/bin/env node
/**
 * check-strip-registry — the guard that stops an LL-7 increment half-landing.
 *
 *   npm run check:strip
 *
 * A strip is five edits that must all land together, in one commit:
 *
 *   1. the route row leaves src/config/routeRegistry.js (or App.jsx);
 *   2. plugins-src/<id>/ gains the thin entry;
 *   3. the signed bundle is published under services/auth/first-party-plugins/<id>/;
 *   4. src/config/premiumRouteStubs.js has a locked stub for every path;
 *   5. src/config/stripRegistry.js flips the row to status: 'stripped' with
 *      dist markers and a sentinel.
 *
 * Land four of the five and the failure is silent and nasty: a paid route that
 * 404s, a bundle nobody loads, or a "stripped" plugin still sitting in the free
 * build with the dist scan cheerfully green because nothing told it to look.
 * This script asserts all five, in both directions, so half-landing fails the
 * build instead of shipping.
 *
 * Exit 0 = consistent. Exit 1 = something half-landed. Wired into CI.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { STRIP_REGISTRY, STRIP_STATUS } from '../src/config/stripRegistry.js';
import { PREMIUM_ROUTE_STUBS } from '../src/config/premiumRouteStubs.js';
import { STRIP_MARKERS } from './strip-markers.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every .js/.jsx file under src/, minus the test tree. */
function srcFiles(repo) {
    const out = [];
    const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'test' || entry.name === 'node_modules') continue;
                walk(full);
            } else if (/\.(jsx?|mjs)$/.test(entry.name)) {
                out.push(full);
            }
        }
    };
    walk(path.join(repo, 'src'));
    return out;
}

/** Files that declare route paths for the free build. */
const ROUTE_SOURCES = ['src/config/routeRegistry.js', 'src/App.jsx'];

/**
 * Every route path literally declared in the free build right now.
 *
 * Read from SOURCE rather than by importing the route table, because
 * buildCoreRoutes() needs React and App.jsx cannot be evaluated outside a
 * browser. Source text is also the honest thing to check: what matters is
 * whether the edge still exists in the tree a build would compile.
 */
export function declaredRoutePaths(repo = REPO) {
    const paths = new Set();
    for (const file of ROUTE_SOURCES) {
        const src = readFileSync(path.join(repo, file), 'utf8');
        // routeRegistry rows: { path: '/x', ... }   JSX routes: <Route path="/x" />
        for (const m of src.matchAll(/path:\s*'([^']+)'/g)) paths.add(m[1]);
        for (const m of src.matchAll(/path="([^"]+)"/g)) paths.add(m[1]);
    }
    return paths;
}

/**
 * @returns {{ok: boolean, problems: Array<{pluginId: string, kind: string, detail: string}>}}
 */
export function checkStripRegistry({
    repo = REPO,
    registry = STRIP_REGISTRY,
    stubs = PREMIUM_ROUTE_STUBS,
    markers = STRIP_MARKERS,
} = {}) {
    const problems = [];
    const add = (pluginId, kind, detail) => problems.push({ pluginId, kind, detail });

    const declared = declaredRoutePaths(repo);
    const stubByPath = new Map(stubs.map((s) => [s.path, s]));
    const exists = (rel) => existsSync(path.join(repo, rel));

    // ── Table-level integrity ─────────────────────────────────────────────
    const seenIds = new Set();
    const routeOwner = new Map();
    for (const row of registry) {
        if (seenIds.has(row.pluginId)) add(row.pluginId, 'duplicate-plugin-id', 'listed twice in the strip registry');
        seenIds.add(row.pluginId);
        for (const route of row.routes) {
            if (routeOwner.has(route)) {
                add(row.pluginId, 'duplicate-route', `${route} is already claimed by ${routeOwner.get(route)}`);
            }
            routeOwner.set(route, row.pluginId);
        }
    }

    for (const stub of stubs) {
        if (routeOwner.get(stub.path) !== stub.pluginId) {
            add(stub.pluginId, 'orphan-stub', `stub ${stub.path} is not a route claimed by its registry row`);
        }
    }

    // ── Per-row consistency ───────────────────────────────────────────────
    for (const row of registry) {
        // Every claimed route needs a locked stub, stripped or not. Authoring
        // the stub with the classification is what makes a later strip a
        // one-line status flip instead of a scramble.
        for (const route of row.routes) {
            const stub = stubByPath.get(route);
            if (!stub) {
                add(row.pluginId, 'stub-missing', `no locked stub for ${route} — that path would 404 the moment it strips`);
            } else if (stub.pluginId !== row.pluginId) {
                add(row.pluginId, 'stub-mismatch', `stub ${route} belongs to ${stub.pluginId}`);
            }
        }

        if (row.status === STRIP_STATUS.STRIPPED) {
            for (const route of row.routes) {
                if (declared.has(route)) {
                    add(row.pluginId, 'route-still-in-core', `${route} is still declared in ${ROUTE_SOURCES.join(' or ')} — the code was never actually stripped`);
                }
            }
            if (!row.entry) {
                add(row.pluginId, 'entry-missing', 'no plugins-src entry recorded');
            } else if (!exists(row.entry)) {
                add(row.pluginId, 'entry-missing', `${row.entry} does not exist`);
            }
            if (!row.bundle) {
                add(row.pluginId, 'bundle-missing', 'no signed bundle recorded');
            } else if (!exists(row.bundle)) {
                add(row.pluginId, 'bundle-missing', `${row.bundle} was never built or published`);
            }
            const marker = markers[row.pluginId];
            if (!marker?.sentinel) {
                add(row.pluginId, 'markers-missing', 'no minification-surviving sentinel in scripts/strip-markers.mjs');
            }
            // sentinelOnly (quoxai/quox#595 option b, owner call 2026-09-25): the
            // build-injected sentinel IS the positive control for a plugin with no
            // exclusive copy left to pin, so an empty markers[] is accepted there.
            // The sentinel itself is still required by the check above.
            if (!marker?.sentinelOnly && (!marker?.markers || marker.markers.length === 0)) {
                add(row.pluginId, 'markers-missing', 'no dist-scan markers in scripts/strip-markers.mjs — the scan would pass this plugin for the wrong reason');
            }
            if (!row.coreModules || row.coreModules.length === 0) {
                add(row.pluginId, 'core-modules-missing', 'no coreModules declared — the ESLint boundary has nothing to forbid');
            }
        } else if (row.status === STRIP_STATUS.PENDING || row.status === STRIP_STATUS.CORE_GATED) {
            // PENDING and CORE_GATED share the SAME on-disk shape: the code
            // stays in the free build, so any claimed route is still declared in
            // core and no plugins-src entry / signed bundle may exist. The
            // difference is INTENT (pending owes a strip; core-gated never will),
            // recorded by the status field and the CLI summary, not by a
            // different set of file invariants.
            for (const route of row.routes) {
                if (!declared.has(route)) {
                    add(row.pluginId, 'route-missing-from-core', `${route} is not declared in ${ROUTE_SOURCES.join(' or ')} — the strip half-landed, or the registry claims a route that does not exist`);
                }
            }
            if (row.entry && exists(row.entry)) {
                add(row.pluginId, 'entry-present-while-pending', `${row.entry} exists but the row is ${row.status} (no strip owed) — a ${row.status} row must not carry a plugins-src entry`);
            }
            if (row.bundle && exists(row.bundle)) {
                add(row.pluginId, 'bundle-present-while-pending', `${row.bundle} exists but the row is ${row.status} (no strip owed) — flip the status or delete the bundle`);
            }
        } else if (row.status === STRIP_STATUS.EXTERNAL) {
            if (row.routes.length > 0) {
                add(row.pluginId, 'external-with-routes', 'an external bundle never owned a core route');
            }
            if (row.bundle && !exists(row.bundle)) {
                add(row.pluginId, 'bundle-missing', `${row.bundle} does not exist`);
            }
        } else {
            add(row.pluginId, 'unknown-status', `status ${JSON.stringify(row.status)} is not one of ${Object.values(STRIP_STATUS).join(', ')}`);
        }
    }

    // ── Markers must never be readable from src/ ──────────────────────────
    //
    // A dist-scan marker is by definition a string that must appear ONLY in
    // the paid code. Write one into any module the free build imports and the
    // dist scan goes permanently red for a reason that has nothing to do with
    // a leak — and the tempting fix is to delete the marker, which quietly
    // disarms the check. This happened for real while increment 2 was being
    // written: the marker list started life inside stripRegistry.js, which
    // App.jsx imports, and all four quoxbox markers shipped into main-*.js.
    //
    // The only legal home for a marker inside src/ is the stripped plugin's
    // own coreModules — that IS the paid code; it is simply no longer
    // reachable from the free build.
    const legalHomes = new Set(
        registry.flatMap((row) => (row.status === STRIP_STATUS.STRIPPED ? row.coreModules : [])),
    );
    const markerOwners = [];
    for (const [pluginId, entry] of Object.entries(markers)) {
        for (const marker of [...(entry.markers || []), entry.sentinel].filter(Boolean)) {
            markerOwners.push({ pluginId, marker });
        }
    }
    if (markerOwners.length > 0) {
        for (const file of srcFiles(repo)) {
            const rel = path.relative(repo, file);
            if (legalHomes.has(rel)) continue;
            const code = readFileSync(file, 'utf8');
            for (const { pluginId, marker } of markerOwners) {
                if (code.includes(marker)) {
                    add(pluginId, 'marker-in-free-build', `${rel} contains the dist-scan marker ${JSON.stringify(marker)} — it will ship into dist/assets and make the scan red for the wrong reason`);
                }
            }
        }
    }

    return { ok: problems.length === 0, problems };
}

// ── CLI ───────────────────────────────────────────────────────────────────

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
    const { ok, problems } = checkStripRegistry();
    for (const p of problems) {
        console.error(`✖ STRIP │ ${p.pluginId} [${p.kind}] ${p.detail}`);
    }
    if (ok) {
        const stripped = STRIP_REGISTRY.filter((r) => r.status === STRIP_STATUS.STRIPPED).length;
        const pending = STRIP_REGISTRY.filter((r) => r.status === STRIP_STATUS.PENDING).length;
        const coreGated = STRIP_REGISTRY.filter((r) => r.status === STRIP_STATUS.CORE_GATED).length;
        console.log(`Ⓠ QUOX │ strip registry │ ${STRIP_REGISTRY.length} category-1 plugins, ${stripped} stripped, ${pending} pending, ${coreGated} core-gated, ${PREMIUM_ROUTE_STUBS.length} locked stubs ✔`);
        process.exit(0);
    }
    console.error(`✖ STRIP │ ${problems.length} inconsistency(ies) — an LL-7 increment half-landed`);
    process.exit(1);
}
