/**
 * PD-1 — Plugin install registry HTTP routes.
 *
 *   GET    /orgs/:orgId/plugins                    list installs (member)
 *   POST   /orgs/:orgId/plugins                    install (admin)
 *   GET    /orgs/:orgId/plugins/:pluginId          fetch one (member)
 *   GET    /orgs/:orgId/plugins/:pluginId/bundle   fetch bundle bytes (member)
 *   PATCH  /orgs/:orgId/plugins/:pluginId          enable/disable, upgrade (admin)
 *   DELETE /orgs/:orgId/plugins/:pluginId          uninstall (admin)
 *
 * Install/upgrade/uninstall are admin-only per Stream PD locked decisions
 * (admin-only install model). Read endpoints require org membership only so
 * regular members can hydrate their plugin runtime on boot.
 *
 * Bundle and CSS are accepted as base64 strings in the JSON body. The route
 * uses a 5 MB body limit — much larger than any realistic plugin (typical
 * bundles are <500 KB) but well below the 50 MB plan-level sanity cap.
 */

import { Router, json as jsonParser } from 'express';
import { ulid } from '../utils/helpers.js';
import { getDb } from '../db/index.js';
import {
    ensurePluginsSchema,
    createInstall,
    upgradeInstall,
    listInstalls,
    getInstall,
    getBundle,
    deleteInstall,
    setEnabled,
    sha256Hex as sha256OfBuf,
    setData,
    getData,
    listDataKeys,
    countDataKeys,
    removeData,
    setSecret,
    listSecretsMeta,
    getSecretMeta,
    revealSecret,
    deleteSecret,
    assignPlugin,
    listAssignments,
    removeAssignment,
    listVisiblePluginIds,
    addTrustedKey,
    listTrustedKeys,
    deleteTrustedKey,
    verifyPluginSignature,
    v1ManifestExcess,
    addRevocation,
    listRevocations,
    getRevocation,
    deleteRevocation,
    revocationFor,
    installRevocation,
    REVOCATION_KINDS,
    pluginInstallsLookupTarget,
} from '../utils/plugins.js';
import { requireAuth } from '../middleware/auth.js';
import { requireOrgMembership, requireOrgRole } from '../middleware/org.js';
import { hasPlugin, LICENSE_GOVERNED_PLUGINS } from '../lib/entitlements.js';

const router = Router();

// Route-local body parser — overrides the global 1 MB JSON limit. 5 MB allows
// realistic plugin bundles (base64-encoded, ~33% inflation) without changing
// any other route's quotas.
const installBodyParser = jsonParser({ limit: '5mb' });

function db(req) { return req.db || getDb(); }

// Short-circuit auth middleware: tests pre-populate req.user / req.org /
// req.orgMembership and skip the JWT chain entirely. Production requests fall
// through to the real requireAuth → requireOrgMembership chain.
function ensureAuthedOrg(req, res, next) {
    if (req.user && req.org && req.orgMembership) return next();
    return requireAuth(req, res, (err) => {
        if (err) return next(err);
        return requireOrgMembership(req, res, next);
    });
}

function requireAuthedOrg(req, res, next) {
    if (!req.user || !req.org) return res.status(401).json({ error: 'unauthenticated' });
    next();
}

function lazyEnsure(req) {
    try { ensurePluginsSchema(db(req)); } catch { /* noop */ }
}

function emitAudit(req, action, targetId, metadata = {}) {
    try {
        db(req).prepare(`
            INSERT INTO audit_events
                (id, org_id, actor_type, actor_id, action, target_type, target_id, status, metadata_json)
            VALUES (?, ?, 'user', ?, ?, 'plugin', ?, 'success', ?)
        `).run(ulid(), req.org.id, req.user.id, action, targetId, JSON.stringify(metadata));
    } catch (err) {
        console.error('[plugins] audit insert failed:', err.message);
    }
}

// ──────────────────────────────────────────────────────────────────────
// Validation
// ──────────────────────────────────────────────────────────────────────

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const RESERVED_PREFIXES = ['core-', 'system-', 'quox-', 'admin-'];

// Bug #3 (S2, BUGS_POWERS_PLUGINS_CLI_2026_07_09.md) — cap on durable KV rows
// per org+plugin+scope so a member can't write unbounded rows into auth.db.
const MAX_PLUGIN_DATA_KEYS = 1000;

function validateManifest(manifest) {
    if (!manifest || typeof manifest !== 'object') {
        return { ok: false, error: 'manifest_required' };
    }
    if (!manifest.id || !manifest.name || !manifest.version) {
        return { ok: false, error: 'manifest_invalid', message: 'id, name, and version are required' };
    }
    if (!PLUGIN_ID_RE.test(manifest.id)) {
        return {
            ok: false,
            error: 'manifest_invalid',
            message: 'plugin id must be lowercase alphanumeric with dashes, 3-64 chars',
        };
    }
    if (RESERVED_PREFIXES.some(p => manifest.id.startsWith(p))) {
        return {
            ok: false,
            error: 'manifest_invalid',
            message: `plugin id cannot start with reserved prefix: ${RESERVED_PREFIXES.join(', ')}`,
        };
    }
    return { ok: true };
}

function decodeBase64(s, label) {
    if (typeof s !== 'string' || !s) {
        throw new Error(`${label} required (base64 string)`);
    }
    return Buffer.from(s, 'base64');
}

// ──────────────────────────────────────────────────────────────────────
// Middleware chains
// ──────────────────────────────────────────────────────────────────────

const memberChain = [ensureAuthedOrg, requireAuthedOrg];
const adminChain  = [ensureAuthedOrg, requireAuthedOrg, requireOrgRole('admin')];

