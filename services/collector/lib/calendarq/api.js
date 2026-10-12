'use strict';

/**
 * Calendar-Q governed HTTP surface. L2-C0 shipped two read-only routes
 * (status + layers). L2-C1 adds the agenda/coverage/changes read surface, a
 * manual sync trigger, and the Google OAuth connect scaffold.
 *
 * Design: pure handler functions (async (ctx, deps) -> { status, json }),
 * same shape as lib/inboxq/api.js, plus a thin registerCalendarQRoutes(app,
 * deps) that wires them onto the collector app.
 *
 * Deliberately STRICTER than lib/inboxq/api.js at init: inboxq's
 * registerInboxqRoutes falls back to permissive no-op defaults (requireAuth
 * -> next(), resolveOrgId -> a request header, isPluginLicensed -> always
 * true) whenever a dep is omitted, so a misconfigured call site silently
 * serves ungoverned inbox data rather than failing loudly. Calendar-Q is a
 * brand-new surface with no legacy callers depending on that leniency, so
 * registerCalendarQRoutes THROWS AT INIT instead: a missing auth / org
 * resolver / licence-checker dep means these routes are never registered at
 * all, not registered wide open.
 *
 * INVARIANTS enforced here:
 *  - org is ALWAYS the server-resolved caller org (resolveOrgId), never a
 *    body/query field — a client cannot ask for another org's calendar.
 *  - every route is licence-gated on 'calendar-q' for that org. The one
 *    exception by necessity is GET /oauth/callback (see the oauth section
 *    below): Google's redirect is an unauthenticated browser navigation, so
 *    that single route is registered WITHOUT requireAuth and derives both
 *    org and the licence recheck from the single-use state row instead of
 *    the request.
 */

// ContactsQ P3b: additive, fail-soft attendee cards (lib/contactsq/identity.js never throws).
const contactIdentity = require('../contactsq/identityShim.js');
const store = require('./store');
const { getAgenda, getChanges } = require('./agenda');
const { runSync, computeWindow, todayInTz } = require('./syncWorker');
const { resolveGoogleOAuthClient, exchangeAuthorizationCode, AUTH_BASE_URL } = require('./providers/google');
const { buildInternalServiceHeaders } = require('../internalServiceHeaders');
const { getOverlay, buildWindowCoverageStatement } = require('./layers');
const { detectClashes } = require('./clash');
const { createProposal, listProposals } = require('./proposals');
const { executeCreateEvent } = require('./execute');
const { reconcileOperation } = require('./reconcile');
const { getPrep } = require('./prep');
const { buildBriefInput } = require('./brief');
const { proposeFollowUp } = require('./actionIntake');

const LICENCE_ID = 'calendar-q';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const DEFAULT_REDIRECT_URI = 'http://localhost:9848/api/v1/calendarq/oauth/callback';

function ok(json) { return { status: 200, json }; }
function bad(msg, status = 400) { return { status, json: { error: msg } }; }

// --- pure handlers -----------------------------------------------------------

/**
 * Org-scoped Calendar-Q overview: connection count + per-connection publish
 * watermark (from the latest PUBLISHED generation only — see
 * store.readPublishedOccurrences), plus the org's layer count.
 */
async function hStatus(ctx) {
  const connections = store.listConnections(ctx.orgId);
  const connectionsStatus = connections.map((conn) => {
    const published = store.readPublishedOccurrences(ctx.orgId, conn.id);
    return {
      connectionId: conn.id,
      provider: conn.provider,
      resourceId: conn.resourceId,
      status: conn.status,
      latestWatermarkTs: published ? published.generation.watermarkTs : null,
    };
  });
  const layerCount = store.listLayers(ctx.orgId).length;
  return ok({ connectionsCount: connections.length, connections: connectionsStatus, layerCount });
}

async function hLayers(ctx) {
  const layers = store.listLayers(ctx.orgId);
  return ok({ layers });
}

/** GET /agenda?connectionId=...&layerIds=a,b — the one read path for "what
 * does this connection's calendar look like". Never throws for an unsynced/
 * disconnected/stale connection — see lib/calendarq/agenda.js. */
