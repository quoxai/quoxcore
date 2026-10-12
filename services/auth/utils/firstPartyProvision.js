/**
 * First-party plugin auto-provisioning.
 *
 * Graduates Quox-authored plugins from the manual community-upload flow to true
 * "core" status: every org gets them without an admin uploading a .quoxplugin.
 *
 * LICENSE-LAUNCH LL-7: provisioning now follows the ENTITLEMENT, not just
 * boot. A bundle whose registry entry sets `entitlementGated` is installed only
 * into orgs that hold its licence, and its install row is REMOVED at the first
 * reconciliation after the lease lapses. That reverse direction is what makes
 * "deactivating removes access" true rather than asserted: the client's next
 * hydration finds the plugin gone from /me/plugins, purges its cached bundle,
 * and the 402 gate on /bundle refuses to serve the bytes again.
 *
 * Mechanism (there was NO existing seed/auto-install path — this is it):
 *   - `loadFirstPartyBundles()` reads the committed build outputs from disk once.
 *   - `ensureFirstPartyForOrg()` reconciles ONE org against ONE bundle,
 *     idempotently and version-aware.
 *   - `provisionFirstPartyPlugins()` loops every org × every bundle at boot.
 *   - `provisionFirstPartyForNewOrg()` does the same for a single just-created org.
 *
 * LICENSE-LAUNCH LL-7 (content reconciliation): reconciliation follows the
 * BYTES too, not just the row. It used to handle existence and manifest version
 * only, so an already-provisioned org kept its original bundle_blob forever and
 * no first-party bundle fix could ever reach it. The reconciler now compares
 * the on-disk SHA-256 against the row's and replaces blob + manifest +
 * signature when they differ, in place, at the same version. The comparison is
 * the point: this sweep runs orgs × bundles at every boot, so writing
 * unconditionally would make each restart a fleet-wide blob rewrite.
 *
 * LICENSE-LAUNCH LL-6d (C3): the FIRST provision ('installed') sets the default
 * `all_org_members` assignment and `is_enabled = 1`. Later reconciliations
 * ('upgraded' / 'refreshed' / 'current') PRESERVE whatever the admin has since
 * chosen — they do not force-enable a plugin an admin disabled, nor re-widen one
 * they narrowed. (An earlier version re-asserted both on every boot to self-heal
 * an assignment-less install; that also silently overrode admin intent, which is
 * the worse failure for a governed plugin, so admin state now wins.)
 *
 * Writing directly through the DB helpers (not the HTTP install route) means the
 * per-org trusted-key signature gate is bypassed — correct for first-party
 * bundles we ship ourselves; the gate exists to vet THIRD-party uploads.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
    ensurePluginsSchema,
    getInstall,
    createInstall,
    upgradeInstall,
    deleteInstall,
    assignPlugin,
    getAssignment,
    removeAssignment,
    setEnabled,
    sha256Hex,
} from './plugins.js';
import { FIRST_PARTY_PLUGINS, FIRST_PARTY_ACTOR } from '../config/firstPartyPlugins.js';
import { hasPlugin } from '../lib/entitlements.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE_ROOT = join(HERE, '..', 'first-party-plugins');

/**
 * Compare two dotted version strings numerically. Missing/NaN parts count as 0.
 * @returns {boolean} true when `a` is strictly older than `b`.
 */
export function versionLt(a, b) {
    const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const x = pa[i] || 0;
        const y = pb[i] || 0;
        if (x < y) return true;
        if (x > y) return false;
    }
    return false;
}

/** True when two dotted version strings compare equal numerically ("1.0" == "1.0.0"). */
function versionEq(a, b) {
    return !versionLt(a, b) && !versionLt(b, a);
}

/**
 * Build-time of a bundle, read from its signature's `timestamp` (ms since
 * epoch), or null when the bundle is unsigned / the timestamp is absent or
 * unparseable. scripts/sign-plugin.js stamps `timestamp: new Date().toISOString()`
 * on EVERY build (scripts/build-first-party-plugin.mjs re-signs each build), so
 * a genuine content rebuild always carries a strictly newer value than the copy
 * already stored — which is exactly the monotonic signal the same-version refresh
 * needs to tell a real update apart from an image rollback.
 */