// ──────────────────────────────────────────────────────────────────────
// PD-8 signature policy — ONE function, every door that writes bundle bytes
//
// LICENSE-LAUNCH LL-6b: install (POST) verified signatures; upgrade (PATCH)
// and migrate (POST /migrate) did not. Upgrade replaces the bundle bytes
// wholesale in an existing install row, so an unsigned PATCH pushed arbitrary
// code into an org that had explicitly configured trusted keys, and every
// member's browser then executed it. Migrate calls createInstall() — a real
// first install — through a door with no check at all.
//
// Policy (unchanged, now applied uniformly): an org with at least one trusted
// key accepts only bundles carrying a valid Ed25519 signature from one of
// them. An org with no trusted keys keeps the documented back-compat
// behaviour and accepts unsigned bytes.
//
// Returns true when the caller may proceed; otherwise it has already sent the
// 403 and emitted the plugin.signature_invalid audit row.
// ──────────────────────────────────────────────────────────────────────

function enforceSignaturePolicy(req, res, { pluginId, bundleSha256, cssSha256 = null, manifest = null, signature }) {
    const trustedCount = db(req).prepare(
        `SELECT COUNT(*) AS n FROM org_trusted_keys WHERE org_id = ?`
    ).get(req.org.id).n;
    if (trustedCount === 0) return { binding: 'not_enforced' };

    const verdict = verifyPluginSignature(db(req), req.org.id, { bundleSha256, cssSha256, manifest, signature });
    if (!verdict.valid) {
        emitAudit(req, 'plugin.signature_invalid', pluginId, {
            plugin_id: pluginId,
            reason: verdict.reason,
        });
        res.status(403).json({
            error: 'signature_invalid',
            reason: verdict.reason,
            message: 'org has trusted_keys configured; signed installs only',
        });
        return false;
    }

    // SDK-TEAM W5: a v1 signature (quox-plugin-vite 0.2.0) binds the bundle
    // bytes only. Anyone holding a v1-signed bundle could re-pair it with a
    // manifest that asks for network, memory, aee or a backend and the
    // signature would still verify. So a v1 signature may only carry the
    // privileges of a self-contained UI plugin (sidebar, storage,
    // notifications). Anything more needs a v2 signature, which binds the
    // manifest. 0.2.0 plugins that stay within that allowance keep working.
    if (verdict.binding === 'v1_manifest_unbound') {
        const excess = v1ManifestExcess(manifest);
        if (excess.length) {
            emitAudit(req, 'plugin.signature_invalid', pluginId, {
                plugin_id: pluginId,
                reason: 'manifest_unbound_permissions',
                excess,
            });
            res.status(403).json({
                error: 'signature_invalid',
                reason: 'manifest_unbound_permissions',
                excess,
                message: 'a v1 signature does not bind the manifest, so it may only request sidebar, storage and notifications; re-sign with @quoxai/quox-plugin-vite (or quox-plugin-vite >= 0.3.0) (signature v2)',
            });
            return false;
        }
    }
    return { binding: verdict.binding };
}

// SDK-TEAM W5: revocation is checked on every door that writes bundle bytes,
// BEFORE the trust policy, and applies whether or not the org has trusted keys.
function enforceNotRevoked(req, res, { pluginId, bundleSha256, signature }) {
    const pub = signature && typeof signature === 'object' ? signature.public_key_hex : null;
    const r = revocationFor(db(req), req.org.id, { bundleSha256, publicKeyHex: pub });
    if (!r.revoked) return true;
    emitAudit(req, 'plugin.revoked_refused', pluginId, { plugin_id: pluginId, kind: r.kind, revocation_id: r.id || null });
    res.status(403).json({ error: 'revoked', kind: r.kind, message: 'this plugin bundle or its signer key is revoked for this org' });
    return false;
}

function refuseIfInstallRevoked(req, res, pluginId) {
    const row = getInstall(db(req), req.org.id, pluginId);
    if (!row) return true;
    const r = installRevocation(db(req), req.org.id, row);
    if (!r.revoked) return true;
    res.status(403).json({ error: 'revoked', kind: r.kind });
    return false;
}

const sha256OrNull = (buf) => (buf && buf.length ? sha256OfBuf(buf) : null);

// ──────────────────────────────────────────────────────────────────────
// List
// ──────────────────────────────────────────────────────────────────────

router.get('/orgs/:orgId/plugins', ...memberChain, (req, res) => {
    lazyEnsure(req);
    // LICENSE-LAUNCH LL-6d (C2 class-complete): the same entitlement filter as
    // /me/plugins below. This raw member list returned every install row —
    // manifest, bundle_sha256, signature — for a governed plugin regardless of
    // the org's lease, so a revoked org's member both read the metadata and, via
    // the bundle_sha256, could re-activate its cached bytes without ever hitting
    // the gated /bundle route. Filter on the same hasPlugin() check the /bundle
    // 402 gate uses; ungoverned/custom uploads and `core` pass through unchanged.
    const installs = listInstalls(db(req), req.org.id)
        .filter(row => hasPlugin(db(req), row.plugin_id, req.org.id))
        .map(row => ({
        id: row.id,
        plugin_id: row.plugin_id,
        version: row.version,
        manifest: safeParse(row.manifest_json),
        bundle_sha256: row.bundle_sha256,
        signature: safeParse(row.signature_json),
        is_enabled: !!row.is_enabled,
        installed_by: row.installed_by,
        installed_at: row.installed_at,
        upgraded_at: row.upgraded_at,
        // SDK-TEAM W5: still listed so an admin can see and uninstall it, but
        // flagged; /me/plugins (what the runtime activates from) drops it.
        revoked: installRevocation(db(req), req.org.id, row).revoked,
    }));
    res.json({ plugins: installs });
});