async function hAgenda(ctx, deps = {}) {
  const connectionId = ctx.query.connectionId;
  if (!connectionId) return bad('connectionId is required');
  const layerIds = ctx.query.layerIds
    ? String(ctx.query.layerIds).split(',').map((s) => s.trim()).filter(Boolean)
    : null;
  const getAgendaFn = deps.getAgenda || getAgenda;
  try {
    const nowMs = typeof deps.now === 'function' ? deps.now() : Date.now();
    const agenda = getAgendaFn(ctx.orgId, { connectionId, layerIds, nowMs });
    return ok(agenda && Array.isArray(agenda.occurrences)
      ? { ...agenda, occurrences: contactIdentity.enrichOccurrences(ctx.orgId, agenda.occurrences) }
      : agenda);
  } catch (e) {
    if (e.message === 'calendarq_connection_not_found') return bad('connection not found', 404);
    throw e;
  }
}

/** GET /coverage?connectionId=... — the coverage half of hAgenda only. */
async function hCoverage(ctx, deps = {}) {
  const connectionId = ctx.query.connectionId;
  if (!connectionId) return bad('connectionId is required');
  const getAgendaFn = deps.getAgenda || getAgenda;
  try {
    const nowMs = typeof deps.now === 'function' ? deps.now() : Date.now();
    const agenda = getAgendaFn(ctx.orgId, { connectionId, nowMs });
    return ok({ coverage: agenda.coverage });
  } catch (e) {
    if (e.message === 'calendarq_connection_not_found') return bad('connection not found', 404);
    throw e;
  }
}

/** GET /changes?sinceGenerationId=... — evidenced diff since a previously
 * read generation. */
async function hChanges(ctx, deps = {}) {
  const sinceGenerationId = ctx.query.sinceGenerationId;
  if (!sinceGenerationId) return bad('sinceGenerationId is required');
  const getChangesFn = deps.getChanges || getChanges;
  try {
    const result = getChangesFn(ctx.orgId, { sinceGenerationId });
    return ok(result);
  } catch (e) {
    if (String(e.message).includes('sinceGenerationId not found')) return bad('sinceGenerationId not found', 404);
    throw e;
  }
}

/** Resolve the {windowStartLocalDate, windowEndLocalDateExclusive, timezone}
 * a request wants to see, defaulting to the same 7-back/30-fwd window the
 * sync worker uses when the caller does not specify one explicitly. */
function resolveOverlayWindow(ctx, nowMs) {
  const timezone = ctx.query.timezone || 'UTC';
  if (ctx.query.windowStartLocalDate && ctx.query.windowEndLocalDateExclusive) {
    return { timezone, windowStartLocalDate: ctx.query.windowStartLocalDate, windowEndLocalDateExclusive: ctx.query.windowEndLocalDateExclusive };
  }
  const fallback = computeWindow(nowMs, timezone);
  return { timezone, windowStartLocalDate: fallback.windowStart, windowEndLocalDateExclusive: fallback.windowEndExclusive };
}

/** GET /overlay — the merged, layer-tagged occurrence feed across every
 * layer kind (provider/internal_events/team_schedules/workflow_cron), with
 * per-layer coverage. Never throws on a single layer's failure — see
 * lib/calendarq/layers.js's per-layer isolation. */
async function hOverlay(ctx, deps = {}) {
  const getOverlayFn = deps.getOverlay || getOverlay;
  const fetchImpl = deps.fetchImpl || fetch;
  const nowMs = typeof deps.now === 'function' ? deps.now() : Date.now();
  const { timezone, windowStartLocalDate, windowEndLocalDateExclusive } = resolveOverlayWindow(ctx, nowMs);
  const overlay = await getOverlayFn(ctx.orgId, { userId: ctx.userId, windowStartLocalDate, windowEndLocalDateExclusive, timezone, fetchImpl, nowMs });
  return ok(overlay && Array.isArray(overlay.occurrences)
    ? { ...overlay, occurrences: contactIdentity.enrichOccurrences(ctx.orgId, overlay.occurrences) }
    : overlay);
}

/** GET /clashes — the overlay's occurrences run through the clash engine.
 * Every clash cites a windowCoverageStatement built from the SAME layer
 * coverage this call just fetched, so a clash claim is bounded by what was
 * actually checked. */
