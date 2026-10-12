/**
 * Replay-Only Flags Route — REPLAY-ONLY .A-1a wiring
 *
 * Minimal internal CRUD surface over the replay_only flag store (see
 * store/replay-only-flags-store.ts). This is the toggle surface used to
 * flip a scope into replay-only mode; PROF-1 will later expose a richer
 * user-facing toggle, but this internal route is what lets ops/CI (and this
 * stream's own live-verification) set/read a flag today.
 *
 * Routes:
 *   GET /:scopeType/:scopeId          — read the flag for a scope
 *   PUT /:scopeType/:scopeId          — set the flag for a scope, body { replay_only: boolean }
 *
 * Auth: mounted under /api/internal, covered by the same global authMiddleware
 * every other /api/* route goes through (JWT or X-Service-Key — see
 * middleware/auth.ts). No additional per-route check, matching the sibling
 * /api/internal/* routes (skill-decay, skill-judge, skill-safety-judge).
 */

import { Hono, Context } from 'hono';
import { AppEnv } from '../types.js';
import { ReplayOnlyFlagsStore, ReplayOnlyScopeType } from '../../store/replay-only-flags-store.js';

interface ReplayOnlyFlagsRoutesConfig {
  store: ReplayOnlyFlagsStore;
}

const VALID_SCOPE_TYPES: ReplayOnlyScopeType[] = ['org', 'workflow', 'agent', 'run'];

function success(c: Context<AppEnv>, data: unknown, status: 200 = 200) {
  return c.json(
    {
      success: true,
      data,
      meta: {
        requestId: c.get('correlationId') || 'unknown',
        timestamp: new Date().toISOString(),
      },
    },
    status
  );
}

function errorResp(c: Context<AppEnv>, status: number, code: string, message: string) {
  return c.json(
    {
      success: false,
      error: { code, message },
    },
    status as any
  );
}

function isValidScopeType(value: string): value is ReplayOnlyScopeType {
  return (VALID_SCOPE_TYPES as string[]).includes(value);
}

export function createReplayOnlyFlagsRoutes(config: ReplayOnlyFlagsRoutesConfig) {
  const app = new Hono<AppEnv>();
  const { store } = config;

  // ── GET /:scopeType/:scopeId ───────────────────────────────────────────────

  app.get('/:scopeType/:scopeId', async (c) => {
    const scopeType = c.req.param('scopeType');
    const scopeId = c.req.param('scopeId');

    if (!isValidScopeType(scopeType)) {
      return errorResp(c, 400, 'invalid_scope_type', `scopeType must be one of: ${VALID_SCOPE_TYPES.join(', ')}`);
    }

    const replayOnly = await store.getFlag(scopeType, scopeId);
    return success(c, { scope_type: scopeType, scope_id: scopeId, replay_only: replayOnly });
  });

  // ── PUT /:scopeType/:scopeId ───────────────────────────────────────────────

  app.put('/:scopeType/:scopeId', async (c) => {
    const scopeType = c.req.param('scopeType');
    const scopeId = c.req.param('scopeId');

    if (!isValidScopeType(scopeType)) {
      return errorResp(c, 400, 'invalid_scope_type', `scopeType must be one of: ${VALID_SCOPE_TYPES.join(', ')}`);
    }

    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object' || typeof (body as Record<string, unknown>).replay_only !== 'boolean') {
      return errorResp(c, 400, 'invalid_body', 'Request body must be JSON with a boolean replay_only field');
    }

    const replayOnly = (body as { replay_only: boolean }).replay_only;
    await store.setFlag(scopeType, scopeId, replayOnly);
    return success(c, { scope_type: scopeType, scope_id: scopeId, replay_only: replayOnly });
  });

  return app;
}
