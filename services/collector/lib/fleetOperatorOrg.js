/**
 * fleetOperatorOrg.js — quox#642 instance-operator-org fallback.
 *
 * A fleet host that heartbeats WITHOUT an org_id has no org to route its
 * skill-pack-install HITL approval to (devServerSkillPackTrigger.js defers
 * rather than mint an approval nobody can assign, quox#638). This gives an
 * instance operator a way to say "unattributed hosts on this box are mine":
 * a server-side, human-admin-writable instance_config key
 * ('fleet.operator_org_id'), read here the exact same way
 * services/collector/lib/quoxplanTools.js's resolveQuoxplanOwnerOrgId() reads
 * 'quoxplan.owner_org_id' — same auth-service round trip, same cache, same
 * fail-closed shape. No env-only config: the value lives in instance_config
 * (auth service's DB), admin-writable via the existing PATCH
 * /admin/config/:key path, never a docker-compose env var.
 *
 * Fail-closed: any resolution failure (auth unreachable, non-2xx, unset key)
 * returns null/undefined rather than guessing an org — an unattributed host
 * simply keeps deferring, exactly as it did before this fallback existed.
 * Failures are never cached, so a transient auth outage does not latch a
 * 60s "no operator org" verdict past the outage.
 */

'use strict';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth:3101';
const CACHE_MS = 60000;

let _operatorOrgCache = { value: undefined, expires: 0 };

async function resolveFleetOperatorOrgId() {
  if (_operatorOrgCache.expires > Date.now()) return _operatorOrgCache.value;
  try {
    const res = await fetch(`${AUTH_SERVICE_URL}/api/internal/instance/disposable-test`, {
      headers: { 'x-service-key': process.env.INTERNAL_SERVICE_KEY || '' },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return undefined; // do not cache failures
    const body = await res.json();
    _operatorOrgCache = { value: body.fleet_operator_org_id || null, expires: Date.now() + CACHE_MS };
    return _operatorOrgCache.value;
  } catch {
    return undefined;
  }
}

// Test hook: clears the cache between cases.
function _resetFleetOperatorOrgCacheForTests() {
  _operatorOrgCache = { value: undefined, expires: 0 };
}

module.exports = { resolveFleetOperatorOrgId, _resetFleetOperatorOrgCacheForTests };