async function hClashes(ctx, deps = {}) {
  const getOverlayFn = deps.getOverlay || getOverlay;
  const detectClashesFn = deps.detectClashes || detectClashes;
  const fetchImpl = deps.fetchImpl || fetch;
  const nowMs = typeof deps.now === 'function' ? deps.now() : Date.now();
  const { timezone, windowStartLocalDate, windowEndLocalDateExclusive } = resolveOverlayWindow(ctx, nowMs);
  const overlay = await getOverlayFn(ctx.orgId, { userId: ctx.userId, windowStartLocalDate, windowEndLocalDateExclusive, timezone, fetchImpl, nowMs });
  const windowCoverageStatement = buildWindowCoverageStatement(overlay.layers);
  const clashes = detectClashesFn(ctx.orgId, { occurrences: overlay.occurrences, layers: overlay.layers, windowCoverageStatement, nowMs });
  return ok({ clashes, windowCoverageStatement });
}

/** POST /sync { connectionId } — manual trigger. Respects the same
 * retired/backoff eligibility runSync always enforces (no bypass here). */
async function hSync(ctx, deps = {}) {
  const connectionId = ctx.body?.connectionId;
  if (!connectionId) return bad('connectionId is required');
  const runSyncFn = deps.runSync || runSync;
  const fetchImpl = deps.fetchImpl || fetch;
  try {
    const nowMs = typeof deps.now === 'function' ? deps.now() : Date.now();
    const result = await runSyncFn(ctx.orgId, connectionId, { fetchImpl, nowMs });
    if (typeof deps.audit === 'function') {
      deps.audit({ type: 'action', intent: 'quox.calendar.sync', corr: connectionId, payload: { orgId: ctx.orgId, result } });
    }
    return ok({ result });
  } catch (e) {
    if (e.message === 'calendarq_connection_not_found') return bad('connection not found', 404);
    throw e;
  }
}

// --- L2-C2: proposals / reconcile / receipts ---------------------------------

/** POST /proposals { connectionId, title, timezone, startTs/endTs or
 * allDay+dateOnly, attendees, notifyPolicy, visibility, description } ->
 * { proposal, overlaps }. NO external effect — see proposals.js. */
async function hCreateProposal(ctx, deps = {}) {
  const createProposalFn = deps.createProposal || createProposal;
  const nowMs = typeof deps.now === 'function' ? deps.now() : Date.now();
  const result = createProposalFn(ctx.orgId, ctx.body || {}, { nowMs });
  if (!result.ok) return bad(result.errors.join('; '));
  return ok({ proposal: result.proposal, overlaps: result.overlaps });
}

/** GET /proposals -> { proposals: CalendarCreateProposalV1[] } — only
 * proposals still in state 'proposed' for this org (not yet sent for
 * approval, not yet expired). */
async function hListProposals(ctx, deps = {}) {
  const listProposalsFn = deps.listProposals || listProposals;
  return ok({ proposals: listProposalsFn(ctx.orgId) });
}

/** POST /reconcile/:opId -> resolves an attempted/outcome_unknown operation
 * against provider evidence. Read-only against the provider; no approval
 * gate needed (reconcile never creates/updates/deletes). */
async function hReconcile(ctx, deps = {}) {
  const opId = ctx.params.opId;
  if (!opId) return bad('opId is required');
  const reconcileFn = deps.reconcileOperation || reconcileOperation;
  const fetchImpl = deps.fetchImpl || fetch;
  const nowMs = typeof deps.now === 'function' ? deps.now() : Date.now();
  const auditFn = typeof deps.audit === 'function' ? deps.audit : () => {};
  const result = await reconcileFn(ctx.orgId, opId, { fetchImpl, nowMs, audit: auditFn, agentId: null });
  if (!result.success && result.error === 'operation_not_found') return bad('operation not found', 404);
  return ok(result);
}

/** GET /receipts -> { receipts: [...] }, org-scoped, newest first, each
 * carrying its operation's full state_history as a timeline. */
async function hReceipts(ctx, deps = {}) {
  const store2 = deps.store || store;
  const ops = store2.listOperations(ctx.orgId).filter((op) => op.kind === 'create_event');
  const opsByOpId = new Map(ops.map((op) => [op.opId, op]));
  const receipts = [];
  for (const op of ops) {
    for (const r of store2.listReceipts(ctx.orgId, op.opId)) {
      receipts.push({
        id: r.id,
        opId: r.opId,
        kind: r.kind,
        body: r.body,
        createdAt: r.createdAt,
        proposalId: op.proposal ? op.proposal.proposalId : null,
        operationState: (opsByOpId.get(r.opId) || {}).state || null,
        stateHistory: (opsByOpId.get(r.opId) || {}).stateHistory || [],
      });
    }
  }
  receipts.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return ok({ receipts });
}

