/**
 * lib/licenseClient.js — LICENSE-ENFORCE LE-2
 *
 * Outbound client to quox.ai's v2 licensing API (docs/STREAM_LICENSE_ENFORCE.md
 * §11.1). Activates a customer's license key against this instance, renews
 * the short-lived lease, and releases the seat on deactivate.
 *
 * Fail-open vs fail-closed is deliberately asymmetric here:
 *   - activate()/deactivate() are admin-initiated, synchronous actions — any
 *     failure is surfaced to the caller, nothing is assumed.
 *   - renewAll() is a background job. A quox.ai network blip must NOT kill a
 *     customer's premium entitlements (the lease still has up to 72h of life
 *     left) — keep the existing lease on network error. A single 401/409
 *     must NOT delete either: a transient authority hiccup or a
 *     misclassification would instantly downgrade a paying customer
 *     mid-session. A confirmed, authenticated revocation (`error: 'revoked'`
 *     on 401 — see quox-website/api/routes/license.js's v2/renew) removes
 *     the lease immediately, that is a real "you no longer have this"
 *     signal, not a blip. Any other 401/409 (seat_taken, invalid_license,
 *     suspended, expired) only removes the lease after
 *     MAX_CONSECUTIVE_RENEWAL_FAILURES consecutive renewal cycles reject it
 *     — a durable failure, not an isolated one. entitlements.js fails closed
 *     on missing/expired leases either way.
 */

import { getDb } from '../db/index.js';
import { verifyLease } from './licenseVerify.js';
import { ensureInstanceId, getInstanceId } from './instanceIdentity.js';
// LICENSE-LAUNCH LL-6c. Circular by design and safe: entitlements.js imports
// listStoredLeases() from here, and both bindings are hoisted function
// declarations referenced only from inside function bodies, never at module
// scope. See the note on storeLease()/deleteLeaseAndKey() below.
import { clearEntitlementsCache } from './entitlements.js';

function getLicenseServerUrl() {
    return process.env.QUOX_LICENSE_SERVER || 'https://api.quox.ai';
}

function leaseConfigKey(licenseId) {
    return `licensing.lease.${licenseId}`;
}

function keyConfigKey(licenseId) {
    return `licensing.key.${licenseId}`;
}

function renewalFailureStreakConfigKey(licenseId) {
    return `licensing.renewal_failure_streak.${licenseId}`;
}

// A single 401/409 during renewAll() must not delete a paying customer's
// lease — that would turn one flaky response (or an authority misclassifying
// a request) into an instant downgrade. Only a DURABLE run of consecutive
// rejections (this many renewal ticks in a row) proves the failure isn't a
// blip. A confirmed revocation signal (see isConfirmedRevocation() below)
// skips the streak and deletes immediately, because that is not ambiguous.
export const MAX_CONSECUTIVE_RENEWAL_FAILURES = 3;

// quox#522: streak >= this surfaces in /health as degraded. Lower than the
// deletion threshold above on purpose — the operator hears about a durable
// failure BEFORE the lease is at risk, not when it is already gone.
export const RENEWAL_HEALTH_DEGRADED_AT = 2;

/**
 * Renewal health for /health (quox#522). customer-01 renewed against the
 * wrong host for two days while the streak counted silently; the first
 * visible symptom would have been the live widget going dark. Any stored
 * streak >= RENEWAL_HEALTH_DEGRADED_AT degrades the report. Read-only,
 * cheap (instance_config is tiny), and never throws — /health calls this
 * on every probe.
 */
export function getRenewalHealth(db) {
    const failing = [];
    try {
        const rows = db.prepare(
            "SELECT key, value FROM instance_config WHERE key LIKE 'licensing.renewal_failure_streak.%'"
        ).all();
        for (const row of rows) {
            const streak = parseInt(row.value, 10);
            if (!Number.isFinite(streak) || streak < RENEWAL_HEALTH_DEGRADED_AT) continue;
            failing.push({
                license_id: row.key.slice('licensing.renewal_failure_streak.'.length),
                streak
            });
        }
    } catch {
        // A read failure here must not take /health down with it.
    }
    return { degraded: failing.length > 0, failing };
}