// ──────────────────────────────────────────────────────────────────────
// Get one (metadata only — no blob)
// ──────────────────────────────────────────────────────────────────────

router.get('/orgs/:orgId/plugins/:pluginId', ...memberChain, (req, res) => {
    lazyEnsure(req);
    // LICENSE-LAUNCH LL-6d (C2 class-complete): the metadata sibling of the
    // /bundle gate. This returned a governed plugin's manifest, version,
    // bundle_sha256 and signature to any member of a revoked org — the same
    // sha-leak that lets the client re-activate cached bytes. 402 on the same
    // hasPlugin() check the /bundle gate uses, BEFORE the row is read, so the
    // refusal body carries no metadata. Ungoverned/custom uploads pass through.
    if (!requireBundleEntitlement(req, res)) return;
    const row = getInstall(db(req), req.org.id, req.params.pluginId);
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json({
        plugin: {
            id: row.id,
            plugin_id: row.plugin_id,
            version: row.version,
            manifest: safeParse(row.manifest_json),
            bundle_sha256: row.bundle_sha256,
            signature: safeParse(row.signature_json),
            is_enabled: !!row.is_enabled,
            installed_by: row.installed_by,
            installed_at: row.installed_at,
            upgraded_at: row.upgraded_at,
            revoked: installRevocation(db(req), req.org.id, row).revoked,
        },
    });
});

// ──────────────────────────────────────────────────────────────────────
// Get bundle bytes
// ──────────────────────────────────────────────────────────────────────

// LICENSE-ENFORCE LE-3g: the last unguarded distribution surface — bundle
// and CSS bytes were served to any org member with no licence check at all
// (docs/STREAM_LICENSE_ENFORCE.md §2.5, §9 option 2 "withhold the bundle
// until signed activation"). Plugins outside LICENSE_GOVERNED_PLUGINS
// (custom org uploads via POST /orgs/:orgId/plugins above) are NOT
// licence-governed and serve exactly as before — this only gates the
// catalog ids quox.ai issues licences for.
//
// LICENSE-LAUNCH LL-7: `pluginId` is an explicit parameter because one caller
// (POST /plugins/migrate) takes the id from the posted MANIFEST rather than the
// URL. Defaulted to req.params so every existing call site is unchanged.
function requireBundleEntitlement(req, res, pluginId = req.params.pluginId) {
    if (!LICENSE_GOVERNED_PLUGINS.has(pluginId)) return true;
    if (hasPlugin(db(req), pluginId, req.org.id)) return true;
    res.status(402).json({ error: 'LICENSE_REQUIRED', plugin: pluginId });
    return false;
}

/**
 * LICENSE-LAUNCH LL-6b: the same gate, in middleware form, for the per-plugin
 * AUX surfaces (PD-3 /data, PD-4 /secrets).
 *
 * LE-3g gated distribution only. An org whose licence had lapsed could no
 * longer fetch a governed plugin's code, but every member could still read and
 * write its org data and REVEAL its stored secrets in plaintext. That is the
 * same class of hole as the collector's plugin storage routes in LL-1b: a gate
 * on one door and none on the one beside it. Scope is unchanged from LE-3g —
 * only LICENSE_GOVERNED_PLUGINS ids, so custom org uploads are untouched.
 */
function requirePluginEntitlement(req, res, next) {
    if (!requireBundleEntitlement(req, res)) return;
    next();
}

router.get('/orgs/:orgId/plugins/:pluginId/bundle', ...memberChain, (req, res) => {
    lazyEnsure(req);
    if (!requireBundleEntitlement(req, res)) return;
    if (!refuseIfInstallRevoked(req, res, req.params.pluginId)) return;
    const row = getBundle(db(req), req.org.id, req.params.pluginId);
    if (!row || !row.bundle_blob) return res.status(404).json({ error: 'not_found' });
    res.set('Content-Type', 'application/javascript');
    res.set('X-Bundle-Sha256', row.bundle_sha256);
    // No-cache is essential: the URL is fixed (/bundle) but its bytes change on
    // every plugin upgrade. Without this the browser/SW heuristically caches the
    // old bundle, so the client's sha-mismatch refetch still gets STALE bytes —
    // which is why plugin updates never reached users on reload. The client's own
    // IndexedDB sha-cache still avoids redundant fetches; this only forces the
    // HTTP layer to revalidate.
    res.set('Cache-Control', 'no-cache, must-revalidate');
    if (row.css_blob) {
        res.set('X-Css-Length', String(row.css_blob.length));
    }
    res.send(row.bundle_blob);
});

router.get('/orgs/:orgId/plugins/:pluginId/css', ...memberChain, (req, res) => {
    lazyEnsure(req);
    if (!requireBundleEntitlement(req, res)) return;
    if (!refuseIfInstallRevoked(req, res, req.params.pluginId)) return;
    const row = getBundle(db(req), req.org.id, req.params.pluginId);
    if (!row || !row.css_blob) return res.status(404).json({ error: 'not_found' });
    res.set('Content-Type', 'text/css');
    res.set('Cache-Control', 'no-cache, must-revalidate'); // same reason as /bundle — bytes change per upgrade
    res.send(row.css_blob);
});

// ──────────────────────────────────────────────────────────────────────
// Install
// ──────────────────────────────────────────────────────────────────────

