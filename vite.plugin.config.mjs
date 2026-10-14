/**
 * Parameterised Vite config for building FIRST-PARTY Quox plugins
 * (LICENSE-LAUNCH LL-7).
 *
 * One config, one plugin per invocation, selected by QUOX_PLUGIN_ID:
 *
 *   node scripts/build-first-party-plugin.mjs quoxbox-macmini
 *
 * It builds exactly the way a third-party plugin builds — quox-plugin-vite,
 * React externalised onto window.__quoxSharedDeps, single plugin.esm.js +
 * plugin.css, packaged into a .quoxplugin ZIP — because the whole point of the
 * loader contract is that first-party and third-party share ONE format. The
 * only delta is where the entry lives (plugins-src/<id>/index.jsx, importing
 * the view from the dashboard source tree) and that the result is signed with
 * a Quox publisher key.
 *
 * quox-plugin-vite is resolved from node_modules when installed (npm, from
 * 0.2.0) and otherwise from the sibling quox-plugin-sdk checkout. It is a BUILD-TIME tool for this one
 * script and deliberately not a package.json dependency: adding a file: dep
 * would break `npm ci` inside the dashboard Docker build, which has no sibling
 * checkout in its context.
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const pluginId = process.env.QUOX_PLUGIN_ID;
if (!pluginId) {
    throw new Error('QUOX_PLUGIN_ID is required — run via scripts/build-first-party-plugin.mjs <pluginId>');
}

const projectRoot = path.join(HERE, 'plugins-src', pluginId);
if (!fs.existsSync(projectRoot)) {
    throw new Error(`No plugin source at ${projectRoot}`);
}

const entry = path.join(projectRoot, 'index.jsx');
if (!fs.existsSync(entry)) {
    throw new Error(`No entry at ${entry}`);
}

/** Resolve quox-plugin-sdk's vite plugin: node_modules first, sibling checkout second. */
function loadQuoxPluginVite() {
    try {
        return require('quox-plugin-vite');
    } catch { /* not installed — fall through to the sibling checkout */ }

    const fallback = process.env.QUOX_PLUGIN_VITE
        || path.resolve(HERE, '..', 'quox-plugin-sdk', 'packages', 'quox-plugin-vite', 'src', 'index.js');
    if (fs.existsSync(fallback)) return require(fallback);

    throw new Error(
        'quox-plugin-vite not found. Install it, or point QUOX_PLUGIN_VITE at '
        + 'quox-plugin-sdk/packages/quox-plugin-vite/src/index.js',
    );
}

const quoxPluginVite = loadQuoxPluginVite();

/**
 * LL-7 — the HOST's React contexts, never a bundled copy.
 *
 * A first-party entry imports a view from the dashboard source tree, and that
 * view imports `../../contexts/WorkspaceContext`. Left alone, rollup follows
 * that edge and COMPILES A SECOND COPY of the module into plugin.esm.js. React
 * context identity is per-module-instance, so the copy's `createContext()` call
 * produces a context the host's <WorkspaceProvider> never provides — and the
 * bundled view, rendered inside the host's provider, throws "useWorkspace must
 * be used within a WorkspaceProvider". Live repro 2026-08-31: an entitled org
 * hit the host error boundary at /dev-suite.
 *
 * Same defect class as React itself (externalised by quox-plugin-vite) and as
 * the capability-panel registry (window-scoped Map, a8ce9ec4): one host, one
 * instance. The fix is the same shape — resolve every spelling of these two
 * modules to a virtual shim that reads the host's live module namespace off
 * window.__quoxSharedDeps, so no bundle can ever compile its own.
 *
 * Bundles CONSUME these contexts. The providers are re-exported only so an
 * import of them still resolves to the host's; a bundle must never mount its
 * own provider, which would give it separate state rather than shared state.
 */
