'use strict';

/**
 * Calendar-Q's Google Calendar provider adapter (L2-C1).
 *
 * Four responsibilities, each independently testable against injected
 * fetchImpl stubs (NEVER a live network call from a test):
 *   - resolveGoogleCredential: JIT-decrypt a BYO-OAuth-client vault
 *     credential (client_id/client_secret/refresh_token), same shape as
 *     lib/inboxq/credential.js's resolveEmailCredential.
 *   - getAccessToken: exchange the refresh token for a short-lived access
 *     token, cached in-memory per credentialId until near expiry.
 *   - listEventsWindow / listCalendars: the read-only Calendar API calls the
 *     sync worker drives.
 *   - normalizeEvent: map one raw Google event into the CalendarAgendaV1
 *     occurrence shape (contracts.js) — or report it as an omission, never
 *     drop it silently.
 *
 * No LLM/model call anywhere in this module — every mapping here is a
 * deterministic field transform or Intl.DateTimeFormat template.
 */

const { buildInternalServiceHeaders } = require('../../internalServiceHeaders');
const { sanitizeText } = require('../textSanitize');

const AUTH_BASE_URL = `http://${process.env.AUTH_HOST || 'auth'}:${process.env.AUTH_PORT || '3101'}/api`;

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';

/** Typed provider error: `.code` is the thing callers branch on, `.message`
 * is just the code again so an uncaught instance still logs something
 * useful. Extra fields (e.g. retryAfterMs) are copied onto the instance. */
class CalendarProviderError extends Error {
  constructor(code, extra = {}) {
    super(code);
    this.name = 'CalendarProviderError';
    this.code = code;
    Object.assign(this, extra);
  }
}

// --- credential resolve ------------------------------------------------------

/**
 * Narrower resolve for the OAuth connect flow (start/callback), BEFORE a
 * refresh token exists yet: only client_id/client_secret are required.
 * Distinct from resolveGoogleCredential below, which is the sync path's
 * resolve and additionally requires a refresh_token.
 */
async function resolveGoogleOAuthClient(orgId, credentialId, { agentId = null, fetchImpl = fetch } = {}) {
  if (!orgId || !credentialId) throw new CalendarProviderError('credential_resolve_failed');

  const url = `${AUTH_BASE_URL}/setup/internal/credential-decrypt/${encodeURIComponent(credentialId)}`
    + `?org_id=${encodeURIComponent(orgId)}${agentId ? `&agent_id=${encodeURIComponent(agentId)}` : ''}`;

  let resp;
  try {
    resp = await fetchImpl(url, { headers: buildInternalServiceHeaders(), signal: AbortSignal.timeout(15000) });
  } catch {
    throw new CalendarProviderError('credential_resolve_failed');
  }
  if (resp.status === 403) {
    const data = await resp.json().catch(() => ({}));
    throw new CalendarProviderError(data?.reason || 'lease_required');
  }
  if (!resp.ok) throw new CalendarProviderError('credential_resolve_failed');

  const data = await resp.json().catch(() => ({}));
  const c = data?.credentials || data?.credential || null;
  if (!c || !c.client_id || !c.client_secret) throw new CalendarProviderError('credential_incomplete');

  return { credentialId, clientId: c.client_id, clientSecret: c.client_secret };
}

/**
 * Exchange an OAuth authorization code for a token set (the connect flow's
 * callback step). Never caches — this is a one-shot exchange, not the
 * ongoing refresh getAccessToken does.
 */
async function exchangeAuthorizationCode(code, { clientId, clientSecret, redirectUri, fetchImpl = fetch } = {}) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  });
  let resp;
  try {
    resp = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch {
    throw new CalendarProviderError('code_exchange_failed');
  }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.refresh_token) throw new CalendarProviderError('code_exchange_failed');
  return { refreshToken: data.refresh_token, accessToken: data.access_token || null, expiresIn: data.expires_in || null };
}

/**
 * @param {string} orgId
 * @param {string} credentialId
 * @param {object} [opts] { agentId, fetchImpl }
 * @returns {Promise<{credentialId, clientId, clientSecret, refreshToken}>}
 * @throws CalendarProviderError('credential_resolve_failed' | 'lease_required' | 'credential_incomplete')
 */