// --- L2-C3: meeting prep / morning-brief input / Action-Q follow-up intake --

/** GET /prep/:occurrenceKey — meeting prep for one occurrence, IN-PROCESS
 * joined against the org's own InboxQ store. See lib/calendarq/prep.js. */
async function hPrep(ctx, deps = {}) {
  const occurrenceKey = ctx.params.occurrenceKey;
  if (!occurrenceKey) return bad('occurrenceKey is required');
  const getPrepFn = deps.getPrep || getPrep;
  try {
    const nowMs = typeof deps.now === 'function' ? deps.now() : Date.now();
    const prep = getPrepFn(ctx.orgId, { occurrenceKey, nowMs });
    if (typeof deps.audit === 'function') {
      deps.audit({ type: 'action', intent: 'quox.calendar.prep', corr: occurrenceKey, payload: { orgId: ctx.orgId, referenceCount: prep.references.length } });
    }
    return ok({ prep });
  } catch (e) {
    if (e.message === 'occurrence_not_found') return bad('occurrence not found', 404);
    throw e;
  }
}

/** GET /brief-input?workday=&timezone=&force= — the AssistantQ morning-brief
 * data contract. Defaults workday to today in the given (or UTC) timezone.
 * See lib/calendarq/brief.js. */
async function hBriefInput(ctx, deps = {}) {
  const buildBriefInputFn = deps.buildBriefInput || buildBriefInput;
  const fetchImpl = deps.fetchImpl || fetch;
  const nowMs = typeof deps.now === 'function' ? deps.now() : Date.now();
  const timezone = ctx.query.timezone || 'UTC';
  const workday = ctx.query.workday || todayInTz(nowMs, timezone);
  const force = ctx.query.force === 'true' || ctx.query.force === true;
  const { brief, upcomingPrep, created } = await buildBriefInputFn(ctx.orgId, { workday, timezone, nowMs, fetchImpl, force });
  if (typeof deps.audit === 'function') {
    deps.audit({ type: 'action', intent: 'quox.calendar.read', corr: workday, payload: { orgId: ctx.orgId, created, upcomingCount: brief.upcoming.length } });
  }
  return ok({ brief, upcomingPrep, created });
}

/** POST /followups { idempotencyKey, title, sourceRefs, owner, deadlineTs,
 * deadlineEvidence } — explicit-provenance-only Action-Q follow-up intake.
 * See lib/calendarq/actionIntake.js. No approval gate: an internal board
 * write, not an external effect. */
async function hFollowupPropose(ctx, deps = {}) {
  const proposeFollowUpFn = deps.proposeFollowUp || proposeFollowUp;
  const actionCtx = { userId: ctx.userId, agentId: 'calendar-q', token: deps.token || null };
  const result = await proposeFollowUpFn(ctx.orgId, ctx.body || {}, actionCtx);
  if (!result.ok) return bad(result.errors.join('; '));
  if (typeof deps.audit === 'function') {
    deps.audit({ type: 'action', intent: 'quox.calendar.propose', corr: result.actionItemId, payload: { orgId: ctx.orgId, actionItemId: result.actionItemId, duplicate: Boolean(result.duplicate) } });
  }
  return ok({ actionItemId: result.actionItemId, duplicate: Boolean(result.duplicate) });
}

// --- OAuth connect scaffold --------------------------------------------------
//
// /oauth/start stays behind requireAuth — it is launched from inside the
// authenticated dashboard, where ctx.orgId is the server-resolved caller org.
//
// /oauth/callback is registered WITHOUT requireAuth (see registerCalendarQRoutes
// below) because Google's redirect back to it is a plain, unauthenticated
// browser navigation — it cannot carry our bearer token. Security is carried
// entirely by the single-use state token instead:
//   - store.consumeOauthState() deletes the row on the FIRST attempt whether
//     that attempt succeeds or fails, so a state can never be replayed and a
//     failed attempt can't be retried either.
//   - expiry is enforced inside consumeOauthState (a found-but-expired row is
//     still deleted and still reported as if it never existed — no
//     expired-vs-unknown oracle).
//   - the row's own org_id + credential_id are the ONLY source of org/
//     connection context for the rest of this handler — ctx carries no
//     caller-asserted org for this route, so there is nothing for an
//     attacker-controlled request to override.
//   - the licence gate that every other route gets from registerCalendarQRoutes's
//     wrap() is re-applied here by hand, keyed off the org the state row names,
//     since this route bypasses wrap() entirely.
// Tests exercise the handlers directly with stub deps.