router.post('/orgs/:orgId/plugins', ...adminChain, installBodyParser, (req, res) => {
    lazyEnsure(req);
    const { manifest, bundle_b64, css_b64, signature } = req.body || {};
    const v = validateManifest(manifest);
    if (!v.ok) return res.status(400).json({ error: v.error, message: v.message || null });

    // LICENSE-LAUNCH LL-6d: the same resurrection door as /migrate, one route up.
    //
    // LL-7 gated migrate because it mints an install row from bytes the CALLER
    // ALREADY HAS. This route does exactly that too, and it was left open: an
    // admin of an unentitled org could POST a governed plugin's manifest plus
    // its cached bundle (the browser holds both in IndexedDB) and get a 201.
    // That row put the plugin back in /me/plugins, the client's entitlement
    // sweep therefore spared the cached bytes, and it activated from cache
    // without ever requesting /bundle, so the 402 on distribution was never
    // reached. Gating migrate alone only closed one of a pair of identical doors.
    //
    // Checked before any byte decoding so a refusal costs nothing, and scoped as
    // ever to LICENSE_GOVERNED_PLUGINS: a custom org upload installs unchanged.
    if (!requireBundleEntitlement(req, res, manifest.id)) return;

    let bundleBuf, cssBuf;
    try {
        bundleBuf = decodeBase64(bundle_b64, 'bundle_b64');
        cssBuf = css_b64 ? decodeBase64(css_b64, 'css_b64') : null;
    } catch (err) {
        return res.status(400).json({ error: 'invalid_input', message: err.message });
    }
    if (bundleBuf.length === 0) {
        return res.status(400).json({ error: 'invalid_input', message: 'bundle is empty' });
    }

    // PD-8: signature policy. If the org has any trusted keys configured, we
    // require a valid signature. If none configured, unsigned installs are
    // accepted for back-compat. Shared with upgrade + migrate (LL-6b).
    if (!enforceNotRevoked(req, res, { pluginId: manifest.id, bundleSha256: sha256OfBuf(bundleBuf), signature })) return;
    const policy = enforceSignaturePolicy(req, res, {
        pluginId: manifest.id,
        bundleSha256: sha256OfBuf(bundleBuf),
        cssSha256: sha256OrNull(cssBuf),
        manifest,
        signature,
    });
    if (!policy) return;

    try {
        const install = createInstall(db(req), req.org.id, {
            pluginId: manifest.id,
            version: manifest.version,
            manifestJson: JSON.stringify(manifest),
            bundleBuf,
            cssBuf,
            signatureJson: signature ? JSON.stringify(signature) : null,
            installedBy: req.user.id,
        });
        emitAudit(req, 'plugin.installed', install.id, {
            plugin_id: install.plugin_id,
            version: install.version,
            bundle_sha256: install.bundle_sha256,
            signature_binding: policy.binding,
        });
        // PD-7: default visibility = all org members. Admin can replace this
        // with explicit user/team rows via /assignments.
        try {
            assignPlugin(db(req), req.org.id, install.plugin_id, {
                assigneeType: 'all_org_members',
                assignedBy: req.user.id,
            });
        } catch (e) {
            console.warn('[plugins] default assignment failed:', e.message);
        }
        res.status(201).json({ plugin: hydrate(install) });
    } catch (err) {
        const msg = String(err?.message || err);
        if (/UNIQUE/i.test(msg)) {
            return res.status(409).json({ error: 'already_installed', message: 'plugin already installed for this org; use PATCH to upgrade' });
        }
        return res.status(400).json({ error: 'invalid_input', message: msg });
    }
});

// ──────────────────────────────────────────────────────────────────────
// PD-2 — Migration from legacy IndexedDB-only installs
//
// Idempotent admin endpoint. Used by the frontend on first boot post-PD-1
// deploy to push pre-existing browser-side installs into the server registry.
// Behaviour:
//   - no record: insert + audit `plugin.migrated_from_local` (201)
//   - record present with same sha256: no-op success (200, migrated=false)
//   - record present with different sha256: skip; server is authoritative
//     (200, migrated=false, reason='sha_mismatch_server_authoritative')
// ──────────────────────────────────────────────────────────────────────

router.post('/orgs/:orgId/plugins/migrate', ...adminChain, installBodyParser, (req, res) => {
    lazyEnsure(req);
    const { manifest, bundle_b64, css_b64, signature } = req.body || {};
    const v = validateManifest(manifest);
    if (!v.ok) return res.status(400).json({ error: v.error, message: v.message || null });

    // LICENSE-LAUNCH LL-7 — the resurrection door, closed.
    //
    // LE-3g's install-plane carve-out ("withhold the bundle, not the row") rests
    // on the row being INERT without an entitlement. That holds for PATCH
    // upgrade, which needs a row to already exist. It does NOT hold here.
    // Migrate mints a row from bytes THE CALLER ALREADY HAS, and the browser is
    // exactly such a caller: src/services/thirdPartyPluginHost.js re-POSTs its
    // IndexedDB cache to this route on boot. So an org admin whose licence had
    // lapsed re-created the install row from the cached bundle on the next page
    // load; the row put the plugin back in /me/plugins, the client's
    // entitlement sweep therefore spared the cached bytes, and the plugin
    // activated from cache without ever asking for /bundle. The 402 on
    // distribution was never reached, and "deactivating removes access" was
    // false for every admin. Found by the LL-7 buyer-to-install journey test.
    //
    // Gated BEFORE the already-installed no-op branch below on purpose: this is
    // a handler-level refusal, not a side effect of which branch happens to run.
    // Scope is the usual one — LICENSE_GOVERNED_PLUGINS only, so a custom org
    // upload migrates exactly as before.
    if (!requireBundleEntitlement(req, res, manifest.id)) return;

    let bundleBuf, cssBuf;
    try {
        bundleBuf = decodeBase64(bundle_b64, 'bundle_b64');
        cssBuf = css_b64 ? decodeBase64(css_b64, 'css_b64') : null;
    } catch (err) {
        return res.status(400).json({ error: 'invalid_input', message: err.message });
    }
    if (bundleBuf.length === 0) {
        return res.status(400).json({ error: 'invalid_input', message: 'bundle is empty' });
    }

    const existing = getInstall(db(req), req.org.id, manifest.id);
    if (existing) {
        const sha = sha256OfBuf(bundleBuf);
        const reason = existing.bundle_sha256 === sha
            ? 'already_present'
            : 'sha_mismatch_server_authoritative';
        return res.status(200).json({ plugin: hydrate(existing), migrated: false, reason });
    }

    // LL-6b: migrate is a genuine FIRST install (createInstall below), so it
    // answers to the same PD-8 policy as POST /plugins. Checked only on the
    // insert path — the no-op branches above write nothing.
    if (!enforceNotRevoked(req, res, { pluginId: manifest.id, bundleSha256: sha256OfBuf(bundleBuf), signature })) return;
    if (!enforceSignaturePolicy(req, res, {
        pluginId: manifest.id,
        bundleSha256: sha256OfBuf(bundleBuf),
        cssSha256: sha256OrNull(cssBuf),
        manifest,
        signature,
    })) return;

    try {
        const install = createInstall(db(req), req.org.id, {
            pluginId: manifest.id,
            version: manifest.version,
            manifestJson: JSON.stringify(manifest),
            bundleBuf,
            cssBuf,
            signatureJson: signature ? JSON.stringify(signature) : null,
            installedBy: req.user.id,
        });
        emitAudit(req, 'plugin.migrated_from_local', install.id, {
            plugin_id: install.plugin_id,
            version: install.version,
            bundle_sha256: install.bundle_sha256,
        });
        // PD-7 + audit fix: migrated plugins also get the default
        // 'all_org_members' visibility row so they are reachable. Without
        // this the plugin would be invisible to every member until an admin
        // manually added an assignment.
        try {
            assignPlugin(db(req), req.org.id, install.plugin_id, {
                assigneeType: 'all_org_members',
                assignedBy: req.user.id,
            });
        } catch (e) {
            console.warn('[plugins] migrate default assignment failed:', e.message);
        }
        return res.status(201).json({ plugin: hydrate(install), migrated: true });
    } catch (err) {
        return res.status(400).json({ error: 'invalid_input', message: String(err?.message || err) });
    }
});

