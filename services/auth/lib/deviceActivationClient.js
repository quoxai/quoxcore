/**
 * lib/deviceActivationClient.js — LICENSE-LAUNCH LL-8-dash
 *
 * The box half of the device-code activation flow, so an instance can be
 * licensed with nothing pasted into it. RFC 8628 shape, against the control
 * plane already shipped on quox.ai (LL-8-api, api/routes/license.js):
 *
 *   POST /api/license/device/start { instance_id, instance_name }
 *        -> { device_code, user_code, verification_url, expires_in, interval }
 *   POST /api/license/device/poll  { device_code }
 *        -> pending | slow_down | approved | denied | expired | consumed
 *           | seat_limit_reached
 *
 * The device_code is this box's bearer secret and never leaves the server:
 * the dashboard and the CLI talk to routes/setup.js, which wraps this client.
 *
 * LEASE STORAGE — deliberate coupling note. licenseClient.js keeps
 * storeLease() private (it also owns the entitlements-cache clear that has to
 * happen beside every lease write, LL-6c). Rather than copy that logic here
 * and end up with two writers that can drift, an approved poll forwards the
 * `license_key` the control plane hands back into licenseClient.activate() —
 * the SAME storage path a pasted key takes, verbatim, including lease
 * verification, the instance-id match and the cache clear.
 *
 * The cost is one extra round trip to /api/license/v2/activate. It is safe:
 * bindInstanceSeat is idempotent for an instance that already holds a slot
 * (the poll bound it moments earlier), so no second seat is burned. If that
 * call fails the code has already been consumed, so we say `activation_failed`
 * plainly and the customer starts a new link rather than being told they are
 * licensed when nothing was stored.
 */

import { getDb } from '../db/index.js';
import { ensureInstanceId } from './instanceIdentity.js';
import { activate } from './licenseClient.js';
import { loadSignedCatalog } from './signedCatalog.js';
import { assertFreeOnlyLicenseKey } from './freeClaimGuard.js';

// Same resolution licenseClient.js uses for the upstream base URL. Read from
// the environment at call time (not module load) so tests and the fleet can
// point a box at a staging control plane without a restart-order dependency.
function getLicenseServerUrl() {
    return process.env.QUOX_LICENSE_SERVER || 'https://api.quox.ai';
}

// RFC 8628 §3.5: on slow_down the client increases its polling interval. Five
// seconds is the increment the spec suggests and the control plane's own
// interval floor.
const SLOW_DOWN_STEP_SECONDS = 5;
const DEFAULT_INTERVAL_SECONDS = 5;

/**
 * POST label -> path with a JSON body. Never throws: network errors and
 * non-2xx responses both come back as data so the state machine below can
 * make status-specific decisions.
 */
async function postJson(label, path, body) {
    const url = `${getLicenseServerUrl()}${path}`;
    console.log(`[DeviceActivation] ${label} -> POST ${url}`);

    let response;
    try {
        response = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(5000),
        });
    } catch (err) {
        console.error(`[DeviceActivation] ${label} NETWORK ERROR: ${err.message}`);
        return { networkError: true, error: err.message };
    }

    let text = '';
    let json = null;
    try {
        text = await response.text();
        json = text ? JSON.parse(text) : null;
    } catch (err) {
        console.warn(`[DeviceActivation] ${label} response body was not JSON: ${err.message}`);
    }

    if (!response.ok) {
        // The device_code is a bearer secret; only the status and the error
        // code are logged, never the body.
        console.warn(`[DeviceActivation] ${label} HTTP ${response.status} (${json?.error || 'no error code'})`);
    } else {
        console.log(`[DeviceActivation] ${label} OK (${response.status}) status=${json?.status || 'n/a'}`);
    }

    return { networkError: false, status: response.status, ok: response.ok, body: json };
}