/**
 * POST label -> path with a JSON body. Never throws — network errors and
 * non-2xx responses are both returned as data so callers can make
 * status-specific decisions (409 seat_taken, 401 revoked, etc).
 */
async function postJson(label, path, body) {
    const url = `${getLicenseServerUrl()}${path}`;
    console.log(`[LicenseClient] ${label} -> POST ${url}`);

    let response;
    try {
        response = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(5000),
        });
    } catch (err) {
        console.error(`[LicenseClient] ${label} NETWORK ERROR: ${err.message}`);
        return { networkError: true, error: err.message };
    }

    let text = '';
    let json = null;
    try {
        text = await response.text();
        json = text ? JSON.parse(text) : null;
    } catch (err) {
        console.warn(`[LicenseClient] ${label} response body was not JSON: ${err.message}`);
    }

    const bodyExcerpt = text.slice(0, 500);
    if (!response.ok) {
        console.error(`[LicenseClient] ${label} HTTP ${response.status}: ${bodyExcerpt}`);
    } else {
        console.log(`[LicenseClient] ${label} OK (${response.status})`);
    }

    return { networkError: false, status: response.status, ok: response.ok, body: json, bodyExcerpt };
}

/**
 * LICENSE-LAUNCH LL-6c: the entitlements cache clear lives HERE, beside the
 * write, not in the callers.
 *
 * entitlements.js caches the resolved entitlement set for 10s. routes/setup.js
 * knew that and cleared after its activate/deactivate handlers, but every other
 * caller of this client (the CLI seam, the renewal job, direct importers) did
 * not — so a lease could be stored or deleted while hasPlugin() kept answering
 * from a cache built before the change, for up to 10s. On the delete paths that
 * meant a REVOKED licence still counted, which is the direction that costs
 * money. One source of truth: every lease mutation goes through these two
 * functions, so both clear. setup.js keeps its own (idempotent) call because it
 * also mutates licensing state that does not pass through here.
 */
function storeLease(db, licenseId, lease, licenseKeyString) {
    const value = JSON.stringify({ lease, stored_at: new Date().toISOString() });
    db.prepare(`
        INSERT INTO instance_config (key, value, value_type, description, updated_at)
        VALUES (?, ?, 'json', 'License lease (LICENSE-ENFORCE LE-2)', datetime('now'))
        ON CONFLICT(key) DO UPDATE SET
            value = excluded.value, value_type = 'json', updated_at = datetime('now')
    `).run(leaseConfigKey(licenseId), value);

    if (licenseKeyString) {
        db.prepare(`
            INSERT INTO instance_config (key, value, value_type, description, updated_at)
            VALUES (?, ?, 'string', 'License key string (LICENSE-ENFORCE LE-2, needed for deactivate)', datetime('now'))
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value, value_type = 'string', updated_at = datetime('now')
        `).run(keyConfigKey(licenseId), licenseKeyString);
    }

    // Every successful store (a fresh activate, or a renewAll() that got a
    // 2xx back) is proof the authority currently accepts this lease — reset
    // any consecutive-failure streak so a later blip starts counting from 0,
    // not from wherever a previous unrelated bad patch left off.
    clearRenewalFailureStreak(db, licenseId);

    clearEntitlementsCache();
}

function deleteLeaseAndKey(db, licenseId) {
    db.prepare('DELETE FROM instance_config WHERE key IN (?, ?, ?)')
        .run(leaseConfigKey(licenseId), keyConfigKey(licenseId), renewalFailureStreakConfigKey(licenseId));

    clearEntitlementsCache();
}

function getStoredKeyString(db, licenseId) {
    const row = db.prepare('SELECT value FROM instance_config WHERE key = ?').get(keyConfigKey(licenseId));
    return row?.value || null;
}

/** 0 if no streak is on record. */
function getRenewalFailureStreak(db, licenseId) {
    const row = db.prepare('SELECT value FROM instance_config WHERE key = ?').get(renewalFailureStreakConfigKey(licenseId));
    const n = row ? parseInt(row.value, 10) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
}

