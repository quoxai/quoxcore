/**
 * calendarQService — Calendar-Q frontend client (AQ-9B L2-C1b).
 *
 * Calendar-Q is collector-native, same shape as InboxQ: no separate backend
 * service, no :port to proxy. The collector registers these routes at
 * /api/v1/calendarq/* (see services/collector/lib/calendarq/api.js), and the
 * dashboard reaches them through the same-origin `/collector` prefix nginx
 * strips before it hits the collector app — mirrors
 * src/components/inboxq/lib/api.js exactly.
 *
 * Every function takes `authFetch` (from useAuth()) as its first argument,
 * same convention as teamService.js/workflowEngine.js. Org is resolved
 * server-side from the authenticated session (ctx.orgId in
 * registerCalendarQRoutes) — there is no org id to pass from here, the same
 * posture InboxQ's client relies on.
 *
 * Read-only in this phase (status/layers/agenda/coverage/changes/overlay/
 * clashes/sync/oauthStart) — there is no event-create call yet.
 *
 * House rule: server-side is the source of truth. This module holds no
 * cache of its own; every call hits the collector.
 */

const API_BASE = '/collector/api/v1/calendarq';

/** Thrown on any non-2xx response. Carries status + the parsed error body so
 * callers can surface body.error — never treats an error body as data. */
export class CalendarQApiError extends Error {
  constructor(status, body) {
    super((body && body.error) || `Calendar-Q API error ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function parseBody(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function get(authFetch, path) {
  const res = await authFetch(`${API_BASE}${path}`);
  const body = await parseBody(res);
  if (!res.ok) throw new CalendarQApiError(res.status, body);
  return body;
}

async function post(authFetch, path, payload) {
  const res = await authFetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const body = await parseBody(res);
  if (!res.ok) throw new CalendarQApiError(res.status, body);
  return body;
}

function qs(params = {}) {
  const usp = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v === undefined || v === null || v === '') return;
    usp.set(k, Array.isArray(v) ? v.join(',') : String(v));
  });
  const str = usp.toString();
  return str ? `?${str}` : '';
}

/** GET /status -> { connectionsCount, connections, layerCount }. */
export function getStatus(authFetch) {
  return get(authFetch, '/status');
}

/** GET /layers -> { layers: CalendarLayerV1[] }. */
export function getLayers(authFetch) {
  return get(authFetch, '/layers');
}

/** GET /agenda?connectionId=&layerIds= -> CalendarAgendaV1 ({ coverage, occurrences }). */
export function getAgenda(authFetch, { connectionId, layerIds } = {}) {
  return get(authFetch, `/agenda${qs({ connectionId, layerIds })}`);
}

/** GET /coverage?connectionId= -> { coverage }. */
export function getCoverage(authFetch, { connectionId } = {}) {
  return get(authFetch, `/coverage${qs({ connectionId })}`);
}

/** GET /changes?sinceGenerationId= -> evidenced diff since a prior generation. */
export function getChanges(authFetch, { sinceGenerationId } = {}) {
  return get(authFetch, `/changes${qs({ sinceGenerationId })}`);
}

/** GET /overlay?windowStartLocalDate=&windowEndLocalDateExclusive=&timezone=
 * -> { layers, occurrences, generatedAt }. All params optional, server
 * defaults to the 7-back/30-fwd window. */
export function getOverlay(authFetch, { windowStartLocalDate, windowEndLocalDateExclusive, timezone } = {}) {
  return get(authFetch, `/overlay${qs({ windowStartLocalDate, windowEndLocalDateExclusive, timezone })}`);
}

/** GET /clashes?same window params -> { clashes, windowCoverageStatement }. */
export function getClashes(authFetch, { windowStartLocalDate, windowEndLocalDateExclusive, timezone } = {}) {
  return get(authFetch, `/clashes${qs({ windowStartLocalDate, windowEndLocalDateExclusive, timezone })}`);
}

/** POST /sync { connectionId } -> { result }. Manual sync trigger. */
export function sync(authFetch, { connectionId } = {}) {
  return post(authFetch, '/sync', { connectionId });
}

/** GET /oauth/start?credentialId= -> { consentUrl, state, credentialId }. */
export function oauthStart(authFetch, { credentialId } = {}) {
  return get(authFetch, `/oauth/start${qs({ credentialId })}`);
}

/** GET /receipts -> { receipts: [...] } (L2-C2) — org-scoped, newest first,
 * each receipt carrying its operation's state (incl. outcome_unknown) and
 * full state_history timeline. The Receipts tab's only data source. */
export function listReceipts(authFetch) {
  return get(authFetch, '/receipts');
}

/** GET /prep/:occurrenceKey -> { prep: MeetingPrepV1 } (L2-C3). Deterministic,
 * zero-LLM structured prep for one occurrence, joined against the org's own
 * InboxQ mail server-side — the agent sidebar renders language from this,
 * this module holds no cache of its own. */
export function getPrep(authFetch, { occurrenceKey } = {}) {
  return get(authFetch, `/prep/${encodeURIComponent(occurrenceKey)}`);
}

/** GET /brief-input?workday=&timezone=&force= -> { brief: CalendarBriefInputV1,
 * upcomingPrep, created } (L2-C3). The AssistantQ morning-brief data contract
 * — workday defaults server-side to today in the given (or UTC) timezone. */
export function getBriefInput(authFetch, { workday, timezone, force } = {}) {
  return get(authFetch, `/brief-input${qs({ workday, timezone, force: force ? 'true' : undefined })}`);
}

export default {
  getStatus,
  getLayers,
  getAgenda,
  getCoverage,
  getChanges,
  getOverlay,
  getClashes,
  sync,
  oauthStart,
  listReceipts,
  getPrep,
  getBriefInput,
};