async function resolveGoogleCredential(orgId, credentialId, { agentId = null, fetchImpl = fetch } = {}) {
  if (!orgId || !credentialId) throw new CalendarProviderError('credential_resolve_failed');

  const url = `${AUTH_BASE_URL}/setup/internal/credential-decrypt/${encodeURIComponent(credentialId)}`
    + `?org_id=${encodeURIComponent(orgId)}${agentId ? `&agent_id=${encodeURIComponent(agentId)}` : ''}`;

  let resp;
  try {
    resp = await fetchImpl(url, {
      headers: buildInternalServiceHeaders(),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new CalendarProviderError('credential_resolve_failed');
  }

  if (resp.status === 403) {
    const data = await resp.json().catch(() => ({}));
    throw new CalendarProviderError(data?.reason || 'lease_required');
  }
  if (!resp.ok) throw new CalendarProviderError('credential_resolve_failed');

  const data = await resp.json().catch(() => ({}));
  const c = data?.credentials || data?.credential || null;
  if (!c) throw new CalendarProviderError('credential_resolve_failed');

  if (!c.client_id || !c.client_secret || !c.refresh_token) {
    throw new CalendarProviderError('credential_incomplete');
  }

  return {
    credentialId,
    clientId: c.client_id,
    clientSecret: c.client_secret,
    refreshToken: c.refresh_token,
  };
}

// --- access token (refresh-token exchange, in-memory cache) -----------------

// Keyed by credentialId -> { accessToken, expiresAtMs }. Process-local; a
// restart simply re-exchanges, which is cheap and never user-visible.
const _tokenCache = new Map();

/** Test seam: clear the cache so tests don't leak state across cases. */
function _resetTokenCache() {
  _tokenCache.clear();
}

/**
 * @param {{credentialId, clientId, clientSecret, refreshToken}} cred
 * @param {object} [opts] { fetchImpl, nowMs }
 * @returns {Promise<string>} access token
 * @throws CalendarProviderError('reauth_required' | 'token_refresh_failed')
 */
async function getAccessToken(cred, { fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const cached = _tokenCache.get(cred.credentialId);
  // 60s skew: never hand out a token that could expire mid-request.
  if (cached && cached.expiresAtMs - 60000 > nowMs) return cached.accessToken;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: cred.clientId,
    client_secret: cred.clientSecret,
    refresh_token: cred.refreshToken,
  });

  let resp;
  try {
    resp = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch {
    throw new CalendarProviderError('token_refresh_failed');
  }

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    // invalid_grant = the refresh token itself is dead (revoked, expired,
    // client secret rotated) — this must surface as a connection needing a
    // fresh OAuth consent, never retried silently forever.
    if (data?.error === 'invalid_grant') throw new CalendarProviderError('reauth_required');
    throw new CalendarProviderError('token_refresh_failed');
  }
  if (!data?.access_token) throw new CalendarProviderError('token_refresh_failed');

  const expiresInMs = (Number(data.expires_in) || 3600) * 1000;
  _tokenCache.set(cred.credentialId, { accessToken: data.access_token, expiresAtMs: nowMs + expiresInMs });
  return data.access_token;
}

// --- read calls ---------------------------------------------------------------

function readRetryAfterMs(resp) {
  let raw = null;
  try {
    if (resp.headers && typeof resp.headers.get === 'function') raw = resp.headers.get('Retry-After');
    else if (resp.headers) raw = resp.headers['retry-after'] || resp.headers['Retry-After'];
  } catch { /* defensive only */ }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n * 1000 : 60000;
}

/**
 * Fetch every event in [timeMinIso, timeMaxIso) for one calendar, following
 * nextPageToken until exhausted. Google's events.list with singleEvents=true
 * already returns any event that OVERLAPS the [timeMin, timeMax) range (not
 * just ones starting inside it) — an event starting before timeMin but
 * ending after it is still returned, so the caller does not need to widen
 * timeMin itself to catch in-progress events at the window boundary.
 *
 * Collects ALL pages before returning. A failed page (anything but a clean
 * 200) throws rather than returning whatever was collected so far — a
 * partial page set must never be reported as a complete window.
 *
 * @throws CalendarProviderError('throttled', {retryAfterMs}) on HTTP 429
 * @throws CalendarProviderError('pagination_incomplete') on any other failure
 */
async function listEventsWindow({ accessToken, calendarId, timeMinIso, timeMaxIso, fetchImpl = fetch }) {
  const items = [];
  let pageToken = null;
  do {
    const params = new URLSearchParams({
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '250',
      showDeleted: 'false',
      timeMin: timeMinIso,
      timeMax: timeMaxIso,
    });
    if (pageToken) params.set('pageToken', pageToken);
    const url = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`;

    let resp;
    try {
      resp = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    } catch {
      throw new CalendarProviderError('pagination_incomplete');
    }

    if (resp.status === 429) {
      throw new CalendarProviderError('throttled', { retryAfterMs: readRetryAfterMs(resp) });
    }
    if (!resp.ok) throw new CalendarProviderError('pagination_incomplete');

    const data = await resp.json().catch(() => null);
    if (!data) throw new CalendarProviderError('pagination_incomplete');

    items.push(...(Array.isArray(data.items) ? data.items : []));
    pageToken = data.nextPageToken || null;
  } while (pageToken);

  return items;
}

/** List the account's calendars (for resource selection at connect time). */
async function listCalendars({ accessToken, fetchImpl = fetch }) {
  const items = [];
  let pageToken = null;
  do {
    const params = new URLSearchParams({ maxResults: '250' });
    if (pageToken) params.set('pageToken', pageToken);
    const url = `${CALENDAR_API_BASE}/users/me/calendarList?${params.toString()}`;

    let resp;
    try {
      resp = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    } catch {
      throw new CalendarProviderError('pagination_incomplete');
    }
    if (resp.status === 429) throw new CalendarProviderError('throttled', { retryAfterMs: readRetryAfterMs(resp) });
    if (!resp.ok) throw new CalendarProviderError('pagination_incomplete');

    const data = await resp.json().catch(() => null);
    if (!data) throw new CalendarProviderError('pagination_incomplete');
    items.push(...(Array.isArray(data.items) ? data.items : []));
    pageToken = data.nextPageToken || null;
  } while (pageToken);

  return items;
}

// --- write calls (L2-C2) -------------------------------------------------------
//
// Both calls below distinguish THREE outcomes execute.js/reconcile.js treat
// very differently:
//   - the fetchImpl call itself throws (DNS, connection reset, our own
//     AbortSignal timeout) -> the request's fate is UNKNOWN. insertEvent
//     throws CalendarProviderError('network_lost'); getEvent throws
//     ('provider_unreachable'). Neither is ever treated as "it failed".
//   - a clean HTTP response that is not 2xx -> the provider DID answer, and
//     said no (or "not found"). insertEvent throws ('provider_http_error',
//     {status, body}); getEvent throws ('not_found') on 404, or
//     ('provider_unreachable') on any other non-2xx (fail toward "keep
//     retrying reconcile", never toward "assume failed" on an ambiguous
//     provider-side error).
//   - a clean 2xx -> the parsed event resource is returned.

/**
 * events.insert — the ONLY place in Calendar-Q that ever creates a provider
 * event. `eventId` becomes the request body's `id` field so the SAME id
 * execute.js already generated at propose time (proposals.js's opId) is what
 * the provider assigns — reconcile.js's events.get(eventId) depends on this.
 */
async function insertEvent({ accessToken, calendarId, eventId, eventBody, sendUpdates = 'none', fetchImpl = fetch }) {
  const params = new URLSearchParams({ sendUpdates });
  const url = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`;
  let resp;
  try {
    resp = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: eventId, ...eventBody }),
      // Audit fix 4: a hung connection here must never leave an op stuck
      // 'attempted' forever. AbortSignal.timeout fires a 'TimeoutError'
      // DOMException (not 'AbortError'); the bare catch below already
      // treats ANY rejection as network_lost, so the timeout lands on the
      // EXISTING outcome_unknown path in execute.js with no new branching.
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new CalendarProviderError('network_lost');
  }
  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    throw new CalendarProviderError('provider_http_error', { status: resp.status, body: data });
  }
  if (!data) throw new CalendarProviderError('provider_http_error', { status: resp.status, body: null });
  return data;
}

