/**
 * Approval Templates Route — STUDY-REV-2 P8.C.3
 *
 * CRUD for approval template definitions.
 *
 * Routes:
 *   POST   /api/approval-templates           — create
 *   GET    /api/approval-templates?org_id=   — list
 *   GET    /api/approval-templates/:id?org_id= — fetch
 *   PATCH  /api/approval-templates/:id        — update (org_id in body)
 *   DELETE /api/approval-templates/:id        — delete (org_id in body)
 *
 * The org comes from the authenticated caller (callerOrg below); a caller-supplied org_id that differs
 * from it is refused 403. Mutations also verify the template belongs to that org (403).
 */

import { Hono, Context } from 'hono';
import { AppEnv } from '../types.js';
import { ApprovalTemplateStore } from '../../policy/types.js';

// ─── Config ───────────────────────────────────────────────────────────────────

interface ApprovalTemplatesRoutesConfig {
  templateStore: ApprovalTemplateStore;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function success(c: Context<AppEnv>, data: unknown, status: 200 | 201 = 200) {
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

/**
 * The org this caller may act in. A user's JWT org IS the org: a different claimed org_id (body/query,
 * caller-controlled) is refused 403, and an omitted one defaults to the JWT org. A service caller names
 * the org (X-Org-Id, else the claimed org_id). With no auth context (dev/test only; production's
 * authMiddleware always sets one) the claimed org_id is used as before.
 * Collector route-coverage review 2026-10-15: org_id used to come only from the body/query, so an org-A
 * user could read/update/delete org-B templates by naming org-B.
 */
function callerOrg(c: Context<AppEnv>, claimed: unknown): { orgId: string } | { status: number; code: string; message: string } {
  const user = c.get('user') as { type?: string; org_id?: string } | undefined;
  const claim = typeof claimed === 'string' && claimed.length > 0 ? claimed : undefined;
  if (user && user.type !== 'service') {
    if (!user.org_id) return { status: 401, code: 'org_required', message: 'Missing org_id in JWT' };
    if (claim && claim !== user.org_id) return { status: 403, code: 'forbidden', message: 'org_id does not match your organisation' };
    return { orgId: user.org_id };
  }
  if (user && user.type === 'service') {
    const hdr = c.req.header('X-Org-Id') || c.req.header('X-Org-ID');
    if (hdr && claim && hdr !== claim) return { status: 403, code: 'forbidden', message: 'org_id does not match X-Org-Id' };
    const org = hdr || claim;
    return org ? { orgId: org } : { status: 400, code: 'org_id_required', message: 'org_id is required' };
  }
  if (process.env.NODE_ENV === 'production') return { status: 401, code: 'unauthenticated', message: 'Authentication required' };
  return claim ? { orgId: claim } : { status: 400, code: 'org_id_required', message: 'org_id is required' };
}

// ─── Route Factory ────────────────────────────────────────────────────────────

export function createApprovalTemplatesRoutes(config: ApprovalTemplatesRoutesConfig) {
  const app = new Hono<AppEnv>();
  const { templateStore } = config;

  // Ensure store is initialized
  templateStore.init().catch(err => {
    console.error('[approval-templates] Store init error:', err);
  });

  // ── POST /api/approval-templates ──────────────────────────────────────────

  app.post('/', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return errorResp(c, 400, 'invalid_body', 'Request body must be JSON');
    }

    const { org_id: claimedOrg, name, approvers, escalation_chain, timeout_ms, multi_party_threshold } = body as Record<string, unknown>;
    const who = callerOrg(c, claimedOrg);
    if (!('orgId' in who)) return errorResp(c, who.status, who.code, who.message);
    const org_id = who.orgId;
    if (!name || typeof name !== 'string' || name.trim() === '') {
      return errorResp(c, 400, 'name_required', 'name is required');
    }
    if (!Array.isArray(approvers) || approvers.length === 0) {
      return errorResp(c, 400, 'approvers_required', 'approvers must be a non-empty array');
    }

    try {
      const template = await templateStore.create({
        orgId: org_id,
        name: name.trim(),
        approvers: approvers as string[],
        escalation_chain: Array.isArray(escalation_chain) ? escalation_chain as string[] : [],
        timeout_ms: typeof timeout_ms === 'number' ? timeout_ms : 86400000,
        multi_party_threshold: typeof multi_party_threshold === 'number' ? multi_party_threshold : 1,
      });
      return success(c, { template }, 201);
    } catch (err) {
      console.error('[approval-templates] Create error:', err);
      return errorResp(c, 500, 'create_failed', 'Failed to create approval template');
    }
  });