const SHARED_CONTEXT_MODULES = [
    {
        file: path.join(HERE, 'src', 'contexts', 'WorkspaceContext.jsx'),
        virtualId: '\0quox-shared:WorkspaceContext',
        globalKey: 'WorkspaceContext',
        exports: ['WorkspaceProvider', 'useWorkspace'],
    },
    {
        file: path.join(HERE, 'src', 'contexts', 'AuthContext.jsx'),
        virtualId: '\0quox-shared:AuthContext',
        globalKey: 'AuthContext',
        exports: ['describeServerError', 'AuthProvider', 'useAuth'],
    },
    // LL-7 licenseValidator share. The entitlement cache lives in module-scope
    // singletons here (_entitlementSet, _governedSet, _orgBands, ...), populated
    // ONLY by the core app's setEntitlements()/fetchEntitlements(). A bundled
    // view that imports isPluginLicensed compiles its own copy of this module
    // unless it is resolved to the host instance — that copy's cache is never
    // filled, so isPluginLicensed() fails closed and every governed plugin's
    // page renders its "Activate plugin" gate while PluginSettings shows it
    // licensed. Same one-host-one-instance defect class as the two contexts
    // above (root-caused 2026-09-02, bastion-fleet).
    //
    // SECURITY (HIGH): unlike the contexts, licenseValidator is a trust
    // boundary. A loaded bundle is ordinary same-origin code, so the write side
    // (setEntitlements/clearEntitlements/fetch*/the license mutators) must NOT
    // reach the bundle — it could falsify client-side auth. So `exports` (the
    // READ set) forward to the host's live instance, while `throwingExports`
    // (the WRITE/network set) resolve to a loud throwing stub: a bundle that
    // calls one fails at the call site instead of silently binding `undefined`
    // (the host surface deliberately omits them — thirdPartyPluginHost.js).
    // assertShimCoversExports still demands FULL coverage of every export in
    // the source file across BOTH lists, so a new export can never compile to a
    // silent `undefined` in a customer's browser.
    {
        file: path.join(HERE, 'src', 'services', 'licenseValidator.js'),
        virtualId: '\0quox-shared:licenseValidator',
        globalKey: 'LicenseValidator',
        // READ surface — forwarded to window.__quoxSharedDeps.LicenseValidator.
        exports: [
            'isPluginLicensed', 'getPluginLicenseDiagnosis', 'isGovernedPlugin', 'getPluginTier', 'getOrgBand',
            'getCallerOrgId', 'getFirstLicenseId', 'getStoredLicense', 'getLicenseTiers',
            'hasTier', 'getActiveQuoxMindTier', 'getLicenseStatus', 'getStoredPluginLicenses',
            'isThirdPartyPluginLicensed', 'isLicenseValid',
            // Read-only tier data (`export { PLUGIN_TIERS, TIER_HIERARCHY }`,
            // licenseValidator.js:1170). Forwarded frozen by the host surface.
            'PLUGIN_TIERS', 'TIER_HIERARCHY',
        ],
        // WRITE / network surface — host-only. Bundle imports resolve to a stub
        // that throws on call. Never placed on the shared-deps object.
        throwingExports: [
            'setEntitlements', 'clearEntitlements', 'fetchEntitlements', 'setServerLicense',
            'clearServerLicense', 'fetchInstanceLicensing', 'validateLicense', 'storeLicense',
            'clearLicense', 'activateLicense', 'setServerPluginLicenses', 'clearServerPluginLicenses',
            'fetchPluginLicenses', 'validatePluginLicense', 'activatePluginLicense', 'removePluginLicense',
        ],
    },
    // LI-OVERHAUL P11 (2026-09-17): the sync queue and org-scoped storage hold
    // load-bearing MODULE STATE (_currentOrgId in serverSyncQueue, _orgId /
    // _userId in orgScopedStorage), set by the host's Workspace/Auth contexts.
    // A bundle that compiles its own copies gets null state on both: orgSet()
    // still writes localStorage (so the plugin LOOKS fine in that browser) but
    // queueOrgSync warns "No org context set" and SILENTLY DROPS the server
    // write — the LinkedIn wizard's config never persisted server-side and a
    // fresh browser showed setup again. Same one-host-one-instance defect
    // class as the contexts and licenseValidator above. Transitive imports
    // (userPreferences -> serverSyncQueue, pluginConfigStorage ->
    // orgScopedStorage) are covered because resolveId matches by canonical
    // file path, so bundled copies of the STATELESS wrappers converge on the
    // host's stateful instances.
    {
        file: path.join(HERE, 'src', 'services', 'serverSyncQueue.js'),
        virtualId: '\0quox-shared:serverSyncQueue',
        globalKey: 'ServerSyncQueue',
        exports: [
            'queueSync', 'setOrgSyncContext', 'queueOrgSync', 'flushOrgNow', 'onSyncEvent',
            'markHydrated', 'flushNow', 'hydrateFromServer', 'getPendingCount', 'initSyncQueue',
        ],
    },
    {
        file: path.join(HERE, 'src', 'services', 'orgScopedStorage.js'),
        virtualId: '\0quox-shared:orgScopedStorage',
        globalKey: 'OrgScopedStorage',
        exports: [
            'setStorageContext', 'getStorageOrgId', 'getStorageUserId', 'getOrgKey', 'getPersonalKey',
            'orgGet', 'orgSet', 'orgRemove', 'personalGet', 'personalSet', 'personalRemove',
            'orgGetJSON', 'orgSetJSON', 'personalGetJSON', 'personalSetJSON',
        ],
    },
];

