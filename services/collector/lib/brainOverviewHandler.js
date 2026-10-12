/**
 * GET /api/brain/overview — Qortex P2a "ONE BRAIN" aggregate
 * (owner decision 2026-08-05: union of all orgs the user has access to).
 *
 * Testable, dependency-injected handler logic behind GET /api/brain/overview.
 * Route wiring (auth + mount) lives in server.js — mirrors
 * lib/feedApiHandlers.js's split.
 *
 * Org resolution mirrors server.js's verifyQuoxplanOrgRole (QuoxPlan proxy's
 * cross-org roadmap fix): forwards the caller's OWN credentials (bearer
 * header first, then the browser access_token cookie — same priority as
 * utils/httpAuth.js) to the auth service's GET /api/orgs, the same
 * user-membership read the org-switcher UI already uses. This is the only
 * path — no new auth surface, and a caller can never see an org's brain
 * they are not a member of because the auth service enforces that already.
 *
 * Per-org quoxbrain reads use the TRUST-GATE-1.12a internal-service auth
 * (X-Service-Key + X-Org-Id [+X-User-Id]), the exact wire contract
 * lib/brainImplant.js's fetchBrainContext and lib/brainFeedClient.js's
 * headers() already use against GET /brain/status.
 *
 * Silent-fallback rule: a per-org quoxbrain fetch failure is never
 * flattened into a 0 — it comes back as {org_id, error: true} so the
 * cockpit can tell "empty brain" from "couldn't reach that org's brain"
 * apart. A total org-membership resolution failure (auth service
 * unreachable) is not swallowed into an empty overview either — it's a
 * 502, not a fabricated {total: 0, orgs: []}.
 */

'use strict';

const { parseCookieHeader } = require('../utils/httpAuth.js');

const AUTH_URL_DEFAULT = process.env.AUTH_SERVICE_URL || 'http://auth:3101';
const BRAIN_URL_DEFAULT = `http://${process.env.QUOXBRAIN_HOST || 'quoxbrain'}:${process.env.QUOXBRAIN_PORT || '3106'}`;
const SERVICE_KEY_DEFAULT = process.env.INTERNAL_SERVICE_KEY || '';

const ORG_TIMEOUT_MS = 5000;
const BRAIN_TIMEOUT_MS = 4000;

/**
 * Resolves the set of org ids the caller may see. JWT/user callers forward
 * their own credentials to the auth service's GET /api/orgs (the same
 * user-org-membership read the org switcher and the QuoxPlan proxy's
 * verifyQuoxplanOrgRole already use) — never invents a new auth path.
 * A trusted service-key caller (req.service, no req.user) has no orgs of
 * its own, so it must name them explicitly via ?org_ids=a,b (comma
 * separated), same convention as feedApiHandlers.js's resolveOrgId().
 *
 * @returns {Promise<string[]|null>} array of org ids (possibly empty — a
 *   real "this user belongs to nothing"), or null on a genuine resolution
 *   failure (auth service unreachable/non-2xx) — callers must NOT treat
 *   null the same as [].
 */
async function resolveCallerOrgIds(req, { authServiceUrl = AUTH_URL_DEFAULT, fetchFn, timeoutMs = ORG_TIMEOUT_MS } = {}) {
  const doFetch = fetchFn || globalThis.fetch;

  if (req.service) {
    const raw = req.query?.org_ids || req.body?.org_ids;
    if (!raw) return [];
    const ids = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
    return ids;
  }

  try {
    const headers = { Accept: 'application/json' };
    const auth = req.headers?.authorization;
    if (auth && /^Bearer /i.test(auth)) {
      headers.Authorization = auth;
    } else {
      const cookies = req.cookies || parseCookieHeader(req.headers?.cookie);
      if (cookies?.access_token) headers.Authorization = `Bearer ${cookies.access_token}`;
    }
    if (!headers.Authorization) return null;

    const resp = await doFetch(`${authServiceUrl}/api/orgs`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) {
      console.error(`[BrainOverview] GET /api/orgs failed HTTP ${resp.status}`);
      return null;
    }
    const data = await resp.json();
    const list = data.organizations || data.orgs || [];
    if (!Array.isArray(list)) return null;
    return list.map((o) => o && o.id).filter(Boolean);
  } catch (err) {
    console.error(`[BrainOverview] resolveCallerOrgIds failed: ${err.message}`);
    return null;
  }
}

/**
 * Fetches one org's brain status from quoxbrain (GET /brain/status), the
 * same X-Service-Key + X-Org-Id (+X-User-Id) wire contract as
 * brainImplant.js's fetchBrainContext. Never throws — a failure (timeout,
 * non-2xx, network error) comes back as {org_id, error: true}, never a
 * fabricated zero.
 */