function resolveRedirectUri(deps) {
  return deps.oauthRedirectUri || process.env.CALENDARQ_OAUTH_REDIRECT_URI || DEFAULT_REDIRECT_URI;
}

/** GET /oauth/start?credentialId=... — builds the Google consent URL from a
 * vault credential's client_id and a fresh, single-use state token. */
async function hOauthStart(ctx, deps = {}) {
  const credentialId = ctx.query.credentialId;
  if (!credentialId) return bad('credentialId is required');
  const fetchImpl = deps.fetchImpl || fetch;
  const resolveClient = deps.resolveGoogleOAuthClient || resolveGoogleOAuthClient;
  let client;
  try {
    client = await resolveClient(ctx.orgId, credentialId, { fetchImpl });
  } catch (e) {
    return bad(`could not resolve OAuth client credential: ${e.code || e.message}`, 502);
  }
  const { state } = store.createOauthState({ orgId: ctx.orgId, credentialId });
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: resolveRedirectUri(deps),
    response_type: 'code',
    scope: GOOGLE_CALENDAR_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return ok({ consentUrl: `${GOOGLE_AUTH_URL}?${params.toString()}`, state, credentialId });
}

/**
 * Write-back of the exchanged refresh token into the SAME vault credential
 * the OAuth client config came from, via the auth service's internal
 * credential-fields endpoint (PATCH /api/setup/internal/credential-fields/:id,
 * guarded by the same INTERNAL_SERVICE_KEY check as the credential-decrypt
 * route). Failure is reported honestly as a next-step for a human, never
 * masked as success and never silently swallowed.
 */