function bundleSignatureTimestamp(signatureJson) {
    if (!signatureJson) return null;
    try {
        const ts = JSON.parse(signatureJson)?.timestamp;
        const ms = ts ? Date.parse(ts) : NaN;
        return Number.isFinite(ms) ? ms : null;
    } catch { return null; }
}

/**
 * LICENSE-LAUNCH LL-6d (C3): may the on-disk bundle overwrite the stored one at
 * the SAME version? Only when it is PROVABLY newer.
 *
 *   - disk has no build-time provenance      → NO (never let an unsigned/undated
 *     disk bundle clobber a stored copy).
 *   - disk is dated, the stored row is not   → YES (a signed, dated build
 *     supersedes a legacy row that predates the timestamp field).
 *   - both dated                             → YES iff disk is strictly newer.
 *
 * The equal/older case is the image-rollback hazard the audit flagged: an older
 * image on disk carries an older signature timestamp than the newer bytes the DB
 * already holds, so it is refused and the DB copy is kept.
 */
function diskBundleIsNewer(existing, bundle) {
    const diskTs = bundleSignatureTimestamp(bundle.signatureJson);
    const dbTs = bundleSignatureTimestamp(existing.signature_json);
    if (diskTs == null) return false;
    if (dbTs == null) return true;
    return diskTs > dbTs;
}

/**
 * SHA-256 of a bundle's bytes, memoised onto the descriptor.
 *
 * The boot sweep runs orgs × bundles (135 × 34 ≈ 4600 iterations over ~1.5 MB
 * buffers), so hashing per iteration would cost more than the sweep it guards.
 * Descriptors are loaded once per process by loadFirstPartyBundles(), so one
 * hash per bundle is all that ever happens.
 */
function bundleSha(bundle) {
    if (bundle.bundleSha256 === undefined) {
        bundle.bundleSha256 = sha256Hex(bundle.bundleBuf);
    }
    return bundle.bundleSha256;
}

/**
 * Read the committed build outputs for every registered first-party plugin.
 * Returns an array of bundle descriptors ready for reconciliation. A malformed
 * or missing bundle is skipped (logged), never fatal.
 *
 * @returns {Array<{pluginId,version,manifestJson,bundleBuf,cssBuf}>}
 */
export function loadFirstPartyBundles({ logger = console } = {}) {
    const bundles = [];
    for (const entry of FIRST_PARTY_PLUGINS) {
        try {
            const base = join(BUNDLE_ROOT, entry.dir);
            const manifestJson = readFileSync(join(base, 'manifest.json'), 'utf-8');
            const manifest = JSON.parse(manifestJson);
            if (manifest.id !== entry.pluginId) {
                throw new Error(`manifest id "${manifest.id}" != registry pluginId "${entry.pluginId}"`);
            }
            if (!manifest.version) throw new Error('manifest missing version');
            const bundleBuf = readFileSync(join(base, 'plugin.esm.js'));
            let cssBuf = null;
            try { cssBuf = readFileSync(join(base, 'plugin.css')); } catch { /* css optional */ }
            // LL-7: the signature is what earns a first-party bundle its
            // root-route privilege in the browser (the dashboard verifies it
            // against config/officialSigningKeys.js). Without carrying it into
            // the install row, the client sees an unsigned install and pushes
            // /quoxbox back under /plugins/quoxbox-macmini/.
            let signatureJson = null;
            try { signatureJson = readFileSync(join(base, 'signature.json'), 'utf-8'); } catch { /* unsigned bundles still load, just without the privilege */ }
            bundles.push({
                pluginId: entry.pluginId,
                version: manifest.version,
                manifestJson,
                bundleBuf,
                cssBuf,
                signatureJson,
                entitlementGated: entry.entitlementGated === true,
            });
        } catch (err) {
            logger.error?.(`[FirstParty] failed to load bundle "${entry.dir}": ${err.message}`);
        }
    }
    return bundles;
}