// ──────────────────────────────────────────────────────────────────────
// Patch — upgrade and/or toggle enabled
// ──────────────────────────────────────────────────────────────────────

router.patch('/orgs/:orgId/plugins/:pluginId', ...adminChain, installBodyParser, (req, res) => {
    lazyEnsure(req);
    const existing = getInstall(db(req), req.org.id, req.params.pluginId);
    if (!existing) return res.status(404).json({ error: 'not_found' });

    const body = req.body || {};

    // Toggle enabled — independent of upgrade
    if ('is_enabled' in body) {
        setEnabled(db(req), req.org.id, req.params.pluginId, !!body.is_enabled);
        emitAudit(req, body.is_enabled ? 'plugin.enabled' : 'plugin.disabled', existing.id, {
            plugin_id: existing.plugin_id,
        });
    }

    // Upgrade — full bundle replacement, preserves install record id
    if (body.manifest || body.bundle_b64) {
        const v = validateManifest(body.manifest || JSON.parse(existing.manifest_json));
        if (!v.ok) return res.status(400).json({ error: v.error, message: v.message || null });
        const manifest = body.manifest || JSON.parse(existing.manifest_json);
        if (manifest.id !== req.params.pluginId) {
            return res.status(400).json({ error: 'plugin_id_mismatch', message: 'manifest id must match URL plugin id' });
        }
        if (!body.bundle_b64) {
            return res.status(400).json({ error: 'invalid_input', message: 'upgrade requires bundle_b64' });
        }

        // LICENSE-LAUNCH LL-6d: an upgrade REPLACES the executable bytes of a
        // governed plugin, so it answers to the licence like the install beside
        // it. Upgrade cannot mint a row (404 above), so this is not the
        // resurrection shape, but an org whose lease has lapsed still has no
        // business rewriting governed code that its members' browsers run.
        //
        // Deliberately inside the upgrade branch, not at the top of the handler:
        // the is_enabled toggle above and DELETE uninstall stay open, so a
        // lapsed admin can always disable or remove. A gate that locked an
        // admin out of cleaning up would be a lockout, not enforcement.
        if (!requireBundleEntitlement(req, res, req.params.pluginId)) return;
        let bundleBuf, cssBuf;
        try {
            bundleBuf = decodeBase64(body.bundle_b64, 'bundle_b64');
            cssBuf = body.css_b64 ? decodeBase64(body.css_b64, 'css_b64') : null;
        } catch (err) {
            return res.status(400).json({ error: 'invalid_input', message: err.message });
        }

        // LL-6b: an upgrade replaces the executable bytes every member's
        // browser runs, so it MUST clear the same PD-8 bar as the first
        // install. Checked BEFORE upgradeInstall() so a refused upgrade
        // cannot have already overwritten the good bundle.
        if (!enforceNotRevoked(req, res, { pluginId: req.params.pluginId, bundleSha256: sha256OfBuf(bundleBuf), signature: body.signature })) return;
        if (!enforceSignaturePolicy(req, res, {
            pluginId: req.params.pluginId,
            bundleSha256: sha256OfBuf(bundleBuf),
            cssSha256: sha256OrNull(cssBuf),
            manifest,
            signature: body.signature,
        })) return;

        const upgraded = upgradeInstall(db(req), req.org.id, {
            pluginId: req.params.pluginId,
            version: manifest.version,
            manifestJson: JSON.stringify(manifest),
            bundleBuf,
            cssBuf,
            signatureJson: body.signature ? JSON.stringify(body.signature) : null,
            installedBy: req.user.id,
        });
        emitAudit(req, 'plugin.upgraded', upgraded.id, {
            plugin_id: upgraded.plugin_id,
            from_version: existing.version,
            to_version: upgraded.version,
            bundle_sha256: upgraded.bundle_sha256,
        });
        return res.json({ plugin: hydrate(upgraded) });
    }

    const fresh = getInstall(db(req), req.org.id, req.params.pluginId);
    return res.json({ plugin: hydrate(fresh) });
});