/**
 * events.get — reconcile.js's ONLY provider call. Never creates, updates, or
 * deletes anything; a pure read used to resolve an outcome_unknown/stuck-
 * attempted operation against provider-side truth.
 */
async function getEvent({ accessToken, calendarId, eventId, fetchImpl = fetch }) {
  const url = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
  let resp;
  try {
    // Audit fix 4: same bounded-timeout reasoning as insertEvent above — a
    // hung reconcile read must resolve to the existing provider_unreachable
    // outcome rather than hanging the reconcile sweep indefinitely.
    resp = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(30000) });
  } catch {
    throw new CalendarProviderError('provider_unreachable');
  }
  if (resp.status === 404) throw new CalendarProviderError('not_found');
  if (!resp.ok) throw new CalendarProviderError('provider_unreachable', { status: resp.status });
  const data = await resp.json().catch(() => null);
  if (!data) throw new CalendarProviderError('provider_unreachable');
  return data;
}

// --- normalization -------------------------------------------------------------

/** Audit fix 1: hangoutLink/conferenceData.entryPoints[].uri are attacker-
 * controlled text (an invited guest's own calendar app can set either field
 * on an event that later syncs into this org). Only an http(s) URL may ever
 * reach occurrence.joinUrl — CalendarTab.jsx renders it straight into an
 * <a href>, so a javascript:/data:/vbscript: scheme sanitized away here is
 * the one choke point that matters; anything else collapses to null rather
 * than being carried through as an omission (a missing join link is not
 * worth a user-facing note). */