function intervalFrom(body, fallback) {
    const value = Number(body?.interval);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Ask the control plane for a code pair for THIS instance.
 *
 * @param {{ requested?: { kind: string, plugin_ids: string[] } }} [options]
 *   LICENSE-LAUNCH LL-8: `requested` carries the self-serve free-claim
 *   context (`{ kind: 'free_claim', plugin_ids }`) so the control plane can
 *   scope the resulting code pair to exactly those products. Omitted for the
 *   existing instance-admin paid flow — the field is additive on the wire,
 *   never sent unless a caller asks for it.
 * @returns {Promise<object>}
 *   { state: 'started', device_code, user_code, verification_url, expires_in, interval }
 *   | { state: 'unreachable', error, message }
 *   | { state: 'error', status, error, message }
 */
export async function startDeviceActivation(options = {}) {
    const db = getDb();
    const { id: instanceId, name: instanceName } = ensureInstanceId(db);

    const reqBody = { instance_id: instanceId, instance_name: instanceName };
    if (options.requested) reqBody.requested = options.requested;

    const res = await postJson('start', '/api/license/device/start', reqBody);

    if (res.networkError) {
        return { state: 'unreachable', error: 'license_server_unreachable', message: res.error };
    }
    if (!res.ok) {
        return {
            state: 'error',
            status: res.status,
            error: res.body?.error || 'device_start_failed',
            message: res.body?.reason || res.body?.message || null,
        };
    }

    const body = res.body || {};
    if (!body.device_code || !body.user_code) {
        return { state: 'error', status: res.status, error: 'malformed_device_start', message: 'The control plane did not return a code pair.' };
    }

    return {
        state: 'started',
        device_code: body.device_code,
        user_code: body.user_code,
        verification_url: body.verification_url || null,
        expires_in: Number(body.expires_in) || null,
        interval: intervalFrom(body, DEFAULT_INTERVAL_SECONDS),
        instance_id: instanceId,
        instance_name: instanceName,
    };
}

/**
 * One poll step against the control plane, with every non-approved outcome
 * fully interpreted (pending / slow_down / expired / denied / seat_limit /
 * consumed / error / unreachable). Shared by pollDeviceActivation (paid,
 * instance-admin) and pollFreeDeviceActivation (free-claim, org owner/admin,
 * LICENSE-LAUNCH LL-8) so the two flows read the wire exactly the same way —
 * only what happens on an `approved` body differs between them.
 *
 * @returns {Promise<{ terminal_result: object }|{ approved: true, body: object }>}
 *   `terminal_result` is a fully-formed state object the caller returns
 *   as-is. `{ approved, body }` hands the raw approved body back so the
 *   caller decides how to activate it.
 */
async function pollRaw(deviceCode, options = {}) {
    if (!deviceCode || typeof deviceCode !== 'string') {
        return { terminal_result: { state: 'error', terminal: true, error: 'missing_device_code', message: 'device_code is required' } };
    }

    const current = Number(options.interval) > 0 ? Number(options.interval) : DEFAULT_INTERVAL_SECONDS;
    const res = await postJson('poll', '/api/license/device/poll', { device_code: deviceCode });

    if (res.networkError) {
        // NOT terminal: the activation is still alive on the control plane and
        // the customer may still be approving it. The caller keeps polling
        // until the code's own expiry runs out.
        return { terminal_result: { state: 'unreachable', error: 'license_server_unreachable', message: res.error, interval: current } };
    }

    const body = res.body || {};

    if (res.status === 429 && body.error === 'slow_down') {
        return {
            terminal_result: {
                state: 'slow_down',
                interval: Math.max(intervalFrom(body, current), current + SLOW_DOWN_STEP_SECONDS),
            },
        };
    }

    if (res.status === 410 || body.status === 'expired') {
        return { terminal_result: { state: 'expired', terminal: true, error: body.error || 'expired_token' } };
    }

    if (res.status === 403 && (body.status === 'denied' || body.error === 'access_denied')) {
        return { terminal_result: { state: 'denied', terminal: true, error: 'access_denied' } };
    }

    if (res.status === 409 && body.error === 'seat_limit_reached') {
        // Forward the seat context verbatim, same defensive rule as
        // licenseClient.activate(): present fields only, nothing invented.
        const out = { state: 'seat_limit_reached', terminal: true, error: 'seat_limit_reached' };
        if (body.max_servers != null) out.max_servers = body.max_servers;
        if (Array.isArray(body.bound)) out.bound = body.bound;
        if (body.bound_instance_name != null) out.bound_instance_name = body.bound_instance_name;
        return { terminal_result: out };
    }

    if (body.status === 'consumed') {
        return { terminal_result: { state: 'consumed', terminal: true, error: 'consumed' } };
    }

    if (!res.ok) {
        // Everything else the control plane refuses (revoked, suspended,
        // license_unavailable, invalid_device_code) is terminal for THIS code:
        // polling again cannot change the answer.
        return {
            terminal_result: {
                state: 'error',
                terminal: true,
                status: res.status,
                error: body.error || 'device_poll_failed',
                message: body.reason || body.message || null,
            },
        };
    }

    if (body.status !== 'approved') {
        return { terminal_result: { state: 'pending', interval: intervalFrom(body, current) } };
    }

    return { approved: true, body };
}

/**
 * Poll one step of a started activation.
 *
 * @param {string} deviceCode
 * @param {{ interval?: number }} [options] the interval currently in use, so a
 *   slow_down can back OFF from it rather than resetting to the floor.
 * @returns {Promise<object>} { state, terminal?, interval?, ... }
 *   state is one of: pending | slow_down | approved | activation_failed |
 *   denied | expired | consumed | seat_limit_reached | unreachable | error
 */
export async function pollDeviceActivation(deviceCode, options = {}) {
    const step = await pollRaw(deviceCode, options);
    if (step.terminal_result) return step.terminal_result;

    const body = step.body;

    // Approved. The control plane hands back the license key string; store it
    // through licenseClient.activate() so device activation and a pasted key
    // land in exactly the same place (see the storage note at the top).
    if (typeof body.license_key !== 'string' || !body.license_key) {
        return {
            state: 'activation_failed',
            terminal: true,
            error: 'missing_license_key',
            message: 'The control plane approved the activation but returned no license key.',
        };
    }

    const activated = await activate(body.license_key);
    if (!activated.ok) {
        return {
            state: 'activation_failed',
            terminal: true,
            status: activated.status,
            error: activated.error || 'activation_failed',
            message: activated.message || null,
        };
    }

    const out = { state: 'approved', terminal: true, lease: activated.lease };
    if (body.max_servers != null) out.max_servers = body.max_servers;
    if (Array.isArray(body.bound)) out.bound = body.bound;
    return out;
}

/**
 * LICENSE-LAUNCH LL-8 — poll one step of a self-serve FREE-CLAIM activation.
 * Same wire mechanics as pollDeviceActivation (via pollRaw above); the entire
 * difference is what happens once the control plane says `approved`:
 *
 *   1. Collect every licence entry: `body.licenses[]` when the control plane
 *      sent the multi-approval shape, else a single-entry fallback built from
 *      the legacy top-level `license_id`/`license_key` fields (back-compat —
 *      see the wire contract note above pollFreeDeviceActivation's caller).
 *   2. BEFORE activating anything, run the FREE-ONLY GUARD
 *      (lib/freeClaimGuard.js assertFreeOnlyLicenseKey) over every entry that
 *      carries a license_key. This is the fail-closed line: a free-claim poll
 *      must never store a paid or plan.* entitlement even if the control
 *      plane itself is compromised or buggy. If ANY entry fails the guard,
 *      NOTHING is activated and the poll answers `contract_violation`.
 *   3. Only once every entry has cleared the guard, activate each key through
 *      the SAME licenseClient.activate() path the paid flow uses, in order.
 *      An entry that arrived with no license_key (a per-entry `error`/`reason`
 *      from the control plane) passes through as a failed result rather than
 *      being activated or dropped silently.
 *
 * @param {string} deviceCode
 * @param {{ interval?: number }} [options]
 * @returns {Promise<object>}
 *   { state: 'approved', terminal: true, results: [{ license_id, ok, lease? , error? }] }
 *   | { state: 'contract_violation', terminal: true, error: 'free_claim_paid_entitlement' }
 *   | the same pending/slow_down/expired/denied/consumed/seat_limit_reached/
 *     error/unreachable shapes pollDeviceActivation returns.
 */
export async function pollFreeDeviceActivation(deviceCode, options = {}) {
    const step = await pollRaw(deviceCode, options);
    if (step.terminal_result) return step.terminal_result;

    const body = step.body;
    const entries = Array.isArray(body.licenses) && body.licenses.length > 0
        ? body.licenses
        : [{ license_id: body.license_id ?? null, license_key: body.license_key, error: body.error, reason: body.reason }];

    // Step 2 — the guard runs over EVERY entry before a single activation
    // call is made. Fail closed: one bad entry poisons the whole poll.
    const catalog = loadSignedCatalog();
    for (const entry of entries) {
        if (typeof entry?.license_key !== 'string' || !entry.license_key) continue;
        const guard = assertFreeOnlyLicenseKey(entry.license_key, catalog);
        if (!guard.ok) {
            console.warn(
                `[DeviceActivation] FREE-CLAIM REFUSED: license_id=${entry.license_id ?? 'unknown'} failed the ` +
                `free-only guard (${guard.error})${guard.message ? `: ${guard.message}` : ''}. Activating nothing.`,
            );
            return { state: 'contract_violation', terminal: true, error: 'free_claim_paid_entitlement' };
        }
    }

    // Step 3 — every entry cleared the guard (or carried no key at all).
    // Activate sequentially through the same path a pasted key takes.
    const results = [];
    for (const entry of entries) {
        if (typeof entry?.license_key !== 'string' || !entry.license_key) {
            results.push({
                license_id: entry?.license_id ?? null,
                ok: false,
                error: entry?.error || entry?.reason || 'missing_license_key',
            });
            continue;
        }

        const activated = await activate(entry.license_key);
        if (!activated.ok) {
            results.push({
                license_id: entry.license_id ?? null,
                ok: false,
                error: activated.error || 'activation_failed',
            });
            continue;
        }

        results.push({ license_id: activated.lease.license_id, ok: true, lease: activated.lease });
    }

    return { state: 'approved', terminal: true, results };
}

export default { startDeviceActivation, pollDeviceActivation, pollFreeDeviceActivation };
