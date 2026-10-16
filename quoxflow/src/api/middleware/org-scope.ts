/**
 * Org-scope resolution — QF-MT WP1.
 *
 * Generalizes the `resolveOrgId()` pattern (originally in
 * src/api/routes/quox-skills.ts) into a shared helper that also expresses
 * trusted, cross-org "system" access for service-key callers. Every tenant-data
 * route resolves the caller's scope here so reads filter by it and writes
 * persist it — the multi-tenant isolation fix (STREAM_QUOXFLOW_MULTITENANCY_PLAN).
 *
 * Rules (semantics preserved from quox-skills.ts):
 *  1. JWT access token (`user.type === 'access'`): `org_id` MUST be present →
 *     {kind:'org'}; missing/empty → 401 (never a query-param fallback).
 *  2. Service key (`user.type === 'service'`): trusted anchor. `X-Org-Id` header
 *     present → {kind:'org', orgId: header}; absent → {kind:'system'} (cross-org
 *     by design — must be explicit and loud at the store layer, never accidental).
 *  3. No user (auth middleware disabled — dev/test only): `?orgId` /
 *     `X-Org-ID` header / validated-body `orgId` / `'org-default'` last resort.
 *     Production without a JWT always 401 (prevents org-param spoofing).
 */

import { Context } from 'hono';
import { AppEnv } from '../types.js';
import { ApiError, ErrorCodes } from './error-handler.js';
import { isSystemScopeAllowlisted } from './org-scope-allowlist.js';

/**
 * Sentinel for trusted cross-org access (service key without X-Org-Id). Store
 * methods that legitimately span orgs accept `orgId: string | typeof SYSTEM_SCOPE`
 * (or expose a distinct `listAllOrgs()`), so cross-org reads are a deliberate,
 * greppable choice rather than an absent-parameter accident.
 */
export const SYSTEM_SCOPE: unique symbol = Symbol('org-scope:system');
export type SystemScope = typeof SYSTEM_SCOPE;

export type OrgScope =
  | { kind: 'org'; orgId: string }
  | { kind: 'system' };

/**
 * Staged rollout (plan §6) — applies ONLY to the {kind:'system'} branch below
 * (service key, no X-Org-Id). JWT paths are already hard-enforced (org_id
 * mandatory in the token, 401 otherwise) and are NOT affected by this switch.
 *
 *   advisory (default): zero behavior change. Logs a rate-limited warning
 *     (see recordAdvisorySystemScopeHit below) and returns {kind:'system'}
 *     exactly as before.
 *   enforced: service-key calls WITHOUT X-Org-Id on tenant-data routes get a
 *     403 ("X-Org-Id required"); routes where system scope is legitimate
 *     (internal/validation/proxy/route-manifest) keep working via the
 *     explicit allowlist in ./org-scope-allowlist.ts.
 *
 * Flip via env QUOXFLOW_ORG_ENFORCEMENT=enforced after WP8 (collector
 * callers) ships and the advisory log is quiet for a full deploy cycle.
 */
export type OrgEnforcementMode = 'advisory' | 'enforced';

export function getOrgEnforcementMode(): OrgEnforcementMode {
  return process.env.QUOXFLOW_ORG_ENFORCEMENT === 'enforced' ? 'enforced' : 'advisory';
}

/**
 * Per-route hit counters for advisory mode, so a future ops endpoint (or the
 * pre-flip soak) can quantify exactly which unscoped service-key reads are
 * still happening and how often. Keyed by `"<METHOD> <path>"`. In-memory —
 * resets on process restart, which is fine for a soak-window counter.
 */
const advisoryHitCounts = new Map<string, number>();

/** Log every hit for the first 5, then every 20th, to avoid log-flooding a
 * hot route while still surfacing the running count for the soak. */
function shouldLogAdvisoryHit(count: number): boolean {
  return count <= 5 || count % 20 === 0;
}

function recordAdvisorySystemScopeHit(method: string, path: string): void {
  const key = `${method} ${path}`;
  const count = (advisoryHitCounts.get(key) ?? 0) + 1;
  advisoryHitCounts.set(key, count);
  if (shouldLogAdvisoryHit(count)) {
    console.warn(`[org-scope] service-key read without X-Org-Id on ${key} (count=${count})`);
  }
}