async function attemptCredentialWriteBack(orgId, credentialId, fields, { fetchImpl = fetch } = {}) {
  const url = `${AUTH_BASE_URL}/setup/internal/credential-fields/${encodeURIComponent(credentialId)}?org_id=${encodeURIComponent(orgId)}`;
  try {
    const resp = await fetchImpl(url, {
      method: 'PATCH',
      headers: { ...buildInternalServiceHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
      signal: AbortSignal.timeout(15000),
    });
    if (resp.ok) return { written: true };
    if (resp.status === 404) return { written: false, reason: 'write_back_endpoint_unavailable' };
    return { written: false, reason: `write_back_failed_${resp.status}` };
  } catch {
    return { written: false, reason: 'write_back_request_failed' };
  }
}

/** GET /oauth/callback?state=...&code=... — PUBLIC (no requireAuth, see the
 * oauth section comment above). Validates the single-use state, derives org
 * + credential entirely from the consumed state row, re-applies the licence
 * gate by hand (this route bypasses wrap()), exchanges the code for tokens,
 * and attempts the write-back above. Never returns a token value. */
async function hOauthCallback(ctx, deps = {}) {
  const { state, code, error } = ctx.query;
  if (error) return bad('provider returned an error', 400);
  if (!state || !code) return bad('state and code are required', 400);

  // consumeOauthState deletes the row on this first attempt regardless of
  // outcome (see store.js) — a found-but-expired row is already gone and
  // reported identically to an unknown one, so there is no expired-vs-unknown
  // oracle and no replay window.
  const consumed = store.consumeOauthState(state);
  if (!consumed) return bad('state is invalid or expired', 400);

  // Org and credential come ONLY from the state row from here on — never
  // from ctx/the request, which for this unauthenticated route carries no
  // caller-asserted org anyway.
  const orgId = consumed.orgId;
  const credentialId = consumed.credentialId;

  if (typeof deps.isPluginLicensed === 'function') {
    const licensed = await deps.isPluginLicensed(orgId, LICENCE_ID);
    if (!licensed) return bad(`${LICENCE_ID} not licensed for this org`, 402);
  }

  const fetchImpl = deps.fetchImpl || fetch;
  const resolveClient = deps.resolveGoogleOAuthClient || resolveGoogleOAuthClient;
  let client;
  try {
    client = await resolveClient(orgId, credentialId, { fetchImpl });
  } catch (e) {
    return bad(`could not resolve OAuth client credential: ${e.code || e.message}`, 502);
  }

  const exchange = deps.exchangeAuthorizationCode || exchangeAuthorizationCode;
  let tokens;
  try {
    tokens = await exchange(code, { clientId: client.clientId, clientSecret: client.clientSecret, redirectUri: resolveRedirectUri(deps), fetchImpl });
  } catch (e) {
    return bad(`code exchange failed: ${e.code || e.message}`, 502);
  }

  const writeBack = deps.attemptCredentialWriteBack
    ? await deps.attemptCredentialWriteBack(orgId, credentialId, { refresh_token: tokens.refreshToken }, { fetchImpl })
    : await attemptCredentialWriteBack(orgId, credentialId, { refresh_token: tokens.refreshToken }, { fetchImpl });

  if (writeBack.written) {
    return ok({ connected: true, credentialId, message: 'Refresh token stored in the vault credential.' });
  }
  return ok({
    connected: false,
    credentialId,
    refreshTokenObtained: true,
    writeBackStatus: writeBack.reason,
    nextStep: `A refresh token was obtained from Google but could not be written back to vault credential ${credentialId} automatically (${writeBack.reason}). A human with vault write access must store it manually before sync can run.`,
  });
}

/**
 * Terse, human-readable HTML page for the browser landing on /oauth/callback.
 * Deliberately ignores the request's own query string and the handler's
 * specific error text — only a fixed, status-shaped message is ever
 * rendered, so there is no stack trace, no echo of query params, and no way
 * for provider-supplied text (e.g. ?error=...) to reach this page's markup.
 * Never includes a token value (the handler's json never carries one either).
 */
function renderOauthCallbackPage(status, json) {
  let heading;
  let body;
  if (status === 200 && json && json.connected === true) {
    heading = 'Calendar connected';
    body = 'Your Google Calendar has been connected. You can close this tab.';
  } else if (status === 200) {
    heading = 'Almost there';
    body = 'Google authorized the connection, but an administrator needs to finish linking it. You can close this tab.';
  } else if (status === 429) {
    heading = 'Too many attempts';
    body = 'Please wait a moment and try connecting your calendar again.';
  } else {
    heading = 'Could not connect your calendar';
    body = 'Something went wrong while connecting your calendar. Please close this tab and try again, or contact support if the problem continues.';
  }
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(heading)}</title></head>`
    + `<body style="font-family:sans-serif;max-width:480px;margin:80px auto;text-align:center;">`
    + `<h1>${escapeHtml(heading)}</h1><p>${escapeHtml(body)}</p></body></html>`;
}

/**
 * Fallback per-IP token bucket used ONLY when the caller (server.js) does not
 * inject a real deps.oauthCallbackRateLimiter (e.g. express-rate-limit).
 * Simple and in-memory, matching the task's "else a simple in-memory bucket"
 * instruction — production wiring always supplies the real limiter.
 */
function createDefaultOauthCallbackLimiter({ windowMs = 60_000, max = 30 } = {}) {
  const buckets = new Map();
  return function defaultOauthCallbackLimiter(req, res, next) {
    const key = req.ip || req.connection?.remoteAddress || 'unknown';
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.windowStart > windowMs) {
      bucket = { count: 0, windowStart: now };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      return res.status(429).set('Content-Type', 'text/html; charset=utf-8').send(renderOauthCallbackPage(429, null));
    }
    next();
  };
}

// --- registration ------------------------------------------------------------

/**
 * registerCalendarQRoutes(app, deps) — fail-closed wiring.
 *
 * deps.requireAuth (express middleware), deps.resolveOrgId (req -> orgId),
 * and deps.isPluginLicensed (orgId, pluginId) -> bool|Promise<bool> are all
 * REQUIRED. Any missing one throws synchronously, before a single route is
 * registered — see the module doc comment above for why this intentionally
 * does not fall back the way lib/inboxq/api.js does.
 */
function registerCalendarQRoutes(app, deps = {}) {
  if (typeof deps.requireAuth !== 'function') throw new Error('registerCalendarQRoutes requires deps.requireAuth');
  if (typeof deps.resolveOrgId !== 'function') throw new Error('registerCalendarQRoutes requires deps.resolveOrgId');
  if (typeof deps.isPluginLicensed !== 'function') throw new Error('registerCalendarQRoutes requires deps.isPluginLicensed');

  const { requireAuth, resolveOrgId, isPluginLicensed } = deps;

  const wrap = (handler) => async (req, res) => {
    try {
      const orgId = resolveOrgId(req);
      if (!orgId) return res.status(401).json({ error: 'unauthenticated' });
      // Awaited deliberately: isPluginLicensed may be async (the real
      // collector's isPluginLicensedForOrg is), and a licence gate that is
      // never actually awaited is a licence gate that never blocks.
      const licensed = await isPluginLicensed(orgId, LICENCE_ID);
      if (!licensed) return res.status(402).json({ error: `${LICENCE_ID} not licensed for this org` });
      const ctx = {
        orgId,
        userId: req.user?.id || req.auth?.userId || null,
        body: req.body || {},
        params: req.params || {},
        query: req.query || {},
      };
      const { status, json } = await handler(ctx, deps);
      res.status(status).json(json);
    } catch (e) {
      // Never leak internals; log server-side.
      console.error('[calendarq] route error:', e?.message);
      res.status(500).json({ error: 'internal_error' });
    }
  };

  app.get('/api/v1/calendarq/status', requireAuth, wrap(hStatus));
  app.get('/api/v1/calendarq/layers', requireAuth, wrap(hLayers));
  app.get('/api/v1/calendarq/agenda', requireAuth, wrap(hAgenda));
  app.get('/api/v1/calendarq/coverage', requireAuth, wrap(hCoverage));
  app.get('/api/v1/calendarq/changes', requireAuth, wrap(hChanges));
  app.get('/api/v1/calendarq/overlay', requireAuth, wrap(hOverlay));
  app.get('/api/v1/calendarq/clashes', requireAuth, wrap(hClashes));
  app.post('/api/v1/calendarq/sync', requireAuth, wrap(hSync));
  app.get('/api/v1/calendarq/oauth/start', requireAuth, wrap(hOauthStart));

  // /oauth/callback is the one deliberate exception to "every route behind
  // requireAuth" — see the oauth section comment above hOauthCallback. No
  // requireAuth, no resolveOrgId off the request: org comes from the
  // consumed state row inside the handler. Rate-limited to blunt state-token
  // guessing; deps.oauthCallbackRateLimiter is the real (express-rate-limit)
  // limiter server.js injects, falling back to a simple in-memory bucket.
  const oauthCallbackRateLimiter = deps.oauthCallbackRateLimiter || createDefaultOauthCallbackLimiter();
  app.get('/api/v1/calendarq/oauth/callback', oauthCallbackRateLimiter, async (req, res) => {
    try {
      const ctx = { orgId: null, userId: null, body: {}, params: {}, query: req.query || {} };
      const { status, json } = await hOauthCallback(ctx, deps);
      res.status(status).set('Content-Type', 'text/html; charset=utf-8').send(renderOauthCallbackPage(status, json));
    } catch (e) {
      console.error('[calendarq] oauth callback error:', e?.message);
      res.status(500).set('Content-Type', 'text/html; charset=utf-8').send(renderOauthCallbackPage(500, null));
    }
  });

  app.post('/api/v1/calendarq/proposals', requireAuth, wrap(hCreateProposal));
  app.get('/api/v1/calendarq/proposals', requireAuth, wrap(hListProposals));
  app.post('/api/v1/calendarq/reconcile/:opId', requireAuth, wrap(hReconcile));
  app.get('/api/v1/calendarq/receipts', requireAuth, wrap(hReceipts));
  app.get('/api/v1/calendarq/prep/:occurrenceKey', requireAuth, wrap(hPrep));
  app.get('/api/v1/calendarq/brief-input', requireAuth, wrap(hBriefInput));
  app.post('/api/v1/calendarq/followups', requireAuth, wrap(hFollowupPropose));
}

module.exports = {
  registerCalendarQRoutes,
  // handlers exported for unit tests
  _handlers: {
    hStatus, hLayers, hAgenda, hCoverage, hChanges, hOverlay, hClashes, hSync, hOauthStart, hOauthCallback, attemptCredentialWriteBack,
    hCreateProposal, hListProposals, hReconcile, hReceipts,
    hPrep, hBriefInput, hFollowupPropose,
    _oauthCallbackPageForTest: renderOauthCallbackPage,
  },
};