/**
 * Reconcile a single org against a single first-party bundle.
 * Idempotent + version-aware + self-healing (see file header).
 *
 * LICENSE-LAUNCH LL-7: an `entitlementGated` bundle follows the LICENCE in
 * BOTH directions. The org gets an install row while it holds the entitlement,
 * and the row (plus its assignment) is REMOVED the first time reconciliation
 * runs after the lease lapses. That reverse direction is the whole of
 * "deactivating removes access": the client's next hydration sees the plugin
 * gone from /me/plugins, purges its IndexedDB copy of the bundle, and the
 * 402 gate on /bundle refuses to hand the bytes back.
 *
 * Un-provisioning revokes CODE, not data: plugin_data and plugin_secrets are
 * keyed on (org_id, plugin_id) with no FK to plugin_installs, so a customer
 * who re-licences finds their configuration intact.
 *
 * @param {object} [options]
 * @param {string} [options.actor]
 * @param {(db, pluginId, orgId) => boolean} [options.hasEntitlement] — injectable
 *   for tests; defaults to lib/entitlements.js hasPlugin().
 * @returns {'installed'|'upgraded'|'refreshed'|'current'|'removed'|'absent'} the action taken
 */
export function ensureFirstPartyForOrg(db, orgId, bundle, { actor = FIRST_PARTY_ACTOR, hasEntitlement = hasPlugin, logger = console } = {}) {
    const { pluginId, version, manifestJson, bundleBuf, cssBuf, signatureJson = null } = bundle;
    const existing = getInstall(db, orgId, pluginId);

    if (bundle.entitlementGated && !hasEntitlement(db, pluginId, orgId)) {
        if (!existing) return 'absent';
        deleteInstall(db, orgId, pluginId);
        // Drop the auto-created org-wide assignment too, so a later re-grant
        // starts from a clean state rather than a dangling half-install.
        removeAssignment(db, orgId, pluginId, 'all_org_members', null);
        return 'removed';
    }

    let action;
    if (!existing) {
        createInstall(db, orgId, {
            pluginId, version, manifestJson, bundleBuf, cssBuf,
            signatureJson, installedBy: actor,
        });
        action = 'installed';
    } else if (versionLt(existing.version, version)) {
        upgradeInstall(db, orgId, {
            pluginId, version, manifestJson, bundleBuf, cssBuf,
            signatureJson, installedBy: actor,
        });
        action = 'upgraded';
    } else if (versionEq(existing.version, version)
        && (existing.bundle_sha256 !== bundleSha(bundle)
            // TRUST-PROOF plugin-frame-c1 F2: a re-sign keeps the bytes but
            // changes manifest (integrity) + signature. Without this the stored
            // copy keeps the old manifest forever and the client's integrity
            // check routes every first-party plugin to the frame. Still subject
            // to the newer-signature rollback guard below.
            || (bundle.signatureJson != null && existing.signature_json !== bundle.signatureJson))) {
        // CONTENT reconciliation. Until this branch existed, reconciliation
        // handled row EXISTENCE only, so bytes at an unchanged version were
        // never revisited and an already-provisioned org kept its original
        // bundle_blob forever — /orgs/:orgId/plugins/:pluginId/bundle serves
        // that blob, so no first-party bundle fix could reach an existing
        // customer. Found live 2026-08-31: the shared-context rebuild changed
        // every bundle on disk without touching a single manifest version, and
        // dev-servers kept serving the old, crashing bytes.
        //
        // Same replacement semantics as the admin upgrade route (PATCH
        // /orgs/:orgId/plugins/:pluginId), because it is the same helper:
        // upgradeInstall UPDATEs in place, so the install record id, its
        // installed_at and its is_enabled state all survive.
        //
        // Guarded on the sha, never unconditional: this runs orgs × bundles at
        // every boot, and an unconditional rewrite would turn a cheap sweep
        // into a fleet-wide blob write on every restart.
        //
        // LICENSE-LAUNCH LL-6d (C3): the sha guard alone let a ROLLBACK win — an
        // older image on disk has different bytes at the same version, so it
        // would overwrite NEWER bytes the DB already held. Overwrite only when
        // the on-disk bundle is provably newer (build-time signature timestamp,
        // see diskBundleIsNewer). An equal/older disk bundle is refused: the DB
        // copy is kept and the conflict is logged rather than silently clobbered.
        if (diskBundleIsNewer(existing, bundle)) {
            upgradeInstall(db, orgId, {
                pluginId, version, manifestJson, bundleBuf, cssBuf,
                signatureJson, installedBy: actor,
            });
            action = 'refreshed';
        } else {
            logger?.warn?.(`[FirstParty] ${pluginId} @ org ${orgId}: on-disk bundle differs at v${version} but is not provably newer than the stored copy (possible image rollback) — keeping DB bytes`);
            action = 'current';
        }
    } else {
        // Includes the deliberate no-downgrade case: an install NEWER than the
        // bundle on disk (hand-upgraded through the admin route, or an image
        // rollback) is left alone rather than silently replaced with older
        // bytes.
        action = 'current';
    }

    // LICENSE-LAUNCH LL-6d (C3): default visibility (all_org_members) and
    // is_enabled=1 are set ONLY on the FIRST provision ('installed'). Forcing
    // them on EVERY reconciliation silently re-enabled a plugin an admin had
    // DISABLED and re-widened one they had narrowed, at the next boot. On
    // 'upgraded' / 'refreshed' / 'current' the admin's is_enabled and explicit
    // assignments are the source of truth and are preserved untouched.
    //
    // (The insert is guarded rather than relying on assignPlugin's INSERT OR
    // IGNORE: assignPlugin is unique on (org_id, plugin_id, assignee_type,
    // assignee_id), and for all_org_members assignee_id is NULL, which SQLite
    // treats as distinct in a UNIQUE index — so OR IGNORE would not dedupe.)
    if (action === 'installed') {
        if (!getAssignment(db, orgId, pluginId, 'all_org_members', null)) {
            assignPlugin(db, orgId, pluginId, { assigneeType: 'all_org_members', assignedBy: actor });
        }
        setEnabled(db, orgId, pluginId, 1);
    }

    return action;
}