function sanitizeJoinUrl(url) {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return null;
}

const VISIBILITY_MAP = { default: 'default', public: 'default', private: 'private', confidential: 'busy-only' };
const OCCURRENCE_STATUSES = ['confirmed', 'tentative', 'cancelled'];
const RESPONSE_STATUSES = ['accepted', 'declined', 'needsAction', 'tentative'];
// L2-C4: contracts.js's occurrenceFields caps an occurrence's attendees at 50.
const MAX_OCCURRENCE_ATTENDEES = 50;

function pad2(n) { return String(n).padStart(2, '0'); }

/** HH:mm of `ts` rendered in `tz` (falls back to a UTC render if `tz` is not
 * a recognised IANA zone — Intl throws on a bad zone name). */
function formatHHmm(ts, tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).formatToParts(new Date(ts));
    const h = parts.find((p) => p.type === 'hour')?.value ?? '00';
    const m = parts.find((p) => p.type === 'minute')?.value ?? '00';
    return `${h}:${m}`;
  } catch {
    const d = new Date(ts);
    return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  }
}

function weekdayOf(ts, tz) {
  try {
    return new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: tz }).format(new Date(ts));
  } catch {
    return new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'UTC' }).format(new Date(ts));
  }
}

/** Weekday of a literal 'YYYY-MM-DD' date string, computed without any
 * timezone conversion (the date is already a wall-clock date, not an
 * instant) — parsed as UTC midnight purely to get a weekday name out of it. */
function weekdayOfDateOnly(dateOnly) {
  const [y, m, d] = dateOnly.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
}

/**
 * Map one raw Google Calendar event resource to a CalendarAgendaV1
 * occurrence (minus layerId, which the sync worker assigns — it is a
 * sync-time fact about which connection/layer this came from, not a fact
 * about the raw event itself).
 *
 * @returns {{ok: true, occurrence: object} | {ok: false, omission: {kind, detail}}}
 */