/** Snapshot of advisory-mode hit counts, keyed by `"<METHOD> <path>"`. For a
 * future ops/health endpoint — nothing else reads this today. */
export function getOrgScopeAdvisoryStats(): Record<string, number> {
  return Object.fromEntries(advisoryHitCounts);
}

/** Test-only: clears the in-memory advisory counters between test cases. */
export function resetOrgScopeAdvisoryStats(): void {
  advisoryHitCounts.clear();
}

export function resolveOrgScope(c: Context<AppEnv>): OrgScope {
  const user = c.get('user') as AppEnv['Variables']['user'] | undefined;

  if (user !== undefined) {
    if (user.type === 'service') {
      const header = c.req.header('X-Org-Id') || c.req.header('X-Org-ID');
      if (header && header.length > 0) return { kind: 'org', orgId: header };

      // Service key, no X-Org-Id — cross-org system scope. Staged rollout
      // gate (plan §6): only this branch is affected by enforcement mode.
      const method = c.req.method;
      const path = new URL(c.req.raw.url).pathname;

      if (getOrgEnforcementMode() === 'enforced') {
        if (isSystemScopeAllowlisted(method, path)) return { kind: 'system' };
        throw new ApiError(
          ErrorCodes.INTERNAL_ERROR,
          'X-Org-Id required — service-key callers must supply X-Org-Id on this route',
          403
        );
      }

      // advisory (default): log + behave exactly as before.
      recordAdvisorySystemScopeHit(method, path);
      return { kind: 'system' };
    }
    // access token — org_id must be in the JWT.
    const orgId = user.org_id;
    if (!orgId || orgId.length === 0) {
      console.warn('[org-scope] user authenticated but no org_id in JWT — 401');
      throw new ApiError(ErrorCodes.INTERNAL_ERROR, 'Missing org_id in JWT — cannot serve request', 401);
    }
    return { kind: 'org', orgId };
  }

  // Auth middleware did not run. Production always rejects (no org-param spoofing).
  if (process.env.NODE_ENV === 'production') {
    console.warn('[org-scope] no JWT in production mode — 401');
    throw new ApiError(ErrorCodes.INTERNAL_ERROR, 'Authentication required — no JWT present', 401);
  }

  // Dev/test only: URL param → X-Org-ID header → validated body → last-resort default.
  const url = new URL(c.req.raw.url);
  const qOrgId = url.searchParams.get('orgId');
  if (qOrgId && qOrgId.length > 0) return { kind: 'org', orgId: qOrgId };
  const hdr = c.req.header('X-Org-ID') || c.req.header('X-Org-Id');
  if (hdr && hdr.length > 0) return { kind: 'org', orgId: hdr };
  const bodyCtx = c.get('validatedBody') as { orgId?: string } | undefined;
  if (bodyCtx?.orgId && bodyCtx.orgId.length > 0) return { kind: 'org', orgId: bodyCtx.orgId };
  return { kind: 'org', orgId: 'org-default' };
}

/**
 * Convenience for routes where cross-org system scope makes no sense: returns
 * the orgId string, throwing 403 on {kind:'system'}.
 */
export function requireOrgScope(c: Context<AppEnv>): string {
  const scope = resolveOrgScope(c);
  if (scope.kind === 'system') {
    throw new ApiError(
      ErrorCodes.INTERNAL_ERROR,
      'Org scope required — service/system scope must supply X-Org-Id on this route',
      403
    );
  }
  return scope.orgId;
}

export type CallerOrg = { orgId: string } | { status: 400 | 401 | 403; code: string; message: string };

/**
 * For routes whose contract carries an org in the body or query (org_id / orgId). A user token is held to its JWT
 * org: a different claimed org is 403, an omitted one defaults to the JWT org, a token without an org is 401. A
 * service-key caller acts for X-Org-Id, else the claimed org (403 when both are given and differ). With no auth
 * context (dev/test only; production's authMiddleware always sets one) the claimed org is used.
 * Engagement findings 2026-10-16: policies, budgets, budget-usage and session-search trusted the claimed org, so an
 * org-A user reaching /quoxflow/ through the dashboard proxy could act in org B. Same rule as approval-templates.ts.
 */
export function requireCallerOrg(c: Context<AppEnv>, claimed: unknown): CallerOrg {
  const user = c.get('user') as AppEnv['Variables']['user'] | undefined;
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