/**
 * Reconcile EVERY org against EVERY first-party bundle. Boot-time entry point.
 * Per-org/per-bundle failures are isolated (logged, skipped) so one bad row can
 * never block auth startup or the rest of the reconciliation.
 *
 * @returns {{orgs,installed,upgraded,refreshed,current,failed}} summary counts
 */
export function provisionFirstPartyPlugins(db, { bundles = null, actor = FIRST_PARTY_ACTOR, logger = console, hasEntitlement = hasPlugin } = {}) {
    ensurePluginsSchema(db);
    const set = bundles || loadFirstPartyBundles({ logger });
    // LL-7: `removed` and `absent` are first-class outcomes now, not errors —
    // an unentitled org is a correct steady state, not a failure to install.
    const summary = { orgs: 0, installed: 0, upgraded: 0, refreshed: 0, current: 0, removed: 0, absent: 0, failed: 0 };
    if (set.length === 0) return summary;

    const orgs = db.prepare('SELECT id FROM orgs').all();
    summary.orgs = orgs.length;
    for (const { id: orgId } of orgs) {
        for (const bundle of set) {
            try {
                const action = ensureFirstPartyForOrg(db, orgId, bundle, { actor, hasEntitlement, logger });
                summary[action]++;
            } catch (err) {
                summary.failed++;
                logger.error?.(`[FirstParty] ${bundle.pluginId} @ org ${orgId}: ${err.message}`);
            }
        }
    }
    return summary;
}

/**
 * Non-blocking variant of provisionFirstPartyPlugins. Same orgs×bundles get
 * reconciled, but the sweep YIELDS the event loop between chunks of orgs so
 * /health and other requests are served while it runs.
 *
 * LICENSE-LAUNCH LL-7: the synchronous version looped every org × every bundle
 * in one uninterrupted tick (135 orgs × 24 bundles ≈ 3240 iterations), freezing
 * the event loop for ~210s and starving the HTTP listener — the docker
 * healthcheck then marked auth unhealthy and a real orchestrator crash-looped
 * the container. Chunking + yielding keeps the process responsive throughout.
 *
 * @param {object} [options]
 * @param {number} [options.chunkSize=10] orgs processed per synchronous burst
 * @param {() => Promise<void>} [options.yieldFn] injectable yield (default: setImmediate)
 * @returns {Promise<{orgs,installed,upgraded,refreshed,current,removed,absent,failed}>}
 */
