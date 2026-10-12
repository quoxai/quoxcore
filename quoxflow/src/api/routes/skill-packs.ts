/**
 * Skill Pack Routes — DEVSUITE-SKILLS Phase 2 wiring gap.
 *
 * SkillPackStore (store/skill-pack-store.ts, DEVSUITE-SKILLS Phase 1) has a
 * `verifyPack()` method but no HTTP endpoint exposed it — a cross-service
 * caller (quox-dashboard's collector, services/collector/lib/skillPackInstaller.js)
 * needs to verify a pack's signature over HTTP before installing it and, until
 * now, had nothing to call. installSkillPack() there fails closed (refuses to
 * install anything) without an explicit pre-verified `{ valid: true }` for
 * exactly this reason.
 *
 * GET /:id/verify — re-derives the canonical hash from the stored manifest
 * and checks it against the stored signature (see verifyPack() docstring for
 * the full fail-closed branch list). Read-only, no side effects, hence GET
 * rather than POST (matches the GET-for-reads convention used throughout
 * this file's siblings, e.g. replay-only-flags.ts's GET /:scopeType/:scopeId).
 *
 * Org scope: resolved via requireOrgScope(c) — the same helper every other
 * tenant-data route in this codebase uses (org-scope.ts). A JWT caller's
 * org_id is used directly; a service-key caller (the collector) must supply
 * X-Org-Id, matching the pattern documented in session-search.ts. This is
 * the existing internal/cross-service auth convention in this codebase (JWT
 * or X-Service-Key via the global authMiddleware, org scoped via
 * X-Org-Id) — no new auth scheme invented for this route.
 *
 * Response shape: `{ success: true, data: <PackVerifyResult & id/orgId> }`
 * on 200, matching the success() convention used throughout this codebase's
 * routes (see skills.ts). `data` always carries at least `{ valid: boolean }`
 * and, on failure, `{ valid: false, reason: PackVerifyFailureReason }` —
 * exactly the shape skillPackInstaller.js's `verification` parameter
 * expects, so its caller can pass this response's `data` straight through.
 * Errors (missing org scope, not-found) throw ApiError and are formatted by
 * handleError() — the same formatter app.ts's global `app.onError(...)`
 * uses for every other route. Registered locally on this sub-app too (not
 * just relying on the parent) so the route is self-contained and behaves
 * identically whether mounted under the full app or exercised directly via
 * app.request() in a route-level test (see skill-packs.test.ts).
 */

import { Hono, Context } from 'hono';
import { AppEnv } from '../types.js';
import { SkillPackStore } from '../../store/skill-pack-store.js';
import { requireOrgScope } from '../middleware/org-scope.js';
import { ApiError, ErrorCodes, handleError } from '../middleware/error-handler.js';

export interface SkillPackRoutesConfig {
  store: SkillPackStore;
}

function success<T>(c: Context<AppEnv>, data: T, status: 200 = 200) {
  return c.json(
    {
      success: true,
      data,
      meta: {
        requestId: c.get('correlationId'),
        timestamp: new Date().toISOString(),
      },
    },
    status
  );
}

export function createSkillPackRoutes(config: SkillPackRoutesConfig) {
  const app = new Hono<AppEnv>();
  const { store } = config;

  app.onError((err, c) => handleError(c, err));

  // ── GET /:id/verify ─────────────────────────────────────────────────────

  app.get('/:id/verify', async (c) => {
    const id = c.req.param('id');
    const orgId = requireOrgScope(c);

    const result = await store.verifyPack(id, orgId);

    if (!result.valid && result.reason === 'not_found') {
      throw new ApiError(ErrorCodes.NOT_FOUND, `Skill pack '${id}' not found`, 404);
    }

    return success(c, { id, orgId, ...result });
  });

  return app;
}
