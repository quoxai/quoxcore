/**
 * VAULT-INTEG P3 — WARD sink credential resolution (vault-first, env-last).
 *
 * WARD's hash chain and its tips are INSTANCE-scoped, not per-org — see
 * store.js's ORG-VIEW-SCOPE note: org_id is a row attribute on individual
 * entries, but the chain/seq/hash linkage (and the tips derived from it)
 * stays global to the box. Sink publication credentials (gitea/github/
 * gitlab/s3 tokens) follow that same scope, so this resolves against
 * QuoxVault's INSTANCE scope: the sentinel org id from services/auth/lib/
 * instanceScope.js, re-declared as a literal here (ward does not import
 * auth's ESM source tree directly — the same re-declaration pattern
 * services/auth/scripts/reconcile-scopes.js already uses outside auth's own
 * import graph).
 *
 * Goes over the generic /api/setup/internal/resolve-for-agent waterfall
 * (agent assignment -> org/instance default -> env, VAULT-P5.H) using the
 * same internal service-key channel sinks/quox-verified.js already uses for
 * its current-lease lookup — no new auth route needed, since
 * resolveForAgent() works against any org_id (including the instance
 * sentinel) with no ward-specific code on the auth side.
 *
 * fallback_to_env is left false on the auth-side call: ward's own env
 * fallback (WARD_GITEA_TOKEN etc., in sinks.js) already covers that leg, so
 * asking auth to also fall back to env would just be resolving the same
 * value twice through an extra network hop.
 *
 * Never throws: any transport failure, non-2xx, or lease block returns null
 * (or { leaseBlocked: true, ... } — treated as "no vault credential" by
 * callers) so getActiveSinks() always has an env fallback to fall through to.
 */

/** Sentinel instance-scope org id — see services/auth/lib/instanceScope.js. */
const INSTANCE_ORG_ID = '__instance__';

/** Fixed pseudo-agent id for the vault's agent-assignment lookup level. WARD
 * has no real per-agent identity of its own; this just names the caller so
 * an admin could, in principle, assign a specific credential to it. */
const WARD_AGENT_ID = 'ward';

/**
 * @param {string} toolType - integration_type ('github' | 'gitlab' | 'aws_s3' | 'gitea')
 * @param {{ authBaseUrl?: string, serviceKey?: string, fetchImpl?: Function }} [deps]
 * @returns {Promise<{ key: string|null, credentials: object|null, source: string|null, leaseBlocked?: boolean, leaseReason?: string }|null>}
 */
async function resolveSinkCredential(toolType, deps = {}) {
  const authBaseUrl = deps.authBaseUrl || process.env.AUTH_SERVICE_URL || 'http://auth:3101';
  const serviceKey = deps.serviceKey !== undefined ? deps.serviceKey : (process.env.INTERNAL_SERVICE_KEY || null);
  const doFetch = deps.fetchImpl || fetch;

  if (!serviceKey || !toolType) return null;

  try {
    const res = await doFetch(`${authBaseUrl}/api/setup/internal/resolve-for-agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': serviceKey },
      body: JSON.stringify({
        org_id: INSTANCE_ORG_ID,
        agent_id: WARD_AGENT_ID,
        tool_type: toolType,
        fallback_to_instance: true,
        fallback_to_env: false,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (res && res.status === 403) {
      const body = await res.json().catch(() => ({}));
      return { key: null, credentials: null, source: null, leaseBlocked: true, leaseReason: body?.reason || 'lease_required' };
    }
    if (!res || !res.ok) return null; // status BEFORE body — an error body is not data
    return await res.json();
  } catch {
    return null; // network error, timeout — soft, never throw
  }
}

export { resolveSinkCredential, INSTANCE_ORG_ID, WARD_AGENT_ID };