// ──────────────────────────────────────────────────────────────────────
// Uninstall
// ──────────────────────────────────────────────────────────────────────

router.delete('/orgs/:orgId/plugins/:pluginId', ...adminChain, (req, res) => {
    lazyEnsure(req);
    const existing = getInstall(db(req), req.org.id, req.params.pluginId);
    if (!existing) return res.status(404).json({ error: 'not_found' });
    // LL-6b: a deliberate admin uninstall reaps the plugin's durable KV and
    // encrypted secrets too. Without this they were orphaned permanently —
    // no route could list them, none could delete them, and secret ciphertext
    // stayed decryptable in auth.db forever (LL-7i1: "plugin_installs has no
    // reaper"). The entitlement-lapse un-provision path deliberately does NOT
    // purge; see deleteInstall()'s doc comment.
    const purged = deleteInstall(db(req), req.org.id, req.params.pluginId, { purgeData: true });
    emitAudit(req, 'plugin.uninstalled', existing.id, {
        plugin_id: existing.plugin_id,
        version: existing.version,
        purged_data_rows: purged.purgedDataRows,
        purged_secret_rows: purged.purgedSecretRows,
    });
    res.status(204).end();
});

// ──────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────
// PD-3 — plugin-scoped durable KV (api.durable backend)
//
// Members of the org can read/write keys for any installed plugin (this is
// plugin runtime data — gating to admin would block plugins from working for
// most users). Cross-plugin and cross-org reads are isolated at the query
// layer; ?scope=user gates rows to the calling user only.
// ──────────────────────────────────────────────────────────────────────

const dataBodyParser = jsonParser({ limit: '1mb' });

function dataScope(req) {
    return req.query?.scope === 'user' ? 'user' : 'org';
}

router.get('/orgs/:orgId/plugins/:pluginId/data', ...memberChain, requirePluginEntitlement, (req, res) => {
    lazyEnsure(req);
    const install = getInstall(db(req), req.org.id, req.params.pluginId);
    if (!install) return res.status(404).json({ error: 'not_found' });
    const keys = listDataKeys(db(req), req.org.id, req.params.pluginId, {
        scope: dataScope(req),
        userId: req.user.id,
    });
    res.json({ keys });
});

router.get('/orgs/:orgId/plugins/:pluginId/data/:key', ...memberChain, requirePluginEntitlement, (req, res) => {
    lazyEnsure(req);
    const install = getInstall(db(req), req.org.id, req.params.pluginId);
    if (!install) return res.status(404).json({ error: 'not_found' });
    const row = getData(db(req), req.org.id, req.params.pluginId, req.params.key, {
        scope: dataScope(req),
        userId: req.user.id,
    });
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json(row);
});

router.put('/orgs/:orgId/plugins/:pluginId/data/:key', ...memberChain, requirePluginEntitlement, dataBodyParser, (req, res) => {
    lazyEnsure(req);
    const install = getInstall(db(req), req.org.id, req.params.pluginId);
    if (!install) return res.status(404).json({ error: 'not_found' });
    const body = req.body || {};
    if (!('value' in body)) {
        return res.status(400).json({ error: 'invalid_input', message: 'body.value required' });
    }
    try {
        const scope = dataScope(req);
        const existing = getData(db(req), req.org.id, req.params.pluginId, req.params.key, {
            scope,
            userId: req.user.id,
        });
        if (!existing) {
            const count = countDataKeys(db(req), req.org.id, req.params.pluginId, {
                scope,
                userId: req.user.id,
            });
            if (count >= MAX_PLUGIN_DATA_KEYS) {
                return res.status(422).json({
                    error: 'quota_exceeded',
                    message: `plugin data key limit reached (${MAX_PLUGIN_DATA_KEYS} keys per org/plugin/scope)`,
                });
            }
        }
        const row = setData(db(req), req.org.id, req.params.pluginId, req.params.key, body.value, {
            scope,
            userId: req.user.id,
        });
        emitAudit(req, 'plugin.data_changed', req.params.pluginId, {
            key: req.params.key,
            scope,
        });
        res.json(row);
    } catch (err) {
        res.status(400).json({ error: 'invalid_input', message: String(err?.message || err) });
    }
});

router.delete('/orgs/:orgId/plugins/:pluginId/data/:key', ...memberChain, requirePluginEntitlement, (req, res) => {
    lazyEnsure(req);
    const install = getInstall(db(req), req.org.id, req.params.pluginId);
    if (!install) return res.status(404).json({ error: 'not_found' });
    removeData(db(req), req.org.id, req.params.pluginId, req.params.key, {
        scope: dataScope(req),
        userId: req.user.id,
    });
    res.status(204).end();
});

// ──────────────────────────────────────────────────────────────────────
// PD-4 — plugin-scoped encrypted secrets (api.secrets backend)
//
// Set/delete are admin-only. Reveal is member-allowed because plugins run in
// every member's session and need to read their own secrets at runtime; every
// reveal emits an audit row so plaintext access is traceable. Listing returns
// metadata only (no ciphertext, no plaintext).
// ──────────────────────────────────────────────────────────────────────

router.get('/orgs/:orgId/plugins/:pluginId/secrets', ...memberChain, requirePluginEntitlement, (req, res) => {
    lazyEnsure(req);
    const install = getInstall(db(req), req.org.id, req.params.pluginId);
    if (!install) return res.status(404).json({ error: 'not_found' });
    const secrets = listSecretsMeta(db(req), req.org.id, req.params.pluginId);
    res.json({ secrets });
});

