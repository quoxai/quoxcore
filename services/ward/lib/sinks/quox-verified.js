/**
 * LICENSE-LAUNCH LL-9i2 — Quox Verified sink
 *
 * A 4th WARD sink (alongside tsa/webhook/gitea/github/gitlab/s3) that gets a
 * licensed instance's WARD evidence COUNTERSIGNED by the quox.ai control plane.
 * On a tip publish it:
 *   1. fetches the instance's current lease from the auth service over the
 *      internal service-key channel (GET /api/internal/current-lease);
 *   2. computes the tip digest (tipPayloadHash — a 64-hex SHA-256, the same
 *      hash used for meta-chain witnessing);
 *   3. POSTs { lease, digest, kind:'ward_tip' } to the control plane's
 *      /api/verified/countersign;
 *   4. returns the returned record id as a `quox-verified:<id>#<tip_seq>`
 *      sink_ref (the type:ref#seq format the other sinks use).
 *
 * DIGEST ONLY, never raw evidence: the countersign request carries the tip
 * digest and the signed lease, nothing else. The evidence stays on the box.
 *
 * FAIL SOFT (R5 honesty boundary in code): the countersignature is an ADDITION,
 * never a gate. Every failure path — no lease / unlicensed, accessor 401,
 * control-plane non-2xx, network error, malformed response — returns
 * { success:false } WITHOUT throwing, so publishToAllSinks keeps the tip's
 * other sinks and the tip still publishes locally. Local WARD evidence never
 * depends on our signature.
 */

import { tipPayloadHash } from '../tips.js';
import { voltBundleDigest } from '../voltDigest.js';

const KIND = 'ward_tip';
const VOLT_KIND = 'volt_bundle';

/**
 * LICENSE-LAUNCH LL-9i4 — resolve the Quox Verified client config from env.
 *
 * The single source of truth for where /api/verified/countersign lives and the
 * internal accessor channel. Shared by the WARD sink (getActiveSinks in
 * sinks.js) and the VOLT bundle countersign call site so the two paths can
 * never drift apart.
 *
 * @param {object} [env=process.env]
 * @returns {{ control_plane_url: string, auth_base_url: string, service_key: string|null }}
 */
function resolveQuoxVerifiedConfig(env = process.env) {
  return {
    control_plane_url: env.QUOX_LICENSE_SERVER || 'https://api.quox.ai',
    auth_base_url: env.AUTH_SERVICE_URL || 'http://auth:3101',
    service_key: env.INTERNAL_SERVICE_KEY || null,
  };
}

/**
 * Shared control-plane submit. POSTs { lease, digest, kind } to
 * /api/verified/countersign and returns the record id, or a soft failure.
 * Status BEFORE body — an error body is not data.
 *
 * @returns {Promise<{ success: boolean, record_id: string|null, error: string|null }>}
 */
async function submitCountersign({ lease, digest, kind, control_plane_url }) {
  const base = control_plane_url || 'https://api.quox.ai';
  const res = await fetch(`${base}/api/verified/countersign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lease, digest, kind }),
    signal: AbortSignal.timeout(10000),
  });

  if (!res || !res.ok) {
    return { success: false, record_id: null, error: `countersign HTTP ${res && res.status}` };
  }

  let body = null;
  try { body = await res.json(); } catch { body = null; }
  // LICENSE-LAUNCH LL-9 live round trip (2026-09-01, first real run against the
  // control plane): the actual /api/verified/countersign response wraps the
  // record as { countersignature: {...} } and, by deliberate data-minimisation
  // design (see routes/verified.js recordForWire), never puts a DB id on the
  // wire — only digest/kind/license_id/instance_id/signed_at/policy_version/sig.
  // Check top-level id fields first (forward-compatible if the control plane
  // ever adds one), then the nested countersignature object, then fall back to
  // the digest itself: the record is content-addressed and unique per
  // (license_id, instance_id, digest, kind), so the digest we already sent is a
  // stable, sufficient sink_ref anchor with no extra trust required.
  const rec = body && body.countersignature;
  const recordId = (body && (body.id || body.countersignature_id || body.record_id))
    || (rec && (rec.id || rec.countersignature_id || rec.record_id || rec.digest))
    || null;
  if (!recordId) {
    return { success: false, record_id: null, error: 'countersign response missing record id' };
  }
  return { success: true, record_id: recordId, error: null };
}

/**
 * LICENSE-LAUNCH LL-9i3 — resolve whether the Quox Verified sink is enabled.
 *
 * NO-ENV-ONLY-CONFIG (owner hard rule): the switch is a server-side
 * instance_config value the dashboard can read and write, with the env flag
 * WARD_QUOX_VERIFIED_ENABLED kept only as the default/fallback. The
 * instance_config value WINS when set.
 *
 * The WARD sink runs in a service that cannot read auth's instance_config
 * directly, so it asks auth over the same INTERNAL_SERVICE_KEY channel it uses
 * for the current lease: GET /api/internal/quox-verified-enabled returns
 * { enabled: true|false|null } where null means "unset — let the env decide".
 *
 * Fail-soft: no service key (accessor unavailable), a non-2xx, a malformed
 * body, a network error or a null value all defer to the env flag, so a
 * degraded accessor never silently flips the feature on or off against the
 * env default.
 *
 * @param {{ auth_base_url?: string, service_key?: string, env?: object }} config
 * @returns {Promise<boolean>}
 */
async function resolveEnabled(config = {}) {
  const { auth_base_url, service_key, env = process.env } = config;
  const envDefault = env.WARD_QUOX_VERIFIED_ENABLED === '1';

  // Without a service key the sink cannot read instance_config; env is the
  // only source it has.
  if (!service_key) return envDefault;

  try {
    const url = `${auth_base_url || 'http://auth:3101'}/api/internal/quox-verified-enabled`;
    const res = await fetch(url, {
      headers: { 'X-Service-Key': service_key },
      signal: AbortSignal.timeout(5000),
    });
    if (!res || !res.ok) return envDefault; // status BEFORE body — an error body is not data
    let body = null;
    try { body = await res.json(); } catch { return envDefault; }
    // instance_config set (true/false) wins; null/absent defers to env.
    if (body && typeof body.enabled === 'boolean') return body.enabled;
    return envDefault;
  } catch {
    return envDefault; // unreachable/timeout — defer to env, never throw
  }
}

/**
 * Fetch the instance's current valid lease from auth. Status BEFORE body: an
 * error body is not data. Returns the lease object, or null on any failure
 * (which the caller treats as "unlicensed / skip countersignature").
 */
async function fetchCurrentLease(authBaseUrl, serviceKey) {
  const url = `${authBaseUrl || 'http://auth:3101'}/api/internal/current-lease`;
  const res = await fetch(url, {
    headers: { ...(serviceKey ? { 'X-Service-Key': serviceKey } : {}) },
    signal: AbortSignal.timeout(5000),
  });
  if (!res || !res.ok) return null;
  let body = null;
  try { body = await res.json(); } catch { return null; }
  return body && body.lease ? body.lease : null;
}

/**
 * @param {object} tip - Signed WARD tip
 * @param {object} config - { control_plane_url, auth_base_url, service_key }
 * @returns {Promise<{success: boolean, sink_ref: string|null, error: string|null}>}
 */
async function publish(tip, config = {}) {
  const { control_plane_url, auth_base_url, service_key } = config;

  try {
    // 1. Proof of licensed holding — the box's current lease.
    const lease = await fetchCurrentLease(auth_base_url, service_key);
    if (!lease) {
      // Unlicensed, or the accessor was unreachable/denied. Fail soft: the tip
      // still publishes to its other sinks; there is simply no countersignature.
      return { success: false, sink_ref: null, error: 'no_current_lease' };
    }

    // 2. The digest — never the evidence.
    const digest = tipPayloadHash(tip);

    // 3. Submit to the control plane (shared client — same as the VOLT path).
    const sub = await submitCountersign({ lease, digest, kind: KIND, control_plane_url });
    if (!sub.success) {
      return { success: false, sink_ref: null, error: sub.error };
    }

    // 4. sink_ref in the type:ref#seq format other sinks use.
    return { success: true, sink_ref: `quox-verified:${sub.record_id}#${tip.tip_seq}`, error: null };
  } catch (err) {
    // Network error, timeout, anything — soft. Never throw from a sink.
    return { success: false, sink_ref: null, error: err.message };
  }
}