function setRenewalFailureStreak(db, licenseId, count) {
    db.prepare(`
        INSERT INTO instance_config (key, value, value_type, description, updated_at)
        VALUES (?, ?, 'number', 'Consecutive renewal 401/409 rejections (LICENSE-ENFORCE LE-2); deleted on success or confirmed revocation', datetime('now'))
        ON CONFLICT(key) DO UPDATE SET
            value = excluded.value, value_type = 'number', updated_at = datetime('now')
    `).run(renewalFailureStreakConfigKey(licenseId), String(count));
}

function clearRenewalFailureStreak(db, licenseId) {
    db.prepare('DELETE FROM instance_config WHERE key = ?').run(renewalFailureStreakConfigKey(licenseId));
}

/**
 * A DURABLE, authenticated "you no longer have this" signal, distinct from a
 * bare 401/409 — quox.ai's v2/renew answers `{ error: 'revoked' }` on 401
 * only when the license row's status is literally 'revoked' (see
 * quox-website/api/routes/license.js). Everything else on 401/409
 * (invalid_license, suspended, expired, seat_taken) is ambiguous enough
 * on its own that it goes through the consecutive-failure streak instead.
 */
function isConfirmedRevocation(res) {
    return res.status === 401 && res.body?.error === 'revoked';
}

/**
 * LICENSE-LAUNCH LL-6d (C2): reconcile first-party provisioning against the
 * entitlement state a licence lifecycle event just changed.
 *
 * Provisioning otherwise runs ONLY at Auth boot or on org creation, so before
 * this hook a live revocation left the first-party install row (and the client's
 * SHA-matching cached bundle) alive until the next restart — GET /me/plugins
 * kept advertising it and the client re-activated the cached bytes without ever
 * calling the gated /bundle route. The inverse hurt too: a fresh activation did
 * not grant access until the next reboot. Reconciling here, on the SAME db, the
 * moment the lease is stored/removed, closes both gaps.
 *
 * Reuses the existing bounded boot path (provisionFirstPartyPluginsChunked): it
 * loops each org once, yields between chunks, and writes only on real drift —
 * a steady state is a cheap read, so there is no unbounded loop and no
 * thundering rewrite (Loop/Restart hygiene). The listen-first boot path is
 * untouched; this is an event-driven top-up, not a second boot sweep.
 *
 * The import is dynamic on purpose: entitlements.js already closes an import
 * cycle with this module (it imports listStoredLeases from here), and
 * firstPartyProvision.js imports entitlements.js — a static import here would
 * add a third edge to that cycle. Deferring the load to call time sidesteps it.
 *
 * Non-fatal by contract: a reconciliation failure (e.g. a caller whose db has no
 * orgs table) must never fail the admin's activate/deactivate or the background
 * renewal job. It is caught and logged, nothing more.
 */
async function reconcileFirstPartyProvisioning(db) {
    try {
        const { provisionFirstPartyPluginsChunked } = await import('../utils/firstPartyProvision.js');
        await provisionFirstPartyPluginsChunked(db, { logger: console });
    } catch (err) {
        console.error(`[LicenseClient] first-party provisioning reconciliation failed (non-fatal): ${err.message}`);
    }
}

// RETIRED (LICENSE-LAUNCH LL-1a, owner ruling R7): importOfflineLicense(),
// removeImportedLicense() and listImportedLicenses() are gone. The offline
// import stored a signed license-key-v2 object under
// `licensing.imported.<id>` with no control-plane activation and no instance
// binding, so one paid key could run unlimited installs. Online activation
// (activate() below) is now the only way to hold entitlements; migration
// 100-remove-offline-imported-licenses.sql deletes any rows left behind.

/**
 * Every stored lease object (unverified — callers/entitlements.js verify).
 * Corrupted rows are skipped rather than failing the whole read.
 */
export function listStoredLeases(db) {
    const rows = db.prepare("SELECT key, value FROM instance_config WHERE key LIKE 'licensing.lease.%'").all();
    const out = [];
    for (const row of rows) {
        try {
            const parsed = JSON.parse(row.value);
            if (parsed?.lease) out.push(parsed.lease);
        } catch (err) {
            console.warn(`[LicenseClient] skipping corrupted lease row ${row.key}: ${err.message}`);
        }
    }
    return out;
}