router.put('/orgs/:orgId/plugins/:pluginId/secrets/:name', ...adminChain, requirePluginEntitlement, dataBodyParser, (req, res) => {
    lazyEnsure(req);
    const body = req.body || {};
    if (typeof body.value !== 'string' || body.value.length === 0) {
        return res.status(400).json({ error: 'invalid_input', message: 'body.value (non-empty string) required' });
    }
    try {
        const meta = setSecret(db(req), req.org.id, req.params.pluginId, req.params.name, body.value, {
            createdBy: req.user.id,
            description: body.description || null,
        });
        emitAudit(req, meta?.rotated_at ? 'plugin.secret_rotated' : 'plugin.secret_set', req.params.pluginId, {
            name: req.params.name,
        });
        res.status(200).json({ secret: meta });
    } catch (err) {
        res.status(400).json({ error: 'invalid_input', message: String(err?.message || err) });
    }
});

router.post('/orgs/:orgId/plugins/:pluginId/secrets/:name/reveal', ...memberChain, requirePluginEntitlement, (req, res) => {
    lazyEnsure(req);
    const out = revealSecret(db(req), req.org.id, req.params.pluginId, req.params.name);
    if (!out) return res.status(404).json({ error: 'not_found' });
    emitAudit(req, 'plugin.secret_accessed', req.params.pluginId, { name: out.name });
    res.json({ id: out.id, name: out.name, value: out.value });
});

router.delete('/orgs/:orgId/plugins/:pluginId/secrets/:name', ...adminChain, requirePluginEntitlement, (req, res) => {
    lazyEnsure(req);
    const existing = getSecretMeta(db(req), req.org.id, req.params.pluginId, req.params.name);
    if (!existing) return res.status(404).json({ error: 'not_found' });
    deleteSecret(db(req), req.org.id, req.params.pluginId, req.params.name);
    emitAudit(req, 'plugin.secret_deleted', req.params.pluginId, { name: req.params.name });
    res.status(204).end();
});

// ──────────────────────────────────────────────────────────────────────
// PD-7 — Admin-controlled plugin assignment
// ──────────────────────────────────────────────────────────────────────

router.get('/orgs/:orgId/plugins/:pluginId/assignments', ...adminChain, (req, res) => {
    lazyEnsure(req);
    const install = getInstall(db(req), req.org.id, req.params.pluginId);
    if (!install) return res.status(404).json({ error: 'not_found' });
    const rows = listAssignments(db(req), req.org.id, req.params.pluginId);
    res.json({ assignments: rows });
});

router.post('/orgs/:orgId/plugins/:pluginId/assignments', ...adminChain, dataBodyParser, (req, res) => {
    lazyEnsure(req);
    const install = getInstall(db(req), req.org.id, req.params.pluginId);
    if (!install) return res.status(404).json({ error: 'not_found' });
    const { assignee_type, assignee_id = null } = req.body || {};
    try {
        const row = assignPlugin(db(req), req.org.id, req.params.pluginId, {
            assigneeType: assignee_type,
            assigneeId: assignee_id,
            assignedBy: req.user.id,
        });
        emitAudit(req, 'plugin.assigned', req.params.pluginId, { assignee_type, assignee_id });
        res.status(201).json({ assignment: row });
    } catch (err) {
        res.status(400).json({ error: 'invalid_input', message: String(err?.message || err) });
    }
});

router.delete('/orgs/:orgId/plugins/:pluginId/assignments/:assigneeType/:assigneeId?', ...adminChain, (req, res) => {
    lazyEnsure(req);
    const install = getInstall(db(req), req.org.id, req.params.pluginId);
    if (!install) return res.status(404).json({ error: 'not_found' });
    const t = req.params.assigneeType;
    const id = req.params.assigneeId || null;
    removeAssignment(db(req), req.org.id, req.params.pluginId, t, id);
    emitAudit(req, 'plugin.unassigned', req.params.pluginId, { assignee_type: t, assignee_id: id });
    res.status(204).end();
});

/**
 * Visibility resolver: returns the plugins the calling user can see in the
 * given org. Used by the dashboard host on boot to populate the runtime
 * plugin list — supersedes the legacy "list all installs" path for member
 * users so admin restrictions take effect immediately.
 */
router.get('/orgs/:orgId/me/plugins', ...memberChain, (req, res) => {
    lazyEnsure(req);
    // LICENSE-LAUNCH LL-6d (C2): defense in depth. A governed plugin whose
    // entitlement is absent must NOT be advertised here, even if a stale install
    // row survived a revocation (reconciliation removes the row, but this list is
    // what the client compares its cached bundle SHA against — an advertised row
    // would let the client re-activate the cached bundle without ever hitting the
    // gated /bundle route). Same hasPlugin() check the /bundle 402 gate uses;
    // ungoverned/custom uploads and `core` pass through unchanged.
    const visibleIds = listVisiblePluginIds(db(req), req.org.id, req.user.id)
        .filter((id) => hasPlugin(db(req), id, req.org.id));
    if (visibleIds.length === 0) return res.json({ plugins: [] });
    const placeholders = visibleIds.map(() => '?').join(',');
    const rows = db(req).prepare(`
        SELECT id, plugin_id, version, manifest_json, bundle_sha256, signature_json, is_enabled,
               installed_by, installed_at, upgraded_at
          FROM ${pluginInstallsLookupTarget(db(req))}
         WHERE org_id = ? AND plugin_id IN (${placeholders})
         ORDER BY installed_at DESC
    `).all(req.org.id, ...visibleIds);
    // No-cache: this list carries each plugin's bundle_sha256, which the client
    // compares against its IndexedDB cache to decide whether to refetch. If the
    // browser serves a stale copy of THIS response, the client never learns a new
    // version shipped, so the bundle/css no-cache headers alone can't help. All
    // three (list + bundle + css) must revalidate for updates to reach clients.
    res.set('Cache-Control', 'no-cache, must-revalidate');
    // SDK-TEAM W5: a revoked install is not advertised, so the client's
    // unlisted-cache sweep purges its bytes and it stops activating.
    const live = rows.filter((r) => !installRevocation(db(req), req.org.id, r).revoked);
    res.json({ plugins: live.map(hydrate) });
});