export async function provisionFirstPartyPluginsChunked(db, {
    bundles = null,
    actor = FIRST_PARTY_ACTOR,
    logger = console,
    hasEntitlement = hasPlugin,
    chunkSize = 10,
    yieldFn = () => new Promise((resolve) => setImmediate(resolve)),
} = {}) {
    ensurePluginsSchema(db);
    const set = bundles || loadFirstPartyBundles({ logger });
    const summary = { orgs: 0, installed: 0, upgraded: 0, refreshed: 0, current: 0, removed: 0, absent: 0, failed: 0 };
    if (set.length === 0) return summary;

    const orgs = db.prepare('SELECT id FROM orgs').all();
    summary.orgs = orgs.length;
    for (let i = 0; i < orgs.length; i++) {
        const { id: orgId } = orgs[i];
        for (const bundle of set) {
            try {
                summary[ensureFirstPartyForOrg(db, orgId, bundle, { actor, hasEntitlement, logger })]++;
            } catch (err) {
                summary.failed++;
                logger.error?.(`[FirstParty] ${bundle.pluginId} @ org ${orgId}: ${err.message}`);
            }
        }
        // Yield after each chunk of orgs (but not after the final one).
        if ((i + 1) % chunkSize === 0 && i + 1 < orgs.length) {
            await yieldFn();
        }
    }
    return summary;
}

/**
 * Fire-and-forget boot entry point. Returns IMMEDIATELY (defers the whole sweep
 * to a later tick via setImmediate), so the caller — the HTTP server — can begin
 * listening and answer /health within seconds of process start. The sweep then
 * runs in the background, chunked and yielding (see provisionFirstPartyPluginsChunked).
 *
 * Idempotent and non-fatal by contract: ensureFirstPartyForOrg also runs per-org
 * on org creation and on entitlement resolution, so a failed/partial boot sweep
 * self-heals on the next relevant event.
 *
 * @param {object} [options] forwarded to provisionFirstPartyPluginsChunked
 * @param {(summary) => void} [options.onComplete] optional completion hook (tests)
 */
export function scheduleFirstPartyProvisioning(db, options = {}) {
    const { onComplete, logger = console, ...rest } = options;
    setImmediate(() => {
        provisionFirstPartyPluginsChunked(db, { logger, ...rest })
            .then((s) => {
                logger.log?.(`[FirstParty] ${s.installed} installed · ${s.upgraded} upgraded · ${s.refreshed} refreshed · ${s.current} current · ${s.removed} removed · ${s.absent} unentitled · ${s.failed} failed across ${s.orgs} orgs`);
                onComplete?.(s);
            })
            .catch((err) => {
                logger.error?.(`[FirstParty] background provisioning failed (non-fatal): ${err.message}`);
                onComplete?.(null);
            });
    });
}

// Cached bundle set for the hot org-creation path (loaded once per process).
let _cachedBundles = null;

/**
 * Provision all first-party plugins into a single, just-created org. Called from
 * the org-creation flow AFTER the org row is committed. Non-fatal by contract:
 * a first-party failure must never fail org creation.
 *
 * @returns {{installed,upgraded,refreshed,current,failed}} summary counts
 */
export function provisionFirstPartyForNewOrg(db, orgId, { logger = console, hasEntitlement = hasPlugin } = {}) {
    if (!_cachedBundles) _cachedBundles = loadFirstPartyBundles({ logger });
    ensurePluginsSchema(db);
    const summary = { installed: 0, upgraded: 0, refreshed: 0, current: 0, removed: 0, absent: 0, failed: 0 };
    for (const bundle of _cachedBundles) {
        try {
            summary[ensureFirstPartyForOrg(db, orgId, bundle, { hasEntitlement, logger })]++;
        } catch (err) {
            summary.failed++;
            logger.error?.(`[FirstParty] new-org ${orgId} ${bundle.pluginId}: ${err.message}`);
        }
    }
    return summary;
}