/**
 * Activate a license key against this instance.
 *
 * @param {string} licenseKeyString — opaque key string handed to the customer.
 * @returns {Promise<object>} { ok, status, lease } | { ok:false, status, error, bound_instance_name?, message? }
 */
export async function activate(licenseKeyString) {
    if (!licenseKeyString || typeof licenseKeyString !== 'string') {
        return { ok: false, status: 400, error: 'missing_license_key' };
    }

    const db = getDb();
    const { id: instanceId, name: instanceName } = ensureInstanceId(db);

    const res = await postJson('activate', '/api/license/v2/activate', {
        license_key: licenseKeyString,
        instance_id: instanceId,
        instance_name: instanceName,
    });

    if (res.networkError) {
        return { ok: false, status: 503, error: 'license_server_unreachable', message: res.error };
    }

    if (res.status === 409) {
        // LICENSE-LAUNCH LL-3b: the control plane's 409 grew richer with LL-2a
        // — a multi-seat licence answers `seat_limit_reached` with the full
        // `bound[]` list and `max_servers`, not just a single
        // `bound_instance_name`. This used to hardcode `seat_taken` and drop
        // everything else, so the CLI/dashboard could only ever say "the seat
        // is taken" when the truth was "3 of 3 seats are in use, here they are".
        //
        // Defensive: forward only what the body actually carried. An absent
        // field is OMITTED, never invented and never nulled into existence.
        const body = res.body || {};
        const out = { ok: false, status: 409, error: body.error || 'seat_taken' };
        if (body.bound_instance_name != null) out.bound_instance_name = body.bound_instance_name;
        if (Array.isArray(body.bound)) out.bound = body.bound;
        if (body.max_servers != null) out.max_servers = body.max_servers;
        if (typeof body.message === 'string') out.message = body.message;
        return out;
    }

    if (!res.ok) {
        return { ok: false, status: res.status, error: res.body?.error || 'activation_failed', message: res.bodyExcerpt };
    }

    const lease = res.body?.lease;
    const verification = verifyLease(lease);
    if (!verification.valid) {
        console.error(`[LicenseClient] activate: quox.ai returned a lease that failed local verification: ${verification.error}`);
        return { ok: false, status: 502, error: 'invalid_lease', message: verification.error };
    }
    if (lease.instance_id !== instanceId) {
        console.error(`[LicenseClient] activate: lease.instance_id (${lease.instance_id}) != our instance id (${instanceId})`);
        return { ok: false, status: 502, error: 'instance_mismatch' };
    }

    storeLease(db, lease.license_id, lease, licenseKeyString);

    // The just-activated entitlement must provision its first-party install rows
    // now, not at the next reboot (LL-6d C2).
    await reconcileFirstPartyProvisioning(db);

    return { ok: true, status: 200, lease };
}

/**
 * Renew every stored lease. Network errors keep the existing lease (it
 * expires naturally). A 401/409 keeps the lease too, UNLESS it is a
 * confirmed revocation (removed immediately) or the
 * MAX_CONSECUTIVE_RENEWAL_FAILURES-th consecutive 401/409 in a row for that
 * license (removed, fail closed) — see isConfirmedRevocation() above.
 *
 * @returns {Promise<Array<{ license_id: string, action: 'renewed'|'kept'|'removed', reason?: string }>>}
 */
