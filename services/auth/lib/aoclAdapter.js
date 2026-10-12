/**
 * LIFECYCLE-P3-D3 — AOCL Adapter for Auth Service (L0-L5 emissions)
 *
 * Provides thin L0-L5 AOCL layer envelope emission for POWERS routes
 * on the auth side. The chat path (collector) already handles L6-L9.
 * Auth-side POWERS routes need L0-L5:
 *
 *   L0 - IDENTITY      — JWT/session identity validated
 *   L1 - SESSION       — session state retrieved and validated
 *   L2 - REQUEST_RECV  — HTTP request body parsed
 *   L3 - REQUEST_PARSE — application-level fields extracted (repo_url, etc.)
 *   L4 - REQUEST_ROUTE — route dispatched (deploy / detect / delete)
 *   L5 - AUTHZ         — capability check (AGENTS_MANAGE) passed
 *
 * Emission pattern:
 *   - All emissions are fire-and-forget via an async setImmediate pattern.
 *   - Never blocks the HTTP handler.
 *   - Uses the AEE client (lazy-imported) to emit to the collector's AEE store.
 *   - Failures are swallowed with a WARN log; never crash the route.
 *
 * Layer overhead:
 *   Async / non-blocking. The AEE emission is a fire-and-forget POST to the
 *   collector. Total overhead: ~0 ms on the critical path (setImmediate deferral).
 *
 * Usage:
 *   import { emitAoclLayer } from '../lib/aoclAdapter.js';
 *   emitAoclLayer({ layer: 0, outcome: 'complete', corr, actorId, orgId, route: 'deploy', payload: {} });
 */

/**
 * Layer names mapped to numbers.
 * These mirror the AOCL spec's OSI-style numbering on the auth side.
 */
export const AOCL_LAYER = {
  IDENTITY: 0,
  SESSION: 1,
  REQUEST_RECV: 2,
  REQUEST_PARSE: 3,
  REQUEST_ROUTE: 4,
  AUTHZ: 5,
};

/**
 * Emit an AOCL L0-L5 layer envelope (fire-and-forget).
 *
 * @param {object} params
 * @param {number}  params.layer    - Layer number (0-5)
 * @param {string}  params.outcome  - 'complete' | 'reject' | 'allow'
 * @param {string}  params.corr     - Correlation ID (AEE envelope corr field)
 * @param {string}  [params.actorId]  - User ID performing the action
 * @param {string}  [params.orgId]    - Organization ID
 * @param {string}  [params.route]    - Route identifier (e.g. 'deploy', 'detect', 'delete')
 * @param {object}  [params.payload]  - Additional payload fields (must not contain secrets)
 */
export function emitAoclLayer({ layer, outcome, corr, actorId, orgId, route, payload = {} }) {
  // Fire-and-forget: defer into the next event loop tick so the HTTP handler
  // is never blocked by the envelope emission.
  setImmediate(async () => {
    try {
      const { emitEnvelope } = await import('./aeeClient.js');

      const intent = `aocl.layer.${layer}.${outcome}`;
      // aeeClient.emitEnvelope stamps id/v/ts — we pass the intent-specific fields only.
      emitEnvelope({
        type: outcome === 'reject' ? 'error' : 'event',
        from: actorId ? `human.${actorId}` : 'system.auth',
        to: 'audit.system',
        intent,
        corr: corr || `AUTH_${Date.now()}`,
        reply_to: null,
        payload: {
          layer,
          layer_name: _layerName(layer),
          route: route || 'unknown',
          orgId: orgId || null,
          actorId: actorId || null,
          outcome,
          ...payload,
        },
      });
    } catch (err) {
      // Never crash the route handler over AOCL emission
      console.warn('[LIFECYCLE-P3-D3] AOCL L%d emission failed (non-fatal): %s', layer, err.message);
    }
  });
}

/**
 * Convenience: emit L0-L5 in sequence for a POWERS route lifecycle.
 * Each layer represents a gate the request passed through.
 *
 * @param {object} ctx
 * @param {string}  ctx.corr
 * @param {string}  ctx.actorId
 * @param {string}  ctx.orgId
 * @param {string}  ctx.route       - e.g. 'deploy', 'detect', 'delete', 'finalize'
 * @param {object}  [ctx.fields]    - route-specific payload fields (no secrets)
 */
export function emitPowersRouteL0toL5(ctx) {
  const { corr, actorId, orgId, route, fields = {} } = ctx;
  const base = { corr, actorId, orgId, route };

  // L0: identity confirmed (JWT present, user resolved)
  emitAoclLayer({ ...base, layer: AOCL_LAYER.IDENTITY, outcome: 'complete',
    payload: { actor_type: 'user', actor_id: actorId } });

  // L1: session state validated (org membership confirmed by this point)
  emitAoclLayer({ ...base, layer: AOCL_LAYER.SESSION, outcome: 'complete',
    payload: { org_id: orgId } });

  // L2: request body received and parsed (HTTP layer)
  emitAoclLayer({ ...base, layer: AOCL_LAYER.REQUEST_RECV, outcome: 'complete',
    payload: {} });

  // L3: application fields extracted
  emitAoclLayer({ ...base, layer: AOCL_LAYER.REQUEST_PARSE, outcome: 'complete',
    payload: { route, ...fields } });

  // L4: route dispatched
  emitAoclLayer({ ...base, layer: AOCL_LAYER.REQUEST_ROUTE, outcome: 'complete',
    payload: { dispatched_to: `powers.${route}` } });

  // L5: capability check passed (AGENTS_MANAGE)
  emitAoclLayer({ ...base, layer: AOCL_LAYER.AUTHZ, outcome: 'complete',
    payload: { capability: 'AGENTS_MANAGE', granted: true } });
}

function _layerName(layer) {
  const NAMES = {
    0: 'IDENTITY',
    1: 'SESSION',
    2: 'REQUEST_RECV',
    3: 'REQUEST_PARSE',
    4: 'REQUEST_ROUTE',
    5: 'AUTHZ',
  };
  return NAMES[layer] || `LAYER_${layer}`;
}