/**
 * LICENSE-LAUNCH LL-9i4 — countersign a finalized VOLT bundle.
 *
 * The VOLT analog of publish(): VOLT bundle finalization is NOT a WARD sink
 * (bundles are witnessed in WARD but published from the collector's bundle
 * finalization path, not the tip sink registry), so this is the non-sink call
 * site the design calls for. It:
 *   1. gates on the SAME instance_config toggle the WARD sink uses (LL-9i3,
 *      resolveEnabled — instance_config over env). Disabled -> no submission.
 *   2. fetches the box's current lease (proof of licensed holding);
 *   3. computes the bundle digest (voltBundleDigest — the SAME hash WARD
 *      chained when it witnessed the bundle);
 *   4. POSTs { lease, digest, kind:'volt_bundle' } via the shared submit;
 *   5. returns the record id as a `quox-verified:<id>` ref.
 *
 * FAIL SOFT (R5), identical to publish(): every failure path returns
 * { success:false } WITHOUT throwing. The VOLT bundle still finalizes locally;
 * the countersignature is additive, never a gate on local evidence.
 *
 * @param {object} bundleManifest - the finalized VOLT bundle manifest.
 * @param {object} config - { control_plane_url, auth_base_url, service_key, env }
 * @returns {Promise<{success: boolean, ref: string|null, record_id: string|null, error: string|null, skipped?: boolean}>}
 */
async function countersignVoltBundle(bundleManifest, config = {}) {
  const { control_plane_url, auth_base_url, service_key, env } = config;

  try {
    // 0. Same toggle as the WARD sink. There is no sink-registry gate on the
    // VOLT path, so the enable check lives here.
    const enabled = await resolveEnabled({ auth_base_url, service_key, env });
    if (!enabled) {
      return { success: false, ref: null, record_id: null, error: 'disabled', skipped: true };
    }

    // 1. Proof of licensed holding.
    const lease = await fetchCurrentLease(auth_base_url, service_key);
    if (!lease) {
      return { success: false, ref: null, record_id: null, error: 'no_current_lease' };
    }

    // 2. The digest — never the evidence.
    const digest = voltBundleDigest(bundleManifest);

    // 3. Submit to the control plane (shared client — same as the WARD path).
    const sub = await submitCountersign({ lease, digest, kind: VOLT_KIND, control_plane_url });
    if (!sub.success) {
      return { success: false, ref: null, record_id: null, error: sub.error };
    }

    // 4. sink_ref-equivalent ref the bundle carries.
    return { success: true, ref: `quox-verified:${sub.record_id}`, record_id: sub.record_id, error: null };
  } catch (err) {
    return { success: false, ref: null, record_id: null, error: err.message };
  }
}

function verify(sinkRef) {
  return sinkRef && sinkRef.startsWith('quox-verified:');
}

export { publish, verify, resolveEnabled, countersignVoltBundle, resolveQuoxVerifiedConfig };
export const type = 'quox-verified';