// ──────────────────────────────────────────────────────────────────────
// PD-8 — Per-org trusted Ed25519 keys
// ──────────────────────────────────────────────────────────────────────

router.get('/orgs/:orgId/trusted-keys', ...adminChain, (req, res) => {
    lazyEnsure(req);
    res.json({ trusted_keys: listTrustedKeys(db(req), req.org.id) });
});

router.post('/orgs/:orgId/trusted-keys', ...adminChain, dataBodyParser, (req, res) => {
    lazyEnsure(req);
    const { label, public_key_hex } = req.body || {};
    try {
        const row = addTrustedKey(db(req), req.org.id, {
            label, publicKeyHex: public_key_hex, addedBy: req.user.id,
        });
        emitAudit(req, 'plugin.trusted_key_added', row.id, { label });
        res.status(201).json({ trusted_key: row });
    } catch (err) {
        const msg = String(err?.message || err);
        if (/UNIQUE/i.test(msg)) {
            return res.status(409).json({ error: 'duplicate', message: 'public key already trusted' });
        }
        res.status(400).json({ error: 'invalid_input', message: msg });
    }
});

router.delete('/orgs/:orgId/trusted-keys/:keyId', ...adminChain, (req, res) => {
    lazyEnsure(req);
    const existing = db(req).prepare(
        `SELECT id, label FROM org_trusted_keys WHERE org_id = ? AND id = ?`
    ).get(req.org.id, req.params.keyId);
    if (!existing) return res.status(404).json({ error: 'not_found' });
    // F9: the signature policy is derived from COUNT(org_trusted_keys), so removing
    // the last key silently re-opens the org to unsigned bundles. Require an
    // explicit confirmation and leave a distinct audit trail when it happens.
    const remaining = db(req).prepare(
        `SELECT COUNT(*) AS c FROM org_trusted_keys WHERE org_id = ?`
    ).get(req.org.id).c;
    const isLast = remaining <= 1;
    const confirmed = ['1', 'true'].includes(String(req.query?.confirm_unsigned ?? '').toLowerCase());
    if (isLast && !confirmed) {
        return res.status(409).json({
            error: 'last_trusted_key',
            message: 'Removing the last trusted key makes this org accept UNSIGNED plugin bundles. Re-send with confirm_unsigned=1 to confirm the downgrade.',
        });
    }
    deleteTrustedKey(db(req), req.org.id, req.params.keyId);
    emitAudit(req, 'plugin.trusted_key_removed', existing.id, { label: existing.label });
    if (isLast) {
        emitAudit(req, 'plugin.signature_policy_downgraded', existing.id, {
            key_id: existing.id, label: existing.label, actor_id: req.user.id,
            from: 'signed_required', to: 'unsigned_accepted',
        });
        return res.status(200).json({ ok: true, signature_policy: 'unsigned_accepted' });
    }
    res.status(204).end();
});

// ──────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────
// SDK-TEAM W5: org-scoped revocation (admin)
// ──────────────────────────────────────────────────────────────────────

router.get('/orgs/:orgId/plugin-revocations', ...adminChain, (req, res) => {
    lazyEnsure(req);
    res.json({ revocations: listRevocations(db(req), req.org.id) });
});

router.post('/orgs/:orgId/plugin-revocations', ...adminChain, dataBodyParser, (req, res) => {
    lazyEnsure(req);
    const { kind, value, reason } = req.body || {};
    if (!REVOCATION_KINDS.has(kind)) {
        return res.status(400).json({ error: 'invalid_input', message: 'kind must be signer_key or bundle_digest' });
    }
    try {
        const row = addRevocation(db(req), req.org.id, { kind, value, reason, revokedBy: req.user.id });
        emitAudit(req, 'plugin.revocation_added', row.id, { kind: row.kind, value: row.value, reason: row.reason });
        res.status(201).json({ revocation: row });
    } catch (err) {
        const msg = String(err?.message || err);
        if (/UNIQUE/i.test(msg)) return res.status(409).json({ error: 'duplicate', message: 'already revoked' });
        res.status(400).json({ error: 'invalid_input', message: msg });
    }
});

router.delete('/orgs/:orgId/plugin-revocations/:revocationId', ...adminChain, (req, res) => {
    lazyEnsure(req);
    const row = getRevocation(db(req), req.org.id, req.params.revocationId);
    if (!row) return res.status(404).json({ error: 'not_found' });
    deleteRevocation(db(req), req.org.id, row.id);
    emitAudit(req, 'plugin.revocation_removed', row.id, { kind: row.kind, value: row.value });
    res.status(204).end();
});

// ──────────────────────────────────────────────────────────────────────

function safeParse(s) {
    if (!s) return null;
    try { return JSON.parse(s); } catch { return null; }
}

function hydrate(row) {
    return {
        id: row.id,
        plugin_id: row.plugin_id,
        version: row.version,
        manifest: safeParse(row.manifest_json),
        bundle_sha256: row.bundle_sha256,
        signature: safeParse(row.signature_json),
        is_enabled: !!row.is_enabled,
        installed_by: row.installed_by,
        installed_at: row.installed_at,
        upgraded_at: row.upgraded_at,
    };
}

export default router;