async function fetchOrgBrainStatus(orgId, {
  brainServiceUrl = BRAIN_URL_DEFAULT,
  serviceKey = SERVICE_KEY_DEFAULT,
  userId,
  fetchFn,
  timeoutMs = BRAIN_TIMEOUT_MS,
} = {}) {
  const doFetch = fetchFn || globalThis.fetch;
  try {
    // embeddings=none: coverage is expensive on quoxbrain's single thread and
    // unused by the overview header; requesting it per-org in parallel blew
    // the timeout for many-org users (live incident 2026-08-25, header showed
    // a fabricated-looking 0 because every org row timed out).
    const resp = await doFetch(`${brainServiceUrl}/brain/status?embeddings=none`, {
      headers: {
        'X-Service-Key': serviceKey,
        'X-Org-Id': orgId || 'default',
        ...(userId ? { 'X-User-Id': userId } : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) {
      console.error(`[BrainOverview] org=${orgId}: GET /brain/status failed HTTP ${resp.status}`);
      return { org_id: orgId, error: true };
    }
    const data = await resp.json();
    const noteCount = typeof data.noteCount === 'number' ? data.noteCount : 0;
    const newestNoteAt = data.newestNoteAt ?? data.latestNoteAt ?? data.newest_note_at ?? null;
    const entry = { org_id: orgId, noteCount, newestNoteAt };
    // Owner confusion 2026-08-25: user-scope notes follow their owner into
    // every org context, so the scope-union noteCount contains the caller's
    // personal notes in EVERY org row. Carry quoxbrain's split through so the
    // aggregator can count org notes per org and personal notes exactly once.
    if (data.noteCountByScope && typeof data.noteCountByScope === 'object') {
      entry.noteCountByScope = {
        org: Number(data.noteCountByScope.org) || 0,
        user: Number(data.noteCountByScope.user) || 0,
        shared: Number(data.noteCountByScope.shared) || 0,
      };
    }
    if (data.embeddings !== undefined) entry.embeddings = data.embeddings;
    return entry;
  } catch (err) {
    console.error(`[BrainOverview] org=${orgId}: /brain/status fetch failed — ${err.message}`);
    return { org_id: orgId, error: true };
  }
}

/**
 * GET /api/brain/overview handler — RBAC-scoped all-orgs Qortex aggregate
 * (owner decision 2026-08-05: "ONE BRAIN: union of all orgs the user has
 * access to"). {total, orgs: [{org_id, noteCount, newestNoteAt}...]},
 * orgs sorted noteCount desc (error entries last). A per-org quoxbrain
 * failure is skipped from the total but kept in `orgs` as
 * {org_id, error: true} — never silently zeroed.
 */
function createGetOverviewHandler({
  authServiceUrl = AUTH_URL_DEFAULT,
  brainServiceUrl = BRAIN_URL_DEFAULT,
  serviceKey = SERVICE_KEY_DEFAULT,
  resolveOrgIdsFn = resolveCallerOrgIds,
  fetchStatusFn = fetchOrgBrainStatus,
  fetchFn,
  orgTimeoutMs = ORG_TIMEOUT_MS,
  brainTimeoutMs = BRAIN_TIMEOUT_MS,
} = {}) {
  return async function handleGetOverview(req, res) {
    let orgIds;
    try {
      orgIds = await resolveOrgIdsFn(req, { authServiceUrl, fetchFn, timeoutMs: orgTimeoutMs });
    } catch (err) {
      console.error(`[BrainOverview] org resolution threw: ${err.message}`);
      return res.status(502).json({ error: 'org resolution failed' });
    }

    if (orgIds === null) {
      return res.status(502).json({ error: 'org resolution failed' });
    }
    if (orgIds.length === 0) {
      return res.json({ total: 0, orgs: [] });
    }

    // JWT callers carry id (from the token's sub). A trusted service-key
    // caller has no req.user, so honour its explicit X-User-Id header (same
    // trust model as quoxbrain's own service auth) — never the other way
    // round: a JWT identity is never overridable by a header.
    const userId = req.user?.id || (req.service ? req.headers?.['x-user-id'] : null) || null;
    // Bounded fan-out: quoxbrain is single-threaded SQLite; a dozen parallel
    // status calls serialize server-side and push the later ones past the
    // timeout. Four in flight keeps a many-org caller well inside budget.
    const CONCURRENCY = 4;
    const results = new Array(orgIds.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, orgIds.length) }, async () => {
      while (cursor < orgIds.length) {
        const i = cursor++;
        results[i] = await fetchStatusFn(orgIds[i], {
          brainServiceUrl, serviceKey, userId, fetchFn, timeoutMs: brainTimeoutMs,
        });
      }
    }));

    // Dedupe the caller's personal (and instance-shared) notes: they appear in
    // every org's scope-union noteCount, so summing raw noteCounts counted
    // them once per org (owner-reported 2026-08-25: every org's brain "looked
    // the same"). When quoxbrain returns noteCountByScope, each org row shows
    // its OWN org-scope count and personal/shared are added to the total
    // exactly once. Legacy quoxbrain (no split): fall back to the old raw sum.
    const withScope = results.filter((r) => !r.error && r.noteCountByScope);
    const hasScopeSplit = withScope.length > 0;
    const personal = hasScopeSplit ? withScope[0].noteCountByScope.user : null;
    const shared = hasScopeSplit ? withScope[0].noteCountByScope.shared : null;

    const orgs = results.map((r) => {
      if (r.error || !r.noteCountByScope) return r;
      return { ...r, noteCount: r.noteCountByScope.org };
    }).sort((a, b) => {
      if (!!a.error !== !!b.error) return a.error ? 1 : -1;
      return (b.noteCount || 0) - (a.noteCount || 0);
    });

    const total = hasScopeSplit
      ? orgs.reduce((sum, r) => sum + (r.error ? 0 : (r.noteCount || 0)), 0) + (personal || 0) + (shared || 0)
      : results.reduce((sum, r) => sum + (r.error ? 0 : (r.noteCount || 0)), 0);

    return res.json({ total, personal, shared, orgs });
  };
}

module.exports = {
  resolveCallerOrgIds,
  fetchOrgBrainStatus,
  createGetOverviewHandler,
};