function normalizeEvent(raw, { connectionTz = 'UTC' } = {}) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, omission: { kind: 'malformed_event', detail: 'event resource was not an object' } };
  }
  if (!raw.id) {
    return { ok: false, omission: { kind: 'missing_id', detail: 'event had no id' } };
  }
  const start = raw.start || {};
  const end = raw.end || {};
  const allDay = Boolean(start.date) && !start.dateTime;

  let startTs;
  let endTs;
  let dateOnlyStart = null;
  let timezone;

  if (allDay) {
    dateOnlyStart = start.date;
    startTs = Date.parse(`${start.date}T00:00:00.000Z`);
    endTs = Date.parse(`${(end.date || start.date)}T00:00:00.000Z`);
    timezone = connectionTz;
  } else {
    if (!start.dateTime) {
      return { ok: false, omission: { kind: 'unparseable_time', detail: `event ${raw.id} had neither start.date nor start.dateTime` } };
    }
    startTs = Date.parse(start.dateTime);
    endTs = Date.parse(end.dateTime || start.dateTime);
    timezone = start.timeZone || connectionTz;
  }

  if (!Number.isFinite(startTs) || !Number.isFinite(endTs)) {
    return { ok: false, omission: { kind: 'unparseable_time', detail: `event ${raw.id} start/end did not parse` } };
  }

  const status = OCCURRENCE_STATUSES.includes(raw.status) ? raw.status : null;
  if (!status) {
    return { ok: false, omission: { kind: 'unrecognised_status', detail: `event ${raw.id} had status "${raw.status}"` } };
  }

  const originalStart = raw.originalStartTime || {};
  const occurrenceKeyMoment = originalStart.dateTime || originalStart.date || start.dateTime || start.date;
  const seriesId = raw.recurringEventId || null;
  const occurrenceKey = `${seriesId || raw.id}:${occurrenceKeyMoment}`;

  const selfAttendee = Array.isArray(raw.attendees) ? raw.attendees.find((a) => a && a.self) : null;
  const rawResponseStatus = selfAttendee ? selfAttendee.responseStatus : null;
  const responseStatus = RESPONSE_STATUSES.includes(rawResponseStatus) ? rawResponseStatus : null;

  // L2-C4: carry the full attendee list (email + each attendee's OWN
  // responseStatus) onto the occurrence, not just the authenticated user's
  // own status above. OPTIONAL field — raw.attendees missing entirely
  // leaves occurrence.attendees absent ("unknown"); an array (even empty)
  // is carried as a known attendee list. Entries with no usable email are
  // dropped rather than rejecting the whole event. Capped at
  // MAX_OCCURRENCE_ATTENDEES; truncation is reported as an omission note
  // alongside the (still-included) occurrence, never by dropping the event.
  let attendees;
  let attendeesOmission = null;
  if (Array.isArray(raw.attendees)) {
    const mapped = raw.attendees
      .filter((a) => a && typeof a.email === 'string' && a.email.trim().length > 0)
      .map((a) => ({
        email: a.email.trim(),
        responseStatus: RESPONSE_STATUSES.includes(a.responseStatus) ? a.responseStatus : null,
      }));
    if (mapped.length > MAX_OCCURRENCE_ATTENDEES) {
      attendeesOmission = {
        kind: 'attendees_truncated',
        detail: `event ${raw.id} had ${mapped.length} attendees, truncated to ${MAX_OCCURRENCE_ATTENDEES}`,
      };
      attendees = mapped.slice(0, MAX_OCCURRENCE_ATTENDEES);
    } else {
      attendees = mapped;
    }
  }

  const busy = raw.transparency !== 'transparent';
  const visibility = VISIBILITY_MAP[raw.visibility] || 'default';

  const rawJoinUrl = raw.hangoutLink
    || (Array.isArray(raw.conferenceData?.entryPoints)
      ? (raw.conferenceData.entryPoints.find((e) => e && e.entryPointType === 'video')?.uri || null)
      : null);
  const joinUrl = sanitizeJoinUrl(rawJoinUrl);

  // Audit fix 2: title/location are attacker-controlled text (any invited
  // guest's calendar app can set either on an event that syncs into this
  // org) — strip C0/C1 control chars before they reach a stored occurrence
  // or the spokenForm template built from title below.
  const title = sanitizeText(typeof raw.summary === 'string' ? raw.summary : '');
  const location = sanitizeText(typeof raw.location === 'string' ? raw.location : null);
  const weekday = allDay ? weekdayOfDateOnly(dateOnlyStart) : weekdayOf(startTs, timezone);
  const spokenForm = allDay
    ? `${title}, all day ${weekday}`
    : `${title}, ${formatHHmm(startTs, timezone)}-${formatHHmm(endTs, timezone)} ${weekday}`;

  const sourceVersion = raw.etag || raw.updated || String(startTs);

  const occurrence = {
    occurrenceKey,
    seriesId,
    providerEventId: raw.id,
    sourceVersion,
    title,
    startTs,
    endTs,
    allDay,
    dateOnlyStart,
    timezone,
    status,
    responseStatus,
    busy,
    visibility,
    location,
    joinUrl: joinUrl || null,
    spokenForm,
  };
  if (attendees !== undefined) occurrence.attendees = attendees;

  return attendeesOmission ? { ok: true, occurrence, attendeesOmission } : { ok: true, occurrence };
}

module.exports = {
  CalendarProviderError,
  AUTH_BASE_URL,
  resolveGoogleCredential,
  resolveGoogleOAuthClient,
  exchangeAuthorizationCode,
  getAccessToken,
  listEventsWindow,
  listCalendars,
  insertEvent,
  getEvent,
  normalizeEvent,
  _resetTokenCache,
};