/**
 * Named exports a shim must re-export, read straight off the source file. A
 * context module that grows an export the shim does not forward would compile
 * to `undefined` in every bundle that imports it, silently — so drift is a
 * build failure here rather than a runtime one in a customer's browser.
 */
function namedExportsOf(src, file) {
    const names = [];
    // Declaration exports: export (async)? function|const|let|class NAME
    for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) {
        names.push(m[1]);
    }
    // Named export / re-export blocks: `export { A, B as C }` and
    // `export { A } from './x'`. The bundle imports the EXPORTED name (after
    // `as`), which is what the shim must forward — the original regex missed
    // this whole form (D2: `export { PLUGIN_TIERS, TIER_HIERARCHY }` bound to a
    // silent `undefined` in any bundle importing them).
    for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
        for (const spec of m[1].split(',')) {
            const trimmed = spec.trim();
            if (!trimmed) continue;
            const parts = trimmed.split(/\s+as\s+/);
            const exported = (parts[1] || parts[0]).trim();
            if (exported && exported !== 'default') names.push(exported);
        }
    }
    // `export * from '...'` cannot be statically enumerated by this guard, so
    // its names could silently bind to `undefined` in a bundle. Fail loudly
    // rather than let the coverage guarantee lie (none exists today).
    if (/^export\s*\*/m.test(src)) {
        throw new Error(
            `[quox-shared-contexts] ${path.relative(HERE, file)} uses \`export *\`, which the `
            + 'shared-dep coverage guard cannot verify. Enumerate the re-exported names explicitly '
            + 'with `export { ... }` so each can be forwarded (exports) or stubbed (throwingExports).',
        );
    }
    return names;
}

function assertShimCoversExports({ file, exports: declared, throwingExports = [] }) {
    const src = fs.readFileSync(file, 'utf8');
    const found = namedExportsOf(src, file);
    // Full coverage across BOTH lists — a read export forwards to the host, a
    // write export forwards to a throwing stub, but every source export must be
    // accounted for so none compiles to a silent `undefined` in a bundle.
    const covered = new Set([...declared, ...throwingExports]);
    const missing = found.filter((name) => !covered.has(name));
    if (missing.length > 0) {
        throw new Error(
            `[quox-shared-contexts] ${path.relative(HERE, file)} exports ${missing.join(', ')}, `
            + 'which the shared-dep shim in vite.plugin.config.mjs does not forward. '
            + 'Add the name to SHARED_CONTEXT_MODULES[].exports (read, host-forwarded) or '
            + '.throwingExports (write, host-only stub).',
        );
    }
    // A name declared in the config but absent from the source file is stale
    // and would emit a broken binding — fail on that too.
    const stale = [...covered].filter((name) => !found.includes(name));
    if (stale.length > 0) {
        throw new Error(
            `[quox-shared-contexts] ${path.relative(HERE, file)} does not export ${stale.join(', ')}, `
            + 'but the shim in vite.plugin.config.mjs lists it. Remove the stale name.',
        );
    }
}

/** True if the source module has a default export (so the shim only re-exports
 *  one when it really exists — a future default import is then a build error,
 *  not a silent `undefined`). */
function moduleHasDefaultExport(file) {
    const src = fs.readFileSync(file, 'utf8');
    return /^export\s+default\b/m.test(src) || /^export\s*\{[^}]*\bas\s+default\b[^}]*\}/m.test(src);
}

/** Canonicalize a path (resolve symlinks + `..`) so a specifier that reaches
 *  the same file by any spelling still matches. Falls back to the input if the
 *  path does not exist on disk. */
function canonical(p) {
    try { return fs.realpathSync.native(p); } catch { return p; }
}

/** Resolve a relative/absolute specifier to the canonical file it would load,
 *  extensions included. */
function resolveToFile(source, importer) {
    if (!importer) return null;
    if (!source.startsWith('.') && !path.isAbsolute(source)) return null;
    const base = path.isAbsolute(source) ? source : path.resolve(path.dirname(importer), source);
    for (const candidate of [base, `${base}.jsx`, `${base}.js`]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return canonical(candidate);
    }
    return null;
}

const SRC_ROOT = path.join(HERE, 'src');

/** The src-relative, extension-stripped path of a shared module, e.g.
 *  `services/licenseValidator`. Used to match aliased/bare spellings. */
function srcTail(file) {
    return path.relative(SRC_ROOT, file).replace(/\\/g, '/').replace(/\.(jsx?|mjs|cjs)$/, '');
}