  // ── GET /api/approval-templates — list ────────────────────────────────────

  app.get('/', async (c) => {
    const who = callerOrg(c, c.req.query('org_id'));
    if (!('orgId' in who)) return errorResp(c, who.status, who.code, who.message);
    const orgId = who.orgId;

    try {
      const templates = await templateStore.list(orgId);
      return success(c, { templates, total: templates.length });
    } catch (err) {
      console.error('[approval-templates] List error:', err);
      return errorResp(c, 500, 'list_failed', 'Failed to list approval templates');
    }
  });

  // ── GET /api/approval-templates/:id — fetch ───────────────────────────────

  app.get('/:id', async (c) => {
    const id = c.req.param('id');
    const who = callerOrg(c, c.req.query('org_id'));
    if (!('orgId' in who)) return errorResp(c, who.status, who.code, who.message);
    const orgId = who.orgId;

    try {
      const template = await templateStore.get(id, orgId);
      if (!template) {
        return errorResp(c, 404, 'not_found', `Approval template not found: ${id}`);
      }
      return success(c, { template });
    } catch (err) {
      console.error('[approval-templates] Get error:', err);
      return errorResp(c, 500, 'get_failed', 'Failed to get approval template');
    }
  });

  // ── PATCH /api/approval-templates/:id — update ───────────────────────────

  app.patch('/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return errorResp(c, 400, 'invalid_body', 'Request body must be JSON');
    }

    const { org_id: claimedOrg, ...updates } = body as Record<string, unknown>;
    const who = callerOrg(c, claimedOrg);
    if (!('orgId' in who)) return errorResp(c, who.status, who.code, who.message);
    const org_id = who.orgId;

    // Verify cross-tenant access — return 403 if template belongs to a different org
    const existing = await templateStore.get(id, org_id);
    if (!existing) {
      // Could be not found OR wrong org — check if it exists at all
      // Since get() enforces org isolation, not found = either missing or cross-tenant
      // We return 403 to avoid leaking existence to other tenants
      return errorResp(c, 403, 'forbidden', 'Approval template not found or access denied');
    }

    try {
      const allowedUpdates: Record<string, unknown> = {};
      if (typeof updates.name === 'string') allowedUpdates.name = updates.name;
      if (Array.isArray(updates.approvers)) allowedUpdates.approvers = updates.approvers;
      if (Array.isArray(updates.escalation_chain)) allowedUpdates.escalation_chain = updates.escalation_chain;
      if (typeof updates.timeout_ms === 'number') allowedUpdates.timeout_ms = updates.timeout_ms;
      if (typeof updates.multi_party_threshold === 'number') allowedUpdates.multi_party_threshold = updates.multi_party_threshold;

      const template = await templateStore.update(id, org_id, allowedUpdates);
      return success(c, { template });
    } catch (err) {
      console.error('[approval-templates] Update error:', err);
      return errorResp(c, 500, 'update_failed', 'Failed to update approval template');
    }
  });

  // ── DELETE /api/approval-templates/:id — delete ──────────────────────────

  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => null);
    const who = callerOrg(c, (body as Record<string, unknown> | null)?.org_id);
    if (!('orgId' in who)) return errorResp(c, who.status, who.code, who.message);
    const org_id = who.orgId;

    // Cross-tenant check — verify the template belongs to this org before deleting
    const existing = await templateStore.get(id, org_id);
    if (!existing) {
      return errorResp(c, 403, 'forbidden', 'Approval template not found or access denied');
    }

    try {
      await templateStore.delete(id, org_id);
      return success(c, { deleted: true, id });
    } catch (err) {
      console.error('[approval-templates] Delete error:', err);
      return errorResp(c, 500, 'delete_failed', 'Failed to delete approval template');
    }
  });

  return app;
}