export async function renewAll() {
    const db = getDb();
    const leases = listStoredLeases(db);
    const results = [];

    for (const lease of leases) {
        const res = await postJson('renew', '/api/license/v2/renew', {
            license_id: lease.license_id,
            instance_id: lease.instance_id,
        });

        if (res.networkError) {
            console.warn(`[LicenseClient] renew network error for ${lease.license_id} — keeping existing lease (expires naturally)`);
            results.push({ license_id: lease.license_id, action: 'kept', reason: 'network_error' });
            continue;
        }

        if (res.status === 401 || res.status === 409) {
            if (isConfirmedRevocation(res)) {
                deleteLeaseAndKey(db, lease.license_id);
                console.warn(`[LicenseClient] renew HTTP 401 revoked for ${lease.license_id} — confirmed revocation, removing stored lease immediately`);
                results.push({ license_id: lease.license_id, action: 'removed', reason: 'revoked' });
                continue;
            }

            const streak = getRenewalFailureStreak(db, lease.license_id) + 1;

            if (streak < MAX_CONSECUTIVE_RENEWAL_FAILURES) {
                setRenewalFailureStreak(db, lease.license_id, streak);
                console.warn(`[LicenseClient] renew HTTP ${res.status} for ${lease.license_id} — retaining lease through failure ${streak}/${MAX_CONSECUTIVE_RENEWAL_FAILURES} consecutive (customer at risk of downgrade if this continues)`);
                results.push({ license_id: lease.license_id, action: 'kept', reason: `http_${res.status}` });
                continue;
            }

            deleteLeaseAndKey(db, lease.license_id);
            console.warn(`[LicenseClient] renew HTTP ${res.status} for ${lease.license_id} — ${streak} consecutive failures, removing stored lease (fail closed)`);
            results.push({ license_id: lease.license_id, action: 'removed', reason: `http_${res.status}` });
            continue;
        }

        if (!res.ok) {
            // Any other non-2xx is treated as a blip, not a revocation — the
            // lease still expires naturally within 72h if quox.ai stays down.
            console.warn(`[LicenseClient] renew unexpected HTTP ${res.status} for ${lease.license_id} — keeping existing lease`);
            results.push({ license_id: lease.license_id, action: 'kept', reason: `http_${res.status}` });
            continue;
        }

        const newLease = res.body?.lease;
        const verification = verifyLease(newLease);
        if (!verification.valid || newLease.instance_id !== lease.instance_id) {
            console.error(`[LicenseClient] renew: quox.ai returned an invalid lease for ${lease.license_id} — keeping the previous one`);
            results.push({ license_id: lease.license_id, action: 'kept', reason: 'invalid_new_lease' });
            continue;
        }

        const licenseKeyString = getStoredKeyString(db, lease.license_id);
        storeLease(db, newLease.license_id, newLease, licenseKeyString);
        results.push({ license_id: newLease.license_id, action: 'renewed' });
    }

    // Reconcile once, only if this tick actually changed a lease — a renewal can
    // carry a changed entitlement set, and a removal (confirmed revocation or a
    // durable failure) must un-provision. A tick of all-'kept' leaves the store
    // untouched, so there is nothing to reconcile and no sweep runs (LL-6d C2).
    if (results.some((r) => r.action === 'renewed' || r.action === 'removed')) {
        await reconcileFirstPartyProvisioning(db);
    }

    return results;
}

/**
 * Deactivate a license, freeing the seat on quox.ai (best-effort) and
 * always removing the local lease+key — the admin explicitly asked this
 * instance to stop claiming those entitlements.
 *
 * @param {string} licenseId
 */
export async function deactivate(licenseId) {
    if (!licenseId || typeof licenseId !== 'string') {
        return { ok: false, status: 400, error: 'missing_license_id' };
    }

    const db = getDb();
    const instanceId = getInstanceId(db);
    const licenseKeyString = getStoredKeyString(db, licenseId);

    if (!licenseKeyString) {
        // Nothing local to release remotely, but the caller asked to
        // deactivate — clean up any orphaned lease row and return success.
        deleteLeaseAndKey(db, licenseId);
        // Access revoked locally — un-provision now, not at the next reboot (LL-6d C2).
        await reconcileFirstPartyProvisioning(db);
        return { ok: true, status: 200, remote: false };
    }

    const res = await postJson('deactivate', '/api/license/v2/deactivate', {
        license_key: licenseKeyString,
        instance_id: instanceId,
    });

    deleteLeaseAndKey(db, licenseId);
    // The entitlement is gone locally regardless of the remote result — reconcile
    // the first-party install rows so revocation removes access immediately (LL-6d C2).
    await reconcileFirstPartyProvisioning(db);

    if (res.networkError) {
        return { ok: true, status: 200, remote: false, warning: 'license_server_unreachable' };
    }
    if (!res.ok) {
        return { ok: true, status: 200, remote: false, warning: `remote_deactivate_http_${res.status}` };
    }
    return { ok: true, status: 200, remote: true };
}

export default { activate, renewAll, deactivate, listStoredLeases };