/** Normalize an aliased/bare specifier to a src-relative tail so `@/services/x`
 *  and `src/services/x` compare equal to a module's srcTail. Returns null for a
 *  relative/absolute specifier (those go through resolveToFile). This repo
 *  defines no `@` alias today (checked 2026-09-02: no resolve.alias, no
 *  jsconfig), so nothing in-tree hits this path — it is defense-in-depth so a
 *  future alias cannot silently reintroduce the copied-module defect. It only
 *  ever maps to one of the three known SHARED_CONTEXT_MODULES files. */
function aliasTail(source) {
    if (source.startsWith('.') || path.isAbsolute(source)) return null;
    const s = source.replace(/\\/g, '/').replace(/^(@|~)\//, '').replace(/^src\//, '');
    return s.replace(/\.(jsx?|mjs|cjs)$/, '');
}

function sharedHostContexts() {
    SHARED_CONTEXT_MODULES.forEach(assertShimCoversExports);
    // Precompute per-module: canonical file (symlink-stable match), src tail
    // (alias match), and whether the source has a default export.
    const modules = SHARED_CONTEXT_MODULES.map((m) => ({
        ...m,
        canonicalFile: canonical(m.file),
        tail: srcTail(m.file),
        hasDefault: moduleHasDefaultExport(m.file),
    }));
    const byVirtualId = new Map(modules.map((m) => [m.virtualId, m]));

    return {
        name: 'quox-shared-host-contexts',
        enforce: 'pre',

        resolveId(source, importer) {
            if (byVirtualId.has(source)) return source;
            const file = resolveToFile(source, importer);
            if (file) {
                const match = modules.find((m) => m.canonicalFile === file);
                if (match) return match.virtualId;
            }
            // Aliased/bare specifier (e.g. `@/services/licenseValidator`) —
            // match by src-relative tail against the known shared modules only.
            const tail = aliasTail(source);
            if (tail) {
                const match = modules.find((m) => m.tail === tail);
                if (match) return match.virtualId;
            }
            return null;
        },

        load(id) {
            const mod = byVirtualId.get(id);
            if (!mod) return null;
            const message = `[quox-plugin] host did not expose window.__quoxSharedDeps.${mod.globalKey}; `
                + 'this bundle consumes the dashboard context and must not compile its own';
            const lines = [
                `const __host = (typeof window !== 'undefined' && window.__quoxSharedDeps) || {};`,
                `const __mod = __host.${mod.globalKey};`,
                `if (!__mod) throw new Error(${JSON.stringify(message)});`,
                ...mod.exports.map((name) => `export const ${name} = __mod.${name};`),
            ];
            for (const name of mod.throwingExports || []) {
                const stubMsg = `[quox-plugin] ${name}() is host-only and not exposed to plugin bundles; `
                    + `window.__quoxSharedDeps.${mod.globalKey} is a read-only licensing surface`;
                lines.push(
                    `export const ${name} = () => { throw new Error(${JSON.stringify(stubMsg)}); };`,
                );
            }
            // LOW defect: only re-export a default when the source actually has
            // one (contexts do; licenseValidator does not). Emitting it
            // unconditionally bound a future default import to `undefined`.
            if (mod.hasDefault) lines.push(`export default __mod.default;`);
            lines.push('');
            return lines.join('\n');
        },
    };
}

/**
 * quox-plugin-vite hardcodes rollupOptions.input to 'src/index.jsx' (the
 * create-quox-plugin scaffold layout). Our first-party entries are flat
 * (plugins-src/<id>/index.jsx), so this normal-enforce plugin re-points the
 * input: Vite merges `config` hook results in pre → normal → post order, so a
 * normal plugin declared after the 'pre' one wins the merge.
 */
function firstPartyEntryOverride() {
    return {
        name: 'quox-first-party-entry',
        config() {
            return { build: { rollupOptions: { input: entry } } };
        },
    };
}

export default defineConfig({
    root: projectRoot,
    plugins: [
        // Declared before quox-plugin-vite so its resolveId sees the context
        // specifiers first; both are 'pre', and Vite orders equal-enforce
        // plugins by declaration.
        sharedHostContexts(),
        // qxCss: false. First-party bundles run IN-PARENT, where the host's own
        // qx stylesheet is already loaded; quox-plugin-vite >= 0.2.0 otherwise
        // prepends the full vendored qx css (~210 KB) for community plugins,
        // which run in a frame with no host CSS. Older versions ignore it.
        quoxPluginVite({ pluginId, devHost: false, qxCss: false }),
        react(),
        firstPartyEntryOverride(),
    ],
});
